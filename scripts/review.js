'use strict';

/**
 * 处理待审 Issue 里的审核评论，把 COS 的 pending/ 对象移动到 photos/ 或 rejected/。
 *
 * 流程：issue_comment 触发 → 校验评论者权限 → 解析 /ok 或 /no → 从 Issue body 里
 * 取出 <!-- photo-key: ... --> 标记的源对象 → PutObjectCopy + DeleteObject →
 * 回评结果（含 7 天预签名缩略图）→ 打标签并关闭 Issue。
 *
 * 设计要点：
 * 1. 不依赖 ISSUE_BODY 环境变量（多行内容放进 env 容易出问题），默认用 GitHub API
 *    拉取；ISSUE_BODY 存在时才作为兜底。
 * 2. cos-nodejs-sdk-v5 的 CopySource 必须写成
 *      <bucket>-<appid>.cos.<region>.myqcloud.com/<url 编码后的 key>
 *    SDK 内部用正则解析出 Bucket/Region/Key 并自动映射成 x-cos-copy-source 头，
 *    且只做 decodeURIComponent、不做编码，所以 key 必须由调用方逐段编码。
 * 3. 幂等：pending 原件已不存在时只回评并关单，不报错。
 *
 * 用法（Actions 里由 workflow 传环境变量）：
 *   ISSUE_NUMBER=12 COMMENT_BODY=/ok COMMENT_AUTHOR_ASSOCIATION=OWNER \
 *   GITHUB_TOKEN=xx GITHUB_REPOSITORY=owner/repo \
 *   COS_SECRET_ID=xx COS_SECRET_KEY=xx COS_BUCKET=xx COS_REGION=xx \
 *   node scripts/review.js
 */

const COS = require('cos-nodejs-sdk-v5');

const PENDING_PREFIX = 'pending/';
const APPROVED_PREFIX = 'photos/';
const REJECTED_PREFIX = 'rejected/';
const URL_TTL = 7 * 24 * 3600;
const API_ROOT = 'https://api.github.com';
const ALLOWED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const env = process.env;

// ---------------------------------------------------------------- COS 客户端

let cosClient = null;

// 延迟创建：本地跑纯函数单元测试时不碰凭证也不会初始化
function cos() {
  if (!cosClient) {
    cosClient = new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY });
  }
  return cosClient;
}

function bucketParams() {
  return { Bucket: env.COS_BUCKET, Region: env.COS_REGION };
}

function call(method, params) {
  return new Promise((resolve, reject) =>
    cos()[method](params, (err, data) => (err ? reject(err) : resolve(data)))
  );
}

// ---------------------------------------------------------------- 纯函数

/**
 * 解析评论命令。去掉首尾空白后以 /ok /approve 开头为通过，
 * /no /reject 开头为驳回，其余返回 null。
 * 用负向断言避免 /okay 这类单词被误判。
 */
function parseCommand(body) {
  const text = String(body || '').trim();
  if (!text) return null;
  if (/^\/(ok|approve)(?![a-z])/i.test(text)) return 'approve';
  if (/^\/(no|reject)(?![a-z])/i.test(text)) return 'reject';
  return null;
}

/** 从 Issue body 里取出机器可读的对象 key 标记。 */
function extractKey(body) {
  const m = String(body || '').match(/<!--\s*photo-key:\s*(.+?)\s*-->/);
  return m ? m[1].trim() : null;
}

/** 从 Issue body 里取出机器可读的猫 ID 标记（新 key 格式不含 cat_id，靠这个标记补齐）。 */
function extractCatId(body) {
  const m = String(body || '').match(/<!--\s*photo-cat-id:\s*(.+?)\s*-->/);
  return m ? m[1].trim() : null;
}

/** 从 Issue body 里取出 machine 可读的元信息标记，返回 {openid, photographer, shootingDate}。 */
function extractMeta(body) {
  const text = String(body || '');
  const pick = (name) => {
    const m = text.match(new RegExp(`<!--\\s*${name}:\\s*(.*?)\\s*-->`));
    return m ? m[1].trim() : '';
  };
  return {
    openid: pick('photo-openid'),
    photographer: pick('photo-photographer'),
    shootingDate: pick('photo-shooting-date'),
  };
}

