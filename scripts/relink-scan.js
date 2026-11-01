'use strict';

/**
 * 猫↔照片归属重建 · 第一步：扫描 COS 桶 compressed/ 前缀里的真实猫照，
 * 用 putObjectCopy 复制到 photos/relink/<3位序号>.jpg（public-read），
 * 并生成 relink-workbench.html 供用户肉眼认猫、导出 relink-result.json。
 *
 * 用法：
 *   COS_SECRET_ID=xx COS_SECRET_KEY=xx node scripts/relink-scan.js
 *   加 DRY_RUN=1 跳过 list 和复制，改用现有 11 张 cover.jpg 生成演示 html。
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

// 手写解析项目根 .env（每行 KEY=value，忽略 # 注释和空行，不引入 dotenv）
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
const BUCKET = ENV_BUCKET || readSecret('COS_BUCKET') || 'maopu-1258113633';
const REGION = ENV_REGION || readSecret('COS_REGION') || 'ap-guangzhou';

const SOURCE_PREFIX = 'compressed/';
const RELINK_PREFIX = 'photos/relink/';
const PUBLIC_DOMAIN = `https://${BUCKET}.cos.${REGION}.myqcloud.com`;
const OBJECT_ACL = 'public-read';
const IMG_EXT_RE = /\.(jpe?g|png|webp)$/i;

function extOf(key) {
  const m = key.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function contentTypeOf(ext) {
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

// CopySource 标准格式：<bucket>.cos.<region>.myqcloud.com/<按 / 分段 encodeURIComponent 的 key>
function encodeCopySource(key) {
  const encoded = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
  return `${BUCKET}.cos.${REGION}.myqcloud.com/${encoded}`;
}

// 回退：整个 key（含 /）做 encodeURIComponent（/ 变 %2F）
function encodeCopySourceFull(key) {
  return `${BUCKET}.cos.${REGION}.myqcloud.com/${encodeURIComponent(key)}`;
}

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

function listAllKeys(cos) {
  return new Promise((resolve, reject) => {
    const all = [];
    let marker = '';
    const next = () => {
      const params = {
        Bucket: BUCKET,
        Region: REGION,
        Prefix: SOURCE_PREFIX,
        MaxKeys: 1000,
      };
      if (marker) params.Marker = marker;
      cos.getBucket(params, (err, data) => {
        if (err) return reject(err);
        const contents = data && Array.isArray(data.Contents) ? data.Contents : [];
        for (const obj of contents) {
          if (obj && obj.Key) all.push(obj.Key);
        }
        const truncated =
          data &&
          (data.IsTruncated === true || data.IsTruncated === 'true');
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
        // 按 / 分段编码报 NoSuchKey 时，回退整个 key encodeURIComponent
        doCopy(encodeCopySourceFull(sourceKey), (err2, data2) =>
          err2 ? reject(err2) : resolve(data2)
        );
      } else {
        reject(err);
      }
    });
  });
}

// 读取 data/cat.json 里的猫（_id → name）
function readCats() {
  const catPath = path.resolve(__dirname, '..', 'data', 'cat.json');
  if (!fs.existsSync(catPath)) {
    console.error('找不到 data/cat.json：' + catPath);
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(catPath, 'utf8'));
  const items = Array.isArray(parsed && parsed.items) ? parsed.items : [];
  return items
    .filter((c) => c && c._id && c.name)
    .map((c) => ({ id: c._id, name: c.name }));
}

// 生成自包含的 relink-workbench.html
function buildWorkbenchHtml(cats, photos) {
  const CATS_JSON = JSON.stringify(cats);
  const PHOTOS_JSON = JSON.stringify(photos);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>火大猫谱 · 猫↔照片归属重建</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #ffffff; color: #1F2421; }
  header { position: sticky; top: 0; background: #ffffff; padding: 16px 20px 14px; border-bottom: 1px solid #ECEFEC; z-index: 10; }
  h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; }
  .progress { height: 8px; background: #ECEFEC; border-radius: 4px; overflow: hidden; }
  .progress-fill { height: 100%; background: #0C5F03; width: 0; transition: width .2s ease; }
  .progress-text { font-size: 13px; color: #55605A; margin-top: 6px; }
  .legend { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .legend span { font-size: 12px; padding: 3px 10px; border: 1px solid #ECEFEC; border-radius: 999px; color: #55605A; background: #F5F7F5; }
  .toolbar { margin-top: 12px; display: flex; gap: 10px; }
  .toolbar button { font-size: 13px; padding: 7px 14px; border-radius: 8px; border: 1px solid #ECEFEC; background: #ffffff; color: #1F2421; cursor: pointer; }
  .toolbar button.primary { background: #0C5F03; color: #ffffff; border-color: #0C5F03; }
  .toolbar button.danger { color: #b00020; }
  .masonry { columns: 220px; column-gap: 12px; padding: 16px 20px 40px; }
  .card { break-inside: avoid; margin-bottom: 12px; position: relative; border: 1px solid #ECEFEC; border-radius: 10px; overflow: hidden; cursor: pointer; background: #F5F7F5; transition: box-shadow .15s ease; }
  .card:hover { box-shadow: 0 2px 8px rgba(12, 95, 3, .12); }
  .card img { width: 100%; display: block; background: #EDF0ED; }
  .card.broken img { visibility: hidden; }
  .card.broken::before { content: "图片加载失败"; display: block; padding: 40px 10px; text-align: center; font-size: 13px; color: #8A948E; }
  .card .badge { position: absolute; top: 8px; right: 8px; font-size: 12px; padding: 3px 8px; border-radius: 6px; background: rgba(12, 95, 3, .92); color: #ffffff; display: none; }
  .card.done .badge { display: inline-block; }
  .card.skipped .badge { background: rgba(0, 0, 0, .55); }
  .card .src { font-size: 11px; color: #8A948E; padding: 6px 8px; background: #ffffff; }
  .modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .4); display: none; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
  .modal-mask.open { display: flex; }
  .modal { background: #ffffff; border-radius: 12px; padding: 20px; width: 100%; max-width: 360px; max-height: 80vh; overflow: auto; }
  .modal h2 { font-size: 15px; margin: 0 0 12px; font-weight: 600; }
  .modal .cat-btn { display: block; width: 100%; margin-bottom: 8px; padding: 10px 12px; font-size: 14px; border-radius: 8px; border: 1px solid #ECEFEC; background: #F5F7F5; color: #1F2421; cursor: pointer; text-align: center; }
  .modal .cat-btn:hover { background: #E8F3EA; border-color: #0C5F03; }
  .modal .skip-btn { background: #ffffff; color: #8A948E; }
  .modal .cancel-btn { background: #ffffff; }
</style>
</head>
<body>
<header>
  <h1>火大猫谱 · 猫↔照片归属重建</h1>
  <div class="progress"><div class="progress-fill" id="progress-fill"></div></div>
  <div class="progress-text" id="progress-text">已处理 0 / 0</div>
  <div class="legend" id="legend"></div>
  <div class="toolbar">
    <button class="primary" id="export-btn">导出结果</button>
    <button class="danger" id="clear-btn">清空重来</button>
  </div>
</header>
<main class="masonry" id="masonry"></main>
<div class="modal-mask" id="modal-mask">
  <div class="modal">
    <h2>这张照片属于哪只猫？</h2>
    <div id="modal-body"></div>
  </div>
</div>
<script>
const CATS = ${CATS_JSON};
const PHOTOS = ${PHOTOS_JSON};
const LS_KEY = 'relink-workbench-v1';

const catNameById = {};
CATS.forEach(function (c) { catNameById[c.id] = c.name; });

function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
}
function saveState(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
let state = loadState();
let currentSrc = null;

function processedCount() {
  let n = 0;
  PHOTOS.forEach(function (p) { if (state[p.src]) n++; });
  return n;
}

function updateProgress() {
  const done = processedCount();
  const total = PHOTOS.length;
  document.getElementById('progress-fill').style.width = (total ? (done / total * 100) : 0) + '%';
  document.getElementById('progress-text').textContent = '已处理 ' + done + ' / ' + total;
}

function renderLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = '';
  CATS.forEach(function (c) {
    const s = document.createElement('span');
    s.textContent = c.name;
    el.appendChild(s);
  });
}

function render() {
  const main = document.getElementById('masonry');
  main.innerHTML = '';
  PHOTOS.forEach(function (p) {
    const st = state[p.src];
    const card = document.createElement('div');
    card.className = 'card' + (st ? ' done' : '') + (st && st.action === 'skip' ? ' skipped' : '');

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = p.url;
    img.alt = p.src;
    img.onerror = function () { card.classList.add('broken'); };

    const badge = document.createElement('div');
    badge.className = 'badge';
    if (st && st.action === 'assign') badge.textContent = catNameById[st.cat_id] || st.cat_id;
    else if (st && st.action === 'skip') badge.textContent = '跳过';

    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = p.src;

    card.appendChild(img);
    card.appendChild(badge);
    card.appendChild(src);
    card.onclick = function () { if (!state[p.src]) openModal(p.src); };
    main.appendChild(card);
  });
  updateProgress();
}

function openModal(src) {
  currentSrc = src;
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  CATS.forEach(function (c) {
    const b = document.createElement('button');
    b.className = 'cat-btn';
    b.textContent = c.name;
    b.onclick = function () { assign(src, c.id); };
    body.appendChild(b);
  });
  const skip = document.createElement('button');
  skip.className = 'cat-btn skip-btn';
  skip.textContent = '跳过(不是猫)';
  skip.onclick = function () { skipPhoto(src); };
  body.appendChild(skip);
  const cancel = document.createElement('button');
  cancel.className = 'cat-btn cancel-btn';
  cancel.textContent = '取消';
  cancel.onclick = closeModal;
  body.appendChild(cancel);
  document.getElementById('modal-mask').classList.add('open');
}

function closeModal() { document.getElementById('modal-mask').classList.remove('open'); }

function assign(src, catId) {
  state[src] = { action: 'assign', cat_id: catId };
  saveState(state);
  closeModal();
  render();
}

function skipPhoto(src) {
  state[src] = { action: 'skip', cat_id: null };
  saveState(state);
  closeModal();
  render();
}

function exportResult() {
  const photos = [];
  PHOTOS.forEach(function (p) {
    const st = state[p.src];
    if (!st) return;
    photos.push({
      src: p.src,
      cat_id: st.action === 'assign' ? st.cat_id : null,
      action: st.action
    });
  });
  const payload = { exported_at: new Date().toISOString(), photos: photos };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'relink-result.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById('export-btn').onclick = exportResult;
document.getElementById('clear-btn').onclick = function () {
  if (!confirm('确定清空全部标注，重新开始？')) return;
  state = {};
  saveState(state);
  render();
};
document.getElementById('modal-mask').onclick = function (e) {
  if (e.target === this) closeModal();
};

renderLegend();
render();
</script>
</body>
</html>
`;
}

function writeWorkbenchHtml(cats, photos) {
  const html = buildWorkbenchHtml(cats, photos);
  const outPath = path.resolve(__dirname, '..', 'relink-workbench.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('已生成 ' + outPath + '（' + photos.length + ' 张照片，' + cats.length + ' 只猫）');
}

async function main() {
  const cats = readCats();
  if (!cats.length) {
    console.error('data/cat.json 里没有猫数据');
    process.exit(1);
  }

  if (DRY) {
    console.log('DRY_RUN=1：跳过 list 和复制，改用现有 11 张 cover.jpg 生成演示 html。');
    const photos = cats.map((c) => ({
      src: c.id + '.jpg',
      url: PUBLIC_DOMAIN + '/photos/' + c.id + '/cover.jpg',
    }));
    writeWorkbenchHtml(cats, photos);
    return;
  }

  assertEnv();
  const cos = createClient();

  console.log('正在列出 compressed/ 前缀对象…');
  const allKeys = await listAllKeys(cos);
  const imgKeys = allKeys
    .filter((k) => IMG_EXT_RE.test(k))
    .sort();
  console.log('compressed/ 下共 ' + allKeys.length + ' 个对象，其中图片 ' + imgKeys.length + ' 张');

  if (!imgKeys.length) {
    console.error('没有找到任何图片对象，中止。');
    process.exit(1);
  }

  const photos = [];
  let ok = 0;
  const failed = [];

  for (let i = 0; i < imgKeys.length; i++) {
    const sourceKey = imgKeys[i];
    const seq = String(i + 1).padStart(3, '0');
    const destKey = RELINK_PREFIX + seq + '.jpg';
    const contentType = contentTypeOf(extOf(sourceKey));
    const display = '(' + (i + 1) + '/' + imgKeys.length + ')';

    if (i === 0) {
      console.log('先复制第 1 张验证 CopySource 编码…');
    }

    try {
      await putObjectCopy(cos, sourceKey, destKey, contentType);
      console.log(display + ' ✔ ' + sourceKey + ' -> ' + destKey);
      photos.push({ src: seq + '.jpg', url: PUBLIC_DOMAIN + '/' + destKey });
      ok++;
    } catch (err) {
      const detail = err && (err.message || err.code) ? (err.message || err.code) : String(err);
      console.error(display + ' ✘ ' + sourceKey + ' 复制失败：' + detail);
      failed.push(sourceKey);
      if (i === 0) {
        // 第 1 张就失败：打印完整原始错误并中止，不吞错误
        console.error('第 1 张复制失败，完整错误：', err);
        console.error('已中止，不继续复制。请检查 CopySource 编码或密钥权限。');
        process.exit(1);
      }
    }
  }

  console.log('----------------------------------------');
  console.log('复制完成：成功 ' + ok + ' 张，失败 ' + failed.length + ' 张');
  if (failed.length) {
    console.error('失败列表：' + failed.join(', '));
  }

  writeWorkbenchHtml(cats, photos);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('relink-scan 异常：', err);
  process.exit(1);
});
