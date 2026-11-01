'use strict';

/**
 * 猫↔照片归属重建 · 第二步：读取用户在网页导出的 relink-result.json，
 * 把 photos/relink/*.jpg 复制到对应猫的 photos/<cat_id>/<4位序号>.jpg（public-read），
 * 追加 data/photo.json 记录、累加 data/cat.json 的 photo_count_total，
 * 再把两份 JSON 写回 data/ 并上传 COS（参照 upload-data.js 的 putObject）。
 *
 * 用法：
 *   COS_SECRET_ID=xx COS_SECRET_KEY=xx node scripts/relink-apply.js
 *   加 DRY_RUN=1 只打印计划，不实际改动。
 */

const fs = require('fs');
const path = require('path');

const {
  COS_SECRET_ID: ENV_SECRET_ID,
  COS_SECRET_KEY: ENV_SECRET_KEY,
  COS_BUCKET: ENV_BUCKET,
  COS_REGION: ENV_REGION,
  DRY_RUN,
} = process.env;

const DRY = DRY_RUN === '1' || DRY_RUN === 'true';

const BUCKET_DEFAULT = 'maopu-1258113633';
const REGION_DEFAULT = 'ap-guangzhou';

function parseDotEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  const vars = {};
  if (!fs.existsSync(envPath)) return vars;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) vars[key] = value;
  }
  return vars;
}

function readSecret(name) {
  if (process.env[name]) return process.env[name];
  return parseDotEnv()[name] || '';
}

const SECRET_ID = ENV_SECRET_ID || readSecret('COS_SECRET_ID');
const SECRET_KEY = ENV_SECRET_KEY || readSecret('COS_SECRET_KEY');
const BUCKET = ENV_BUCKET || readSecret('COS_BUCKET') || BUCKET_DEFAULT;
const REGION = ENV_REGION || readSecret('COS_REGION') || REGION_DEFAULT;

const PUBLIC_DOMAIN = `https://${BUCKET}.cos.${REGION}.myqcloud.com`;
const RELINK_PREFIX = 'photos/relink/';
const OBJECT_ACL = 'public-read';
const CACHE_CONTROL = 'max-age=300';
const DATA_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const RESULT_PATH = path.resolve(__dirname, '..', 'relink-result.json');
const PHOTO_PATH = path.resolve(__dirname, '..', 'data', 'photo.json');
const CAT_PATH = path.resolve(__dirname, '..', 'data', 'cat.json');

function assertEnv() {
  const missing = [];
  if (!SECRET_ID) missing.push('COS_SECRET_ID');
  if (!SECRET_KEY) missing.push('COS_SECRET_KEY');
  if (missing.length) {
    console.error('缺少密钥：' + missing.join(', ') + '（可通过环境变量或项目根 .env 提供）');
    process.exit(1);
  }
}

function createClient() {
  if (DRY) return null;
  const COS = require('cos-nodejs-sdk-v5');
  return new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY });
}

