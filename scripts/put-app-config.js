'use strict';
// 一次性脚本：把 COS 上的 data/app-config.json 换成「裸对象」格式（与 SpaceLaunch 一致），
// 方便以后直接在 COS 控制台手改。此后该对象不参与 data/ 自动上传（已在 upload-data.js 的 DENYLIST）。
const fs = require('fs');
const path = require('path');
const COS = require('cos-nodejs-sdk-v5');

function loadEnv() {
  const p = path.resolve(__dirname, '..', '.env');
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) {}
  return out;
}

const env = Object.assign({}, loadEnv(), process.env);
const BUCKET = env.COS_BUCKET;
const REGION = env.COS_REGION;
const KEY = 'data/app-config.json';
const body = JSON.stringify({ reviewVersions: [] }, null, 2) + '\n';

if (!env.COS_SECRET_ID || !env.COS_SECRET_KEY || !BUCKET || !REGION) {
  console.error('缺少 COS 凭证');
  process.exit(1);
}

const cos = new COS({ SecretId: env.COS_SECRET_ID, SecretKey: env.COS_SECRET_KEY });

cos.putObject(
  {
    Bucket: BUCKET,
    Region: REGION,
    Key: KEY,
    Body: body,
    ContentType: 'application/json; charset=utf-8',
    CacheControl: 'max-age=60',
    ACL: 'public-read',
  },
  (err, data) => {
    if (err) {
      console.error('上传失败：', err.message || err);
      process.exit(1);
    }
    console.log('上传成功', KEY, data && data.ETag);
  }
);
