'use strict';

/**
 * 把火大猫谱的猫和照片批量注册进 MeowID 开放平台。
 *
 * 拍照识猫页（miniprogram/pages/packageA/pages/recognize）只负责「传图 → 拿候选」，
 * 但它能认出谁，取决于这个脚本往项目里灌了什么：
 *   1. 每只猫 → POST /v1/projects/{project_id}/cats 建一个个档案（cat_id 由服务端生成）
 *   2. 拿到的服务端 id 写回 data/cat.json 的 meowid_id 字段（小程序靠它对上本地猫谱）
 *   3. 每只猫挑若干张照片 → POST .../cats/{cat_id}/images 注册成参考图（202 进异步队列）
 *
 * 用法：
 *   MEOWID_PROJECT_ID=<项目完整 UUID> MEOWID_API_KEY=<mk_live_...> node scripts/meowid-enroll.js
 *   密钥也可以写在项目根的 .env 里（MEOWID_PROJECT_ID / MEOWID_API_KEY）。
 *
 * 可选环境变量：
 *   MEOWID_API_BASE   默认 https://platform.meowid.net
 *   MAX_PER_CAT       每只猫最多上传几张参考照，默认 12
 *   ONLY_CAT          只处理某只猫，例如 ONLY_CAT=cat-huihui
 *   REQUEST_TIMEOUT   单次请求超时毫秒，默认 120000
 *   DRY_RUN=1         只打印计划，不发任何请求
 *
 * 幂等：
 *   - data/cat.json 里已有 meowid_id 的猫，不再重复建档案
 *   - 项目根 .meowid-enroll-state.json 记录已上传的照片 _id，重复跑不会灌重复图
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_PATH = path.join(ROOT, '.meowid-enroll-state.json');

const DRY = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const API_BASE = (process.env.MEOWID_API_BASE || 'https://platform.meowid.net').replace(/\/+$/, '');
const MAX_PER_CAT = Math.max(1, parseInt(process.env.MAX_PER_CAT, 10) || 12);
const ONLY_CAT = (process.env.ONLY_CAT || '').trim();
const TIMEOUT = Math.max(5000, parseInt(process.env.REQUEST_TIMEOUT, 10) || 120000);

// ---------- 密钥 ----------

function parseDotEnv() {
  const envPath = path.join(ROOT, '.env');
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

const PROJECT_ID = readSecret('MEOWID_PROJECT_ID');
const API_KEY = readSecret('MEOWID_API_KEY');

// ---------- 数据读写 ----------

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { version: 1, uploaded: {} };
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!st.uploaded || typeof st.uploaded !== 'object') st.uploaded = {};
    return st;
  } catch (e) {
    console.warn('[enroll] 状态文件损坏，按全新处理：' + e.message);
    return { version: 1, uploaded: {} };
  }
}

// ---------- HTTP ----------

function authHeaders(extra) {
  return Object.assign({ Authorization: 'Bearer ' + API_KEY }, extra || {});
}

async function readBody(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (e) {
    return text;
  }
}

function describeFailure(status, body) {
  const detail = body && body.detail;
  const code = (detail && detail.code) || (body && body.code) || '';
  const msg = (detail && detail.message) || (typeof detail === 'string' ? detail : '');
  let hint = '';
  if (code === 'project_mismatch') hint = 'project_id 与 API Key 不属于同一个项目，去控制台项目页复制完整 UUID';
  else if (code === 'invalid_api_key') hint = 'API Key 无效或已被吊销';
  else if (code === 'AUTH_SESSION_EXPIRED') hint = 'API Key 已过期';
  else if (status === 401) hint = '鉴权失败';
  else if (status === 403) hint = '没有该操作权限（检查 API Key 的 scopes）';
  else if (status === 404) hint = '接口不存在（检查 MEOWID_API_BASE 与 project_id）';
  else if (status === 413) hint = '图片太大';
  else if (status === 429) hint = '请求太频繁';
  const parts = [status + (code ? ' ' + code : '')];
  if (msg) parts.push(msg);
  if (hint) parts.push(hint);
  return parts.join(' · ');
}

async function api(pathname, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = authHeaders(opts.headers);
  opts.signal = AbortSignal.timeout(TIMEOUT);
  const url = API_BASE + pathname;
  const res = await fetch(url, opts);
  const body = await readBody(res);
  if (!res.ok) {
    throw new Error(describeFailure(res.status, body));
  }
  return body;
}

// 服务端建猫返回体没在文档里写死，这里把常见几种形状都兼容一遍
function pickCatId(body) {
  if (!body || typeof body !== 'object') return '';
  const candidates = [body.id, body.cat_id, body.catId];
  if (body.cat && typeof body.cat === 'object') {
    candidates.push(body.cat.id, body.cat.cat_id);
  }
  if (body.data && typeof body.data === 'object') {
    candidates.push(body.data.id, body.data.cat_id);
  }
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return '';
}

async function findCatByName(name) {
  const list = await api('/v1/projects/' + encodeURIComponent(PROJECT_ID) + '/cats');
  if (!Array.isArray(list)) return '';
  const hit = list.find(c => c && c.name === name);
  return hit && hit.id ? hit.id : '';
}

// ---------- 主流程 ----------

function photoScore(photo) {
  // 精选图优先，其次有拍摄日期的、点赞多的
  let score = 0;
  if (photo.best) score += 100;
  if (photo.shooting_date && photo.shooting_date !== '2026-01-01') score += 10;
  score += Math.min(9, Number(photo.like_count) || 0);
  return score;
}

function pickPhotos(photos, catId, uploadedMap) {
  return photos
    .filter(p => p && p.cat_id === catId && p.verified !== false && !p.deleted && !p.hidden)
    .filter(p => p.photo_compressed)
    .filter(p => !uploadedMap[p._id])
    .sort((a, b) => photoScore(b) - photoScore(a))
    .slice(0, MAX_PER_CAT);
}

async function uploadPhoto(catId, photo) {
  const imgRes = await fetch(photo.photo_compressed, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!imgRes.ok) {
    throw new Error('下载原图失败 ' + imgRes.status + ' ' + photo.photo_compressed);
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const type = imgRes.headers.get('content-type') || 'image/jpeg';
  const form = new FormData();
  form.append('image', new Blob([buf], { type }), (photo._id || 'photo') + '.jpg');

  const res = await fetch(
    API_BASE + '/v1/projects/' + encodeURIComponent(PROJECT_ID)
      + '/cats/' + encodeURIComponent(catId) + '/images',
    { method: 'POST', headers: authHeaders(), body: form, signal: AbortSignal.timeout(TIMEOUT) }
  );
  const body = await readBody(res);
  // 202 = 已进异步队列，正常
  if (!res.ok && res.status !== 202) {
    throw new Error(describeFailure(res.status, body));
  }
  return body;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!PROJECT_ID || !API_KEY) {
    console.error('缺少 MEOWID_PROJECT_ID / MEOWID_API_KEY（环境变量或项目根 .env）');
    process.exit(1);
  }
  // 平台文档明确要求「完整的项目 UUID」，8-4-4-4-12
  const uuidLike = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(PROJECT_ID);
  if (!uuidLike) {
    console.warn('[enroll] ⚠️ MEOWID_PROJECT_ID 不像完整 UUID：' + PROJECT_ID);
    console.warn('[enroll]    平台控制台项目页要复制形如 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx 的 id');
  }

  // CHECK_ONLY=1：只验证 project_id 和 API Key 是否配得上，不写任何数据
  if (process.env.CHECK_ONLY === '1' || process.env.CHECK_ONLY === 'true') {
    console.log('[check] 项目 ' + PROJECT_ID + ' @ ' + API_BASE);
    try {
      const cats = await api('/v1/projects/' + encodeURIComponent(PROJECT_ID) + '/cats');
      const list = Array.isArray(cats) ? cats : [];
      console.log('[check] ✓ 鉴权通过，项目里已有 ' + list.length + ' 个个体');
      list.slice(0, 30).forEach(c => console.log('    - ' + (c && c.id) + '  ' + (c && c.name)));
      process.exit(0);
    } catch (e) {
      console.error('[check] ✗ ' + e.message);
      process.exit(1);
    }
  }

  const catFile = path.join(DATA_DIR, 'cat.json');
  const catDoc = loadJson(catFile);
  const allCats = Array.isArray(catDoc.items) ? catDoc.items : [];
  const photos = loadJson(path.join(DATA_DIR, 'photo.json')).items || [];
  const state = loadState();

  let cats = allCats.filter(c => c && c._id);
  if (ONLY_CAT) cats = cats.filter(c => c._id === ONLY_CAT);
  console.log('[enroll] 项目 ' + PROJECT_ID + ' @ ' + API_BASE);
  console.log('[enroll] 待处理猫 ' + cats.length + ' 只，每只最多 ' + MAX_PER_CAT + ' 张，photo 总数 ' + photos.length);

  let created = 0;
  let uploaded = 0;
  let skipped = 0;
  const failures = [];

  for (const cat of cats) {
    let catId = cat.meowid_id || '';
    if (!catId) {
      if (DRY) {
        console.log('[dry] 新建个体 ' + cat._id + ' (' + cat.name + ')');
        catId = 'dry-' + cat._id;
      } else {
        try {
          const body = await api('/v1/projects/' + encodeURIComponent(PROJECT_ID) + '/cats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: cat.name || cat._id,
              metadata: {
                local_id: cat._id,
                campus: cat.campus || '',
                area: cat.area || '',
                colour: cat.colour || '',
              },
              active: true,
            }),
          });
          catId = pickCatId(body);
          if (!catId) catId = await findCatByName(cat.name || cat._id);
          if (!catId) throw new Error('建档成功但没拿到 cat id：' + JSON.stringify(body).slice(0, 200));
          cat.meowid_id = catId;
          saveJson(catFile, catDoc); // 每成功一只就落盘，中断也不丢
          created++;
          console.log('[enroll] + 个体 ' + cat._id + ' → ' + catId);
        } catch (e) {
          failures.push(cat._id + ' 建档失败：' + e.message);
          console.error('[enroll] ✗ ' + cat._id + ' 建档失败：' + e.message);
          continue;
        }
      }
    } else {
      skipped++;
    }

    const todo = pickPhotos(photos, cat._id, state.uploaded);
    if (!todo.length) {
      console.log('[enroll] = ' + cat._id + ' 没有待上传照片');
      continue;
    }
    for (const photo of todo) {
      if (DRY) {
        console.log('[dry] 上传 ' + photo._id + ' → ' + catId);
        uploaded++;
        continue;
      }
      try {
        await uploadPhoto(catId, photo);
        state.uploaded[photo._id] = { cat_id: catId, at: new Date().toISOString() };
        saveJson(STATE_PATH, state);
        uploaded++;
        console.log('[enroll]   ↑ ' + photo._id);
      } catch (e) {
        failures.push(photo._id + ' 上传失败：' + e.message);
        console.error('[enroll]   ✗ ' + photo._id + ' 上传失败：' + e.message);
      }
      await sleep(300); // 别把平台打爆
    }
  }

  console.log('');
  console.log('[enroll] 完成：新建个体 ' + created + '，已有个体 ' + skipped + '，上传照片 ' + uploaded);
  if (failures.length) {
    console.log('[enroll] 失败 ' + failures.length + ' 项：');
    failures.slice(0, 20).forEach(f => console.log('  - ' + f));
  }
  if (!DRY && created) {
    console.log('[enroll] data/cat.json 已写入 meowid_id，记得推 cos 让小程序读到');
  }
  process.exit(failures.length && !uploaded ? 1 : 0);
}

main().catch(e => {
  console.error('[enroll] 致命错误：' + (e && e.message));
  process.exit(1);
});