function encodeCopySource(key) {
  const encoded = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${BUCKET}.cos.${REGION}.myqcloud.com/${encoded}`;
}

function encodeCopySourceFull(key) {
  return `${BUCKET}.cos.${REGION}.myqcloud.com/${encodeURIComponent(key)}`;
}

// 列出某前缀下所有 key（分页）
function listKeys(cos, prefix) {
  return new Promise((resolve, reject) => {
    const all = [];
    let marker = '';
    const next = () => {
      const params = { Bucket: BUCKET, Region: REGION, Prefix: prefix, MaxKeys: 1000 };
      if (marker) params.Marker = marker;
      cos.getBucket(params, (err, data) => {
        if (err) return reject(err);
        const contents = data && Array.isArray(data.Contents) ? data.Contents : [];
        for (const obj of contents) if (obj && obj.Key) all.push(obj.Key);
        const truncated = data && (data.IsTruncated === true || data.IsTruncated === 'true');
        if (truncated && contents.length) {
          marker = data.NextMarker || contents[contents.length - 1].Key;
          next();
        } else {
          resolve(all);
        }
      });
    };
    next();
  });
}

function putObjectCopy(cos, sourceKey, destKey, contentType) {
  return new Promise((resolve, reject) => {
    const doCopy = (copySource, cb) => {
      cos.putObjectCopy(
        {
          Bucket: BUCKET,
          Region: REGION,
          Key: destKey,
          CopySource: copySource,
          ACL: OBJECT_ACL,
          ContentType: contentType,
        },
        cb
      );
    };
    doCopy(encodeCopySource(sourceKey), (err, data) => {
      if (!err) return resolve(data);
      const msg = `${(err && (err.message || err.code)) || ''}`;
      if (/NoSuchKey|404/i.test(msg)) {
        doCopy(encodeCopySourceFull(sourceKey), (err2, data2) =>
          err2 ? reject(err2) : resolve(data2)
        );
      } else {
        reject(err);
      }
    });
  });
}

function putJsonObject(cos, key, body) {
  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: BUCKET,
        Region: REGION,
        Key: key,
        Body: body,
        ContentType: DATA_JSON_CONTENT_TYPE,
        CacheControl: CACHE_CONTROL,
        ACL: OBJECT_ACL,
      },
      (err, data) => (err ? reject(err) : resolve(data))
    );
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function contentTypeOf(key) {
  const m = key.match(/\.([^.]+)$/);
  const ext = m ? m[1].toLowerCase() : 'jpg';
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

// 根据某猫前缀下的现有对象，算出下一个可用序号（cover.jpg 之外从 0001 递增）
function nextSeqForCat(existingKeys, catId) {
  const re = new RegExp('^photos/' + catId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/(\\d{4})\\.(jpe?g|png|webp)$', 'i');
  let max = 0;
  for (const k of existingKeys) {
    const m = k.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

async function main() {
  // 1. 读 relink-result.json
  if (!fs.existsSync(RESULT_PATH)) {
    console.error('找不到 relink-result.json（' + RESULT_PATH + '）。');
    console.error('请先在 relink-workbench.html 里完成认猫并「导出结果」生成该文件，再运行本脚本。');
    process.exit(1);
  }
  const result = readJson(RESULT_PATH);
  const resultPhotos = Array.isArray(result && result.photos) ? result.photos : [];
  const assigns = resultPhotos.filter((p) => p && p.action === 'assign' && p.cat_id && p.src);
  if (!assigns.length) {
    console.log('relink-result.json 里没有 action=assign 的照片，无需处理。');
    return;
  }

  // 2. 读 photo.json / cat.json
  const photoData = readJson(PHOTO_PATH);
  const catData = readJson(CAT_PATH);
  const photoItems = Array.isArray(photoData.items) ? photoData.items : [];
  const catItems = Array.isArray(catData.items) ? catData.items : [];

  const catById = {};
  for (const c of catItems) if (c && c._id) catById[c._id] = c;

  // 每只猫现有 photo.json 记录里的 marker_type（取第一条命中）
  const markerTypeByCat = {};
  for (const p of photoItems) {
    if (p && p.cat_id && !(p.cat_id in markerTypeByCat)) {
      markerTypeByCat[p.cat_id] = p.marker_type;
    }
  }

  // 全局 _id 递增：基于现有 relink-photo-* 最大值
  let idSeq = 0;
  for (const p of photoItems) {
    const m = p && p._id && String(p._id).match(/^relink-photo-(\d+)$/);
    if (m) idSeq = Math.max(idSeq, parseInt(m[1], 10));
  }

  const now = new Date();
  const nowISO = now.toISOString();
  const nowDate = nowISO.slice(0, 10);

  // 校验每个 assign 的目标猫存在
  for (const a of assigns) {
    if (!catById[a.cat_id]) {
      console.error('cat_id ' + a.cat_id + ' 不在 data/cat.json 中，请检查 relink-result.json。');
      process.exit(1);
    }
  }

  // 3. 计算计划（非 DRY 时查 COS 现有对象数）
  console.log('共 ' + assigns.length + ' 张待归属照片：');
  const plans = [];
  const cos = DRY ? null : createClient();

  // 需要查询的猫集合
  const catSet = new Set(assigns.map((a) => a.cat_id));
  const existingByCat = {};
  for (const catId of catSet) {
    if (DRY) {
      existingByCat[catId] = []; // dry 下不做网络，按当前 photo.json 推断一个近似数
    } else {
      const keys = await listKeys(cos, 'photos/' + catId + '/');
      existingByCat[catId] = keys;
    }
  }

  // 每只猫的序号计数器：初始 = 现有最大序号，之后每分配一张就 +1，
  // 避免同一只猫认领多张时 seq 不变导致互相覆盖（分配后必须递增）
  const nextSeqByCat = {};
  for (const catId of catSet) {
    nextSeqByCat[catId] = DRY
      ? Math.max(photoItems.filter((p) => p.cat_id === catId).length, 1)
      : nextSeqForCat(existingByCat[catId], catId);
  }

  for (const a of assigns) {
    const cat = catById[a.cat_id];
    const srcKey = RELINK_PREFIX + a.src;
    const seq = nextSeqByCat[a.cat_id];
    nextSeqByCat[a.cat_id] = seq + 1;
    const destKey = 'photos/' + a.cat_id + '/' + pad4(seq) + '.jpg';
    const url = PUBLIC_DOMAIN + '/' + destKey;
    const marker = markerTypeByCat[a.cat_id];
    plans.push({
      src: a.src,
      cat_id: a.cat_id,
      catName: cat.name,
      srcKey,
      destKey,
      url,
      marker,
      lat: cat.latitude,
      lng: cat.longitude,
    });
    console.log('  ' + a.src + ' -> ' + cat.name + '（' + a.cat_id + '） ' + destKey);
  }

  console.log('----------------------------------------');

  if (DRY) {
    console.log('DRY_RUN=1：仅打印计划，不复制、不改 data/、不上传 COS。');
    console.log('计划新增 ' + plans.length + ' 条 photo 记录，累加 ' + catSet.size + ' 只猫的 photo_count_total。');
    return;
  }

  assertEnv();

  // 4. 复制
  let copied = 0;
  const copyFailed = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    try {
      await putObjectCopy(cos, p.srcKey, p.destKey, contentTypeOf(p.srcKey));
      console.log('(' + (i + 1) + '/' + plans.length + ') ✔ ' + p.src + ' -> ' + p.destKey);
      copied++;
    } catch (err) {
      console.error('(' + (i + 1) + '/' + plans.length + ') ✘ ' + p.src + ' 复制失败：' + (err && (err.message || err.code) ? (err.message || err.code) : err));
      copyFailed.push(p.src);
    }
  }

  if (copyFailed.length) {
    console.error('有 ' + copyFailed.length + ' 张复制失败，中止（未改动 data/ 与 COS JSON）。');
    process.exit(1);
  }

  // 5. 追加 photo.json 记录
  for (const p of plans) {
    idSeq += 1;
    photoItems.push({
      _id: 'relink-photo-' + idSeq,
      cat_id: p.cat_id,
      _openid: '',
      userInfo: {
        nickName: '猫友',
        avatarUrl: '/pages/public/images/info/default_avatar.png',
      },
      photo_id: p.url,
      photo_compressed: p.url,
      photo_watermark: p.url,
      verified: true,
      best: false,
      photographer: '猫友',
      shooting_date: nowDate,
      create_date: nowISO,
      mdate: nowISO,
      like_count: 0,
      latitude: p.lat,
      longitude: p.lng,
      marker_type: p.marker,
      deleted: 0,
    });
  }

  // 6. 累加 cat.json photo_count_total
  const claimedByCat = {};
  for (const p of plans) claimedByCat[p.cat_id] = (claimedByCat[p.cat_id] || 0) + 1;
  for (const cat of catItems) {
    if (claimedByCat[cat._id]) {
      const cur = typeof cat.photo_count_total === 'number' ? cat.photo_count_total : 0;
      cat.photo_count_total = cur + claimedByCat[cat._id];
    }
  }

  // 7. 写回 data/
  photoData.version = String(Date.now());
  catData.version = String(Date.now());
  const photoBody = JSON.stringify(photoData, null, 2) + '\n';
  const catBody = JSON.stringify(catData, null, 2) + '\n';
  fs.writeFileSync(PHOTO_PATH, photoBody, 'utf8');
  fs.writeFileSync(CAT_PATH, catBody, 'utf8');
  console.log('已写回 data/photo.json（' + photoItems.length + ' 条）与 data/cat.json（' + catItems.length + ' 只）');

  // 8. 上传 COS
  await putJsonObject(cos, 'data/photo.json', Buffer.from(photoBody, 'utf8'));
  console.log('✔ 上传 data/photo.json');
  await putJsonObject(cos, 'data/cat.json', Buffer.from(catBody, 'utf8'));
  console.log('✔ 上传 data/cat.json');

  console.log('----------------------------------------');
  console.log('完成：复制 ' + copied + ' 张，新增 photo 记录 ' + plans.length + ' 条，累加 ' + Object.keys(claimedByCat).length + ' 只猫的 photo_count_total，JSON 已上传 COS。');
}

main().catch((err) => {
  console.error('relink-apply 异常：', err);
  process.exit(1);
});
