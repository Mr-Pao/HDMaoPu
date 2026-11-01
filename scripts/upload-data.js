'use strict';

/**
 * 把仓库里的 data/*.json 上传到 COS 桶根目录的 data/ 前缀下。
 *
 * 小程序端 utils/datasource.js 直接 GET {baseUrl}/data/<collection>.json，
 * 所以对象 key 就是 data/<文件名>，不做任何改写。
 *
 * 用法：
 *   COS_SECRET_ID=xx COS_SECRET_KEY=xx COS_BUCKET=xx COS_REGION=xx node scripts/upload-data.js
 *   加 DRY_RUN=1 只做校验和打印，不发起网络请求。
 */

const fs = require('fs');
const path = require('path');

const {
  COS_SECRET_ID,
  COS_SECRET_KEY,
  COS_BUCKET,
  COS_REGION,
  DRY_RUN,
} = process.env;

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const KEY_PREFIX = 'data/';
const DRY = DRY_RUN === '1' || DRY_RUN === 'true';

// 5 分钟：改完 data 之后能比较快地在客户端生效
const CACHE_CONTROL = 'max-age=300';

// 桶是私有读，且桶策略（putBucketPolicy）对匿名访问不生效（实测过，已撤销）。
// 小程序是匿名 GET，只能靠对象级 ACL：不传 ACL 就是 403，整站数据拉不到。
const OBJECT_ACL = 'public-read';

// 禁止公网上传的文件：上传对象全部是 public-read，这两份文件
// 含用户 openid（inbox_log）和未审核内容（review_queue），不能公开。
const UPLOAD_DENYLIST = new Set(['inbox_log.json', 'review_queue.json']);

function assertEnv() {
  const missing = [];
  if (!COS_SECRET_ID) missing.push('COS_SECRET_ID');
  if (!COS_SECRET_KEY) missing.push('COS_SECRET_KEY');
  if (!COS_BUCKET) missing.push('COS_BUCKET');
  if (!COS_REGION) missing.push('COS_REGION');
  if (missing.length) {
    console.error('缺少环境变量：' + missing.join(', '));
    process.exit(1);
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// 扫描 data/*.json，逐个 JSON.parse 校验；任何一个坏文件都不上传
function collectFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error('找不到数据目录：' + DATA_DIR);
    process.exit(1);
  }

  const all = fs.readdirSync(DATA_DIR)
    .filter(name => name.endsWith('.json'))
    .sort();

  const blocked = all.filter(name => UPLOAD_DENYLIST.has(name));
  if (blocked.length) {
    console.log('跳过禁止公开的文件：' + blocked.join(', '));
  }
  const names = all.filter(name => !UPLOAD_DENYLIST.has(name));

  if (!names.length) {
    console.error('data/ 下没有任何 json 文件');
    process.exit(1);
  }

  const files = [];
  const errors = [];

  for (const name of names) {
    const file = path.join(DATA_DIR, name);
    const buf = fs.readFileSync(file);
    let parsed;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      errors.push(`${name}: JSON 解析失败 —— ${err.message}`);
      continue;
    }
    if (!parsed || !Array.isArray(parsed.items)) {
      errors.push(`${name}: 顶层结构不是 { version, items: [] }`);
      continue;
    }
    const lackId = parsed.items.filter(item => !item || item._id === undefined || item._id === null);
    if (lackId.length) {
      errors.push(`${name}: ${lackId.length} 条记录缺少 _id`);
      continue;
    }
    files.push({
      name,
      key: KEY_PREFIX + name,
      body: buf,
      size: buf.length,
      count: parsed.items.length,
      version: parsed.version || '(无 version)',
    });
  }

  if (errors.length) {
    console.error('数据校验未通过，已中止上传：');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }

  return files;
}

function createClient() {
  if (DRY) return null;
  // 只有真正上传时才 require，DRY_RUN 不需要装依赖
  const COS = require('cos-nodejs-sdk-v5');
  return new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
}

function putObject(cos, file) {
  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: file.key,
        Body: file.body,
        ContentType: 'application/json; charset=utf-8',
        CacheControl: CACHE_CONTROL,
        // 桶是私有读，且桶策略对匿名访问不生效（实测），
        // 所以必须逐个对象打 public-read，否则小程序拉 JSON 全是 403。
        ACL: OBJECT_ACL,
      },
      (err, data) => (err ? reject(err) : resolve(data))
    );
  });
}

// 上传后再读一次对象 ACL，确认 AllUsers 能读。
//
// 为什么必须验：COS 每次 PUT 都用请求里的 ACL 整体替换旧对象的 ACL，不继承。
// 只要有人绕过本脚本（手工 putObject、别的一次性脚本）覆盖了 data/*.json 又没带
// public-read，那份 JSON 就悄悄变成私有——小程序拿到 403，页面直接空掉，而且
// 前端只会报一行 403 看不出来龙去脉。2026-11-01 就发生过一次（data/news.json）。
function verifyAcl(cos, key) {
  return new Promise((resolve) => {
    cos.getObjectAcl({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (err, data) => {
      if (err) return resolve({ ok: false, reason: err.message || String(err) });
      const grants = (data && data.Grants) || [];
      const publicRead = grants.some(g => {
        const grantee = g.Grantee || {};
        const id = String(grantee.ID || grantee.URI || '');
        return (id.includes('AllUsers') || id.includes('global/AllUsers')) && String(g.Permission) === 'READ';
      });
      resolve({ ok: publicRead, reason: publicRead ? 'AllUsers READ' : '缺少 AllUsers READ' });
    });
  });
}

async function main() {
  const files = collectFiles();

  console.log(`共 ${files.length} 个文件，前缀 ${KEY_PREFIX}，ACL ${OBJECT_ACL}，缓存 ${CACHE_CONTROL}`);
  console.log('----------------------------------------');
  for (const f of files) {
    console.log(
      `${f.key}  ${formatSize(f.size)}  ${f.count} 条  version=${f.version}`
    );
  }
  console.log('----------------------------------------');

  if (DRY) {
    console.log('DRY_RUN=1，只校验不上传。全部文件通过 JSON 校验。');
    return;
  }

  assertEnv();
  const cos = createClient();

  let ok = 0;
  const failed = [];
  const aclFailed = [];

  for (const f of files) {
    try {
      const res = await putObject(cos, f);
      const etag = res && res.ETag ? String(res.ETag).replace(/"/g, '') : '-';
      console.log(`✔ ${f.key}  ${formatSize(f.size)}  上传成功（etag ${etag}）`);
      ok++;

      const acl = await verifyAcl(cos, f.key);
      if (!acl.ok) {
        console.error(`  ✘ ACL 校验未通过（${acl.reason}）：${f.key} 匿名 GET 会 403`);
        aclFailed.push(f.key);
      }
    } catch (err) {
      console.error(`✘ ${f.key}  上传失败：${err && err.message ? err.message : err}`);
      failed.push(f.key);
    }
  }

  console.log('----------------------------------------');
  console.log(`完成：成功 ${ok} 个，失败 ${failed.length} 个，ACL 异常 ${aclFailed.length} 个`);
  if (aclFailed.length) {
    console.error('ACL 异常列表（这些对象小程序读不到，页面会空）：' + aclFailed.join(', '));
  }
  if (failed.length) {
    console.error('失败列表：' + failed.join(', '));
  }
  if (failed.length || aclFailed.length) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('上传脚本异常：', err);
  process.exit(1);
});
