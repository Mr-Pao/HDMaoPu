'use strict';

/**
 * 扫描 COS 的 pending/ 目录，把新照片变成待审 Issue。
 *
 * 设计要点：照片的业务字段（猫、校区、拍摄日期、上传者）全部编码在对象 key 里，
 * 不依赖 x-cos-meta-* 自定义头 —— 因为 POST Object 的表单字段必须在 policy 里声明，
 * 而 policy 由签名方生成，动态元数据字段很难覆盖到。编码进 key 后 ListObjects
 * 一次就能拿全，Actions 侧不需要逐个 HeadObject。
 *
 * key 格式：pending/<catId>/<uuid>~<YYYYMMDD>~<校区>~<用户哈希>~<猫名>.<ext>
 *
 * 用法：
 *   COS_SECRET_ID=xx COS_SECRET_KEY=xx COS_BUCKET=xx COS_REGION=xx \
 *   GITHUB_TOKEN=xx GITHUB_REPOSITORY=owner/repo node scripts/aggregate.js
 *   加 DRY_RUN=1 只打印不建单。
 */

const COS = require('cos-nodejs-sdk-v5');

const {
  COS_SECRET_ID,
  COS_SECRET_KEY,
  COS_BUCKET,
  COS_REGION,
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  DRY_RUN,
} = process.env;

const PENDING_PREFIX = 'pending/';
const STATE_KEY = 'admin/processed.json';
const URL_TTL = 7 * 24 * 3600;
const MAX_ISSUES = Number(process.env.MAX_ISSUES || 10);
const DRY = DRY_RUN === '1' || DRY_RUN === 'true';

function assertEnv() {
  const missing = [];
  if (!COS_SECRET_ID) missing.push('COS_SECRET_ID');
  if (!COS_SECRET_KEY) missing.push('COS_SECRET_KEY');
  if (!COS_BUCKET) missing.push('COS_BUCKET');
  if (!COS_REGION) missing.push('COS_REGION');
  if (!DRY && !GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!DRY && !GITHUB_REPOSITORY) missing.push('GITHUB_REPOSITORY');
  if (missing.length) {
    console.error('缺少环境变量：' + missing.join(', '));
    process.exit(1);
  }
}

const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
const B = { Bucket: COS_BUCKET, Region: COS_REGION };

const call = (method, params) =>
  new Promise((resolve, reject) =>
    cos[method](params, (err, data) => (err ? reject(err) : resolve(data)))
  );

async function listKeys(prefix) {
  const keys = [];
  let Marker = '';
  do {
    const res = await call('getBucket', { ...B, Prefix: prefix, Marker, MaxKeys: 1000 });
    for (const item of res.Contents || []) {
      if (item.Key && item.Key !== prefix) keys.push(item.Key);
    }
    Marker = res.IsTruncated === 'true' ? res.NextMarker : '';
  } while (Marker);
  return keys;
}

async function readState() {
  try {
    const res = await call('getObject', { ...B, Key: STATE_KEY });
    const parsed = JSON.parse(res.Body.toString('utf8'));
    return { processed: Array.isArray(parsed.processed) ? parsed.processed : [] };
  } catch (err) {
    if (err.statusCode === 404 || err.code === 'NoSuchKey') return { processed: [] };
    throw err;
  }
}

async function writeState(state) {
  await call('putObject', {
    ...B,
    Key: STATE_KEY,
    Body: JSON.stringify(state, null, 2),
    ContentType: 'application/json',
  });
}

function signedUrl(key) {
  return new Promise((resolve, reject) =>
    cos.getObjectUrl({ ...B, Key: key, Sign: true, Expires: URL_TTL }, (err, data) =>
      err ? reject(err) : resolve(data.Url)
    )
  );
}

function decode(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value;
  }
}

function parseKey(key) {
  if (!key.startsWith(PENDING_PREFIX)) return null;
  const rest = key.slice(PENDING_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;

  const catId = rest.slice(0, slash);
  const filename = rest.slice(slash + 1);
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;

  const parts = stem.split('~');
  if (parts.length < 4) return null;

  const uuid = parts[0];
  const shootingDate = parts[1] || '';
  const campus = decode(parts[2]);
  const userHash = parts[3] || '';
  const catName = decode(parts.slice(4).join('~'));

  return { catId, uuid, shootingDate, campus, userHash, catName };
}

function formatDate(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 8) return raw || '未填写';
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function buildIssueBody({ key, url, info }) {
  return [
    `<img src="${url}" height="420" alt="待审照片" />`,
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    `| 猫咪 | ${info.catName || '未填写'} |`,
    `| 猫 ID | \`${info.catId}\` |`,
    `| 校区 | ${info.campus || '未填写'} |`,
    `| 拍摄日期 | ${formatDate(info.shootingDate)} |`,
    `| 上传者哈希 | \`${info.userHash || '-'}\` |`,
    `| 对象路径 | \`${key}\` |`,
    '',
    '---',
    '评论 `/ok` 通过，评论 `/no` 驳回。',
    '',
    `<!-- photo-key: ${key} -->`,
  ].join('\n');
}

async function createIssue({ key, url, info }) {
  const title = `[待审] ${info.uuid.slice(0, 8)} · ${info.catName || info.catId.slice(-6)}`;

  if (DRY) {
    console.log(`[dry] 建单：${title}`);
    return null;
  }

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'maopu-aggregate',
    },
    body: JSON.stringify({ title, body: buildIssueBody({ key, url, info }) }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`创建 Issue 失败 ${res.status}: ${text.slice(0, 300)}`);
  }

  const issue = await res.json();
  console.log(`已建单 #${issue.number}  ${title}`);
  return issue;
}

async function main() {
  assertEnv();

  const keys = await listKeys(PENDING_PREFIX);
  const state = await readState();
  const done = new Set(state.processed);
  const fresh = keys.filter((key) => !done.has(key) && parseKey(key));

  console.log(`pending 共 ${keys.length} 个，已建单 ${done.size} 个，待处理 ${fresh.length} 个`);

  const batch = fresh.slice(0, MAX_ISSUES);
  let created = 0;

  for (const key of batch) {
    const info = parseKey(key);
    try {
      const url = await signedUrl(key);
      const issue = await createIssue({ key, url, info });
      if (issue) created += 1;
      done.add(key);
    } catch (err) {
      console.error(`处理 ${key} 失败：${err.message}`);
    }
  }

  if (created > 0) {
    await writeState({ processed: [...done], updatedAt: new Date().toISOString() });
  }

  console.log(`本轮建单 ${created} 个`);
  if (fresh.length > MAX_ISSUES) {
    console.log(`剩余 ${fresh.length - MAX_ISSUES} 个留待下一轮`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