function decode(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

/**
 * 解析 pending key，兼容两种格式：
 *   旧格式（aggregate.js 生成）：
 *     pending/<catId>/<uuid>~<YYYYMMDD>~<campus>~<userHash>~<catName>.<ext>
 *   新格式（客户端匿名直传）：
 *     pending/<openid>-<时间戳>.<ext>
 * 新格式的 key 不含 catId，catId 由 Issue body 里的 <!-- photo-cat-id --> 标记提供，
 * 所以这里对旧格式返回 catId，新格式返回 catId=null（由调用方补）。
 * 解析失败返回 null。
 */
function parseKey(key) {
  if (!key || !key.startsWith(PENDING_PREFIX)) return null;

  const rest = key.slice(PENDING_PREFIX.length);
  if (!rest) return null;

  // 新格式：pending/<openid>-<ts>.<ext>，无 catId 段（rest 里没有 /）
  if (rest.indexOf('/') <= 0) {
    const dot = rest.lastIndexOf('.');
    if (dot <= 0) return null;
    const ext = rest.slice(dot + 1).toLowerCase();
    if (!/^[a-z0-9]+$/.test(ext)) return null;
    const stem = rest.slice(0, dot);
    // 客户端 key 是 openid-时间戳，openid 形如 guest_xxxxxxxx 或 anon，
    // 必须至少形如 <something>-<digits> 才算合法，防脏 key
    if (!/^.+-\d+$/.test(stem)) return null;
    return {
      catId: null,
      filename: rest,
      ext,
      uuid: null,
      shootingDate: '',
      campus: '',
      userHash: '',
      catName: '',
    };
  }

  // 旧格式：pending/<catId>/<uuid>~<YYYYMMDD>~<campus>~<userHash>~<catName>.<ext>
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;

  const catId = rest.slice(0, slash);
  const filename = rest.slice(slash + 1);
  if (!catId || !filename) return null;

  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;

  const stem = filename.slice(0, dot);
  const ext = filename.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]+$/.test(ext)) return null;

  const parts = stem.split('~');
  if (parts.length < 5) return null;

  const uuid = parts[0];
  const shootingDate = parts[1];
  const campus = decode(parts[2]);
  const userHash = parts[3];
  const catName = decode(parts.slice(4).join('~'));

  if (!/^[0-9a-f]{32}$/i.test(uuid)) return null;
  if (!/^\d{8}$/.test(shootingDate)) return null;
  if (!userHash) return null;

  return { catId, filename, ext, uuid, shootingDate, campus, userHash, catName };
}

/** 目标 key，prefix 为 photos/ 或 rejected/，保留原文件名。 */
function buildTargetKey(info, prefix) {
  return `${prefix}${info.catId}/${info.filename}`;
}

/** 追加照片记录到 data/photo.json。字段对齐现有记录。 */
function appendPhotoRecord({ catId, openid, photographer, shootingDate, targetKey, ext }) {
  const fs = require('fs');
  const path = require('path');
  const photoFile = path.resolve(__dirname, '..', 'data', 'photo.json');
  let doc = { version: 'v0', items: [] };
  if (fs.existsSync(photoFile)) {
    doc = JSON.parse(fs.readFileSync(photoFile, 'utf8'));
    if (!doc || !Array.isArray(doc.items)) doc = { version: 'v0', items: [] };
  }
  const now = Date.now();
  const ts = now.toString(36) + Math.random().toString(36).slice(2, 8);
  const id = `photo-${catId}-${ts}`;
  // 域名从 COS 凭据推导，避免硬编码桶名/地域
  const baseUrl = `https://${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com`;
  const url = `${baseUrl}/${targetKey}`;
  const nowIso = new Date(now).toISOString();
  doc.items.unshift({
    _id: id,
    cat_id: catId,
    _openid: openid || '',
    userInfo: { nickName: '', avatarUrl: '' },
    photo_id: url,
    photo_compressed: url,
    photo_watermark: url,
    verified: true,
    best: false,
    photographer: photographer || '',
    shooting_date: shootingDate || '',
    create_date: nowIso,
    mdate: nowIso,
    like_count: 0,
    deleted: 0,
  });
  doc.version = 'v' + now;
  const tmpPath = photoFile + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, photoFile);
  console.log(`[data] 已追加照片记录 ${id} 到 data/photo.json`);
  return id;
}

function contentTypeFor(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * 拼 CopySource。key 里的 % 是对象名的真实字符（上传时已 encode 过），
 * 所以这里必须再编码一次，逐段处理以保留路径分隔符 /。
 */
function copySource(key) {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${env.COS_BUCKET}.cos.${env.COS_REGION}.myqcloud.com/${encoded}`;
}

// ---------------------------------------------------------------- COS 操作

async function headObject(key) {
  try {
    await call('headObject', { ...bucketParams(), Key: key });
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.code === 'NoSuchKey' || err.code === 'NotFound') return false;
    throw err;
  }
}

async function signedUrl(key) {
  return new Promise((resolve, reject) =>
    cos().getObjectUrl({ ...bucketParams(), Key: key, Sign: true, Expires: URL_TTL }, (err, data) =>
      err ? reject(err) : resolve(data.Url)
    )
  );
}

async function moveObject(fromKey, toKey, contentType) {
  const source = copySource(fromKey);

  if (!/^[^.]+-\d+$/.test(String(env.COS_BUCKET || ''))) {
    console.warn('[cos] 警告：COS_BUCKET 不是 "<name>-<appid>" 形式，CopySource 可能解析失败');
  }

  console.log(`[cos] 复制 ${fromKey} -> ${toKey}`);
  console.log(`[cos] CopySource = ${source}`);
  console.log(`[cos] ContentType = ${contentType}`);

  // 只有审核通过的照片（photos/ 前缀）才公开；驳回的留在 rejected/ 保持私有。
  // 桶是私有读，桶策略对匿名访问不生效（实测），所以必须逐对象打 ACL。
  const acl = toKey.startsWith('photos/') ? 'public-read' : 'private';
  console.log(`[cos] ACL = ${acl}`);

  await call('putObjectCopy', {
    ...bucketParams(),
    Key: toKey,
    CopySource: source,
    ContentType: contentType,
    MetadataDirective: 'Replaced',
    ACL: acl,
    Headers: {
      'Content-Type': contentType,
      'x-cos-metadata-directive': 'Replaced',
      'x-cos-acl': acl,
    },
  });
  console.log('[cos] 复制完成');

  await call('deleteObject', { ...bucketParams(), Key: fromKey });
  console.log('[cos] 已删除 pending 原件');
}

// ---------------------------------------------------------------- GitHub

async function gh(method, path, payload) {
  const res = await fetch(`${API_ROOT}/repos/${env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'maopu-review',
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} 失败 ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function comment(issueNumber, body) {
  await gh('POST', `/issues/${issueNumber}/comments`, { body });
  console.log(`[gh] 已评论 #${issueNumber}`);
}

async function addLabel(issueNumber, label) {
  try {
    await gh('POST', `/issues/${issueNumber}/labels`, { labels: [label] });
    console.log(`[gh] 已打标签 ${label}`);
  } catch (err) {
    // 标签不存在等情况不影响审核结果
    console.warn(`[gh] 打标签 ${label} 失败（忽略）：${err.message}`);
  }
}

async function closeIssue(issueNumber, reason) {
  await gh('PATCH', `/issues/${issueNumber}`, { state: 'closed', state_reason: reason });
  console.log(`[gh] 已关闭 #${issueNumber}（${reason}）`);
}

async function fetchIssueBody(issueNumber) {
  const issue = await gh('GET', `/issues/${issueNumber}`);
  return issue && issue.body ? issue.body : '';
}

// ---------------------------------------------------------------- 主流程

function assertEnv() {
  const required = [
    'ISSUE_NUMBER',
    'COMMENT_BODY',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'COS_SECRET_ID',
    'COS_SECRET_KEY',
    'COS_BUCKET',
    'COS_REGION',
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) {
    console.error('缺少环境变量：' + missing.join(', '));
    process.exit(1);
  }
}

async function main() {
  assertEnv();

  const issueNumber = Number(env.ISSUE_NUMBER);
  const association = String(env.COMMENT_AUTHOR_ASSOCIATION || '').toUpperCase();

  console.log(`[start] issue #${issueNumber}`);
  console.log(`[start] 评论者关联：${association || 'NONE'}`);

  const command = parseCommand(env.COMMENT_BODY);
  if (!command) {
    console.log('[skip] 不是审核命令，直接退出');
    return;
  }
  console.log(`[cmd] 判定为 ${command}`);

  // 权限校验：只有仓库成员才能改状态
  if (!ALLOWED_ASSOCIATIONS.includes(association)) {
    console.log(`[deny] ${association} 无审核权限`);
    await comment(
      issueNumber,
      [
        '⚠️ 抱歉，当前账号没有审核权限。',
        '',
        `检测到的权限等级是 \`${association || 'NONE'}\`，只有仓库的 OWNER / MEMBER / COLLABORATOR 才能执行审核。`,
        '',
        '如需审核，请联系维护者。',
      ].join('\n')
    );
    return;
  }

  // 取 Issue body：优先环境变量，其次 API
  let body = String(env.ISSUE_BODY || '').trim();
  if (body) {
    console.log('[issue] 使用环境变量里的 ISSUE_BODY');
  } else {
    console.log('[issue] 通过 API 拉取 Issue body');
    body = await fetchIssueBody(issueNumber);
  }

  const key = extractKey(body);
  if (!key) {
    console.error('[fail] Issue body 里找不到 photo-key 标记');
    await comment(
      issueNumber,
      '⚠️ 处理失败：在 Issue 正文里找不到 `<!-- photo-key: ... -->` 标记，无法定位对象。请手动处理。'
    );
    process.exit(1);
  }
  console.log(`[issue] 源对象：${key}`);

  const info = parseKey(key);
  if (!info) {
    console.error('[fail] 对象 key 不符合约定格式');
    await comment(
      issueNumber,
      [
        '⚠️ 处理失败：对象路径不符合约定格式，无法解析。',
        '',
        '```',
        key,
        '```',
        '',
        '期望格式：`pending/<catId>/<uuid>~<YYYYMMDD>~<校区>~<用户哈希>~<猫名>.<ext>` 或 `pending/<openid>-<时间戳>.<ext>`',
      ].join('\n')
    );
    process.exit(1);
  }

  const approved = command === 'approve';
  const targetPrefix = approved ? APPROVED_PREFIX : REJECTED_PREFIX;

  // 新 key 格式不含 catId，从 Issue body 的 <!-- photo-cat-id --> 标记补齐
  const meta = extractMeta(body);
  if (!info.catId) {
    const catId = extractCatId(body);
    if (!catId) {
      console.error('[fail] 新格式 key 缺少 photo-cat-id 标记，无法确定归属猫');
      await comment(
        issueNumber,
        '⚠️ 处理失败：对象路径不含猫 ID，且 Issue 正文里缺少 `<!-- photo-cat-id: ... -->` 标记。请手动处理。'
      );
      process.exit(1);
    }
    info.catId = catId;
    if (!info.shootingDate && meta.shootingDate) info.shootingDate = meta.shootingDate;
  }

  const targetKey = buildTargetKey(info, targetPrefix);
  console.log(
    `[info] catId=${info.catId} uuid=${info.uuid || '-'} date=${info.shootingDate || '-'} ` +
      `campus=${info.campus || '-'} catName=${info.catName || '-'} ext=${info.ext}`
  );

  // 幂等：原件不在了说明已经处理过
  const exists = await headObject(key);
  if (!exists) {
    console.log('[skip] pending 原件不存在，可能已处理过');
    await comment(
      issueNumber,
      [
        'ℹ️ 对象已不存在，可能已经处理过了，本次没有做任何修改。',
        '',
        `原路径：\`${key}\``,
      ].join('\n')
    );
    await closeIssue(issueNumber, 'completed');
    return;
  }

  const contentType = contentTypeFor(info.ext);
  await moveObject(key, targetKey, contentType);

  // 审核通过：把照片记录追加进 data/photo.json（由 review.yml 的 commit step 提交回 cos 分支）
  if (approved) {
    appendPhotoRecord({
      catId: info.catId,
      openid: meta.openid,
      photographer: meta.photographer,
      shootingDate: info.shootingDate || meta.shootingDate,
      targetKey,
      ext: info.ext,
    });
  }

  const url = await signedUrl(targetKey);
  console.log('[gh] 回评结果');

  if (approved) {
    await comment(
      issueNumber,
      [
        `✅ 已通过，对象已移动到 \`${targetKey}\``,
        '',
        `<img src="${url}" height="420" alt="已通过照片" />`,
        '',
        `预览链接 7 天内有效。猫名：${info.catName || '未填写'}，校区：${info.campus || '未填写'}。`,
      ].join('\n')
    );
    await addLabel(issueNumber, 'approved');
    await closeIssue(issueNumber, 'completed');
  } else {
    await comment(
      issueNumber,
      [
        `🚫 已驳回，对象已移动到 \`${targetKey}\``,
        '',
        `<img src="${url}" height="420" alt="已驳回照片" />`,
        '',
        '如需重新提交，请在小程序里重新上传。',
      ].join('\n')
    );
    await addLabel(issueNumber, 'rejected');
    await closeIssue(issueNumber, 'not_planned');
  }

  console.log('[done] 审核完成');
}

module.exports = {
  parseCommand,
  extractKey,
  extractCatId,
  extractMeta,
  parseKey,
  buildTargetKey,
  contentTypeFor,
  copySource,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
