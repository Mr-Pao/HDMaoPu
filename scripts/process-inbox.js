'use strict';

/**
 * 聚合 COS 上 inbox/ 前缀里的写入请求，把结果落回 data/*.json。
 *
 * 链路：
 *   小程序 --匿名 PUT--> COS inbox/<kind>/<ts>-<openid>-<rand>.json
 *   GitHub Actions（每小时）--本脚本--> 改写 data/*.json
 *   sync-data.yml --检测到 data/** 变化--> 上传回 COS
 *
 * 职责边界：本脚本只改本地 data/ 文件，不上传。上传交给 sync-data.yml。
 *
 * 写通道防刷策略（守 5 元红线，零成本）：
 *   1. COS 桶策略只允许匿名 PutObject 到 inbox/*，不能读/删/枚举/写其他前缀
 *      （前缀收紧，已在桶策略侧确认）——这是第一道闸门，纯配置、零算力。
 *   2. 本脚本在聚合入口做服务端校验（纯 Actions 算力，不引入服务器/SCF）：
 *      - openid 格式校验（非空、长度 ≤64、字符集受限）
 *      - kind 白名单（只接受现有合法值，拒绝未知 kind）
 *      - body schema 基础校验（必须有 v/kind/openid/ts/data；data 为对象）
 *      - 单对象体积上限 4096 字节前置拦截（list 阶段 + parse 阶段双重）
 *      - 单 openid 运行内突发限频（MAX_PER_OPENID）+ 跨运行去重
 *        （inbox_log 记录，跨天去重）+ pop 12 小时跨运行限频
 *   3. 关于「COS 预签名 URL 方案」：本次【不落地】。原因——EMAS 空间已删，
 *      原存于 EMAS app_secret 集合的 SecretId/SecretKey 已不可读，客户端无法
 *      安全生成预签名 URL；改用「桶策略前缀收紧 + Actions 端校验」作为等效零成本
 *      防刷。该决策记录在 .workbuddy/memory/2026-10-31.md。
 *
 * 用法：
 *   COS_SECRET_ID=xx COS_SECRET_KEY=xx COS_BUCKET=xx COS_REGION=xx \
 *   REVIEW_PASSCODE=xx node scripts/process-inbox.js
 *
 *   DRY_RUN=1  不发网络请求，用内置的模拟对象跑一遍聚合逻辑，不写文件
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  COS_SECRET_ID,
  COS_SECRET_KEY,
  COS_BUCKET,
  COS_REGION,
  REVIEW_PASSCODE,
  DRY_RUN,
} = process.env;

const DRY = DRY_RUN === '1' || DRY_RUN === 'true';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const INBOX_PREFIX = 'inbox/';
const SELFTEST_PREFIX = 'inbox/_selftest/';

// 单个对象的体积上限，超过直接丢弃（正常 payload 都在 500 字节内）。
// 注意：这个 too-large 前置拦截保留——单对象大小上限是防止 inbox 被大文件灌爆的
// 第一道闸门，list 阶段（main）和 parseObject 阶段双重检查。
const MAX_OBJECT_BYTES = 4096;
// 单次运行内，单个 openid 最多处理多少条（运行内突发限频）
const MAX_PER_OPENID = 200;
// 审核队列保留条数
const REVIEW_KEEP = 200;
// 批量删除单次上限
const DELETE_BATCH = 1000;
// 同一 inbox 对象连续处理失败的重试上限，超过后记日志并删除，防止死循环
const MAX_KEY_FAILURES = 3;
// pop 跨运行限频：同一 openid+cat 12 小时内只记一次人气
const POP_COOLDOWN_MS = 12 * 60 * 60 * 1000;

const VALID_KINDS = ['like', 'follow', 'pop', 'rating', 'comment', 'decision', 'manage'];

// ---- 写通道防刷增强（零成本，纯 Actions 脚本端校验，不引入任何服务器/SCF）----
// openid 格式约束：微信 openid 形如 oXXXX，由字母数字组成；这里放宽允许 _ 和 -。
// 用于防刷——拒绝超长/含奇怪字符的 openid，避免 data/inbox_log 被恶意撑爆，
// 也避免把脏 openid 写进去污染计数维度。
const OPENID_MAX_LEN = 64;
const OPENID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
// ts 合理性窗口：拒绝明显伪造的时间戳，防重放/历史灌水。
// 允许未来最多 5 分钟（机器时钟偏差）和过去最多 365 天（超过视为过期垃圾直接丢弃）。
const TS_MAX_FUTURE_MS = 5 * 60 * 1000;
const TS_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 数据读写
// ---------------------------------------------------------------------------

const store = Object.create(null);
const touched = new Set();

function dataFile(name) {
  return path.join(DATA_DIR, name + '.json');
}

function loadData(name) {
  if (store[name]) return store[name];
  const file = dataFile(name);
  if (!fs.existsSync(file)) {
    store[name] = { version: 'v0', items: [] };
    return store[name];
  }
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name}.json 解析失败：${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    parsed = { version: 'v0', items: [] };
  }
  store[name] = parsed;
  return parsed;
}

function markTouched(name) {
  touched.add(name);
}

function flushData() {
  if (DRY) return [];
  const written = [];
  for (const name of touched) {
    const obj = store[name];
    if (!obj) continue;
    obj.version = 'v' + Date.now();
    // 先写临时文件再 rename，避免写一半崩溃留下损坏的 JSON
    const finalPath = dataFile(name);
    const tmpPath = finalPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, finalPath);
    written.push(name);
  }
  return written;
}

function findItem(name, id) {
  const data = loadData(name);
  return data.items.find(it => it && it._id === id);
}

// id 生成：时间戳 + 更长的随机后缀，降低碰撞概率（原 4 位随机太短）
function genId(prefix, ts) {
  return `${prefix}-${ts}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// 入站对象的解析与校验
// ---------------------------------------------------------------------------

function parseObject(key, body) {
  // too-large 前置拦截：单对象体积上限（防大文件灌爆 inbox），保留不变
  if (Buffer.byteLength(body, 'utf8') > MAX_OBJECT_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return { ok: false, reason: 'bad-json' };
  }
  // body schema 基础校验：必须有 v/kind/openid/ts/data 且类型正确
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'bad-shape' };
  }
  if (payload.v !== 1) return { ok: false, reason: 'bad-version' };
  if (!VALID_KINDS.includes(payload.kind)) return { ok: false, reason: 'bad-kind' };
  // openid 格式校验：非空、长度受控、字符集受限（防刷/防脏数据）
  if (typeof payload.openid !== 'string' || !OPENID_RE.test(payload.openid)) {
    return { ok: false, reason: 'bad-openid' };
  }
  // ts 必须存在且为合理范围内的数字（防重放/历史灌水）
  const ts = Number(payload.ts);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad-ts' };
  const now = Date.now();
  if (ts > now + TS_MAX_FUTURE_MS) return { ok: false, reason: 'ts-future' };
  if (ts < now - TS_MAX_AGE_MS) return { ok: false, reason: 'ts-expired' };
  // data 必须是对象（且非数组/空）
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    return { ok: false, reason: 'no-data' };
  }
  return { ok: true, payload, ts };
}

function tokenOk(token) {
  const expect = REVIEW_PASSCODE || '';
  if (!expect) return false;
  if (typeof token !== 'string') return false;
  // 先各自做 sha256 摘要再 timingSafeEqual：摘要定长，消除长度侧信道
  const a = crypto.createHash('sha256').update(token, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expect, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// 去重日志：data/inbox_log.json
// key 形如 "like|openid|photo_id"
// ---------------------------------------------------------------------------

let logIndex = null;

function logKey(kind, openid, target) {
  return `${kind}|${openid}|${target}`;
}

function getLogIndex() {
  if (logIndex) return logIndex;
  const data = loadData('inbox_log');
  logIndex = new Map();
  for (const it of data.items) {
    if (it && it.k) logIndex.set(it.k, it);
  }
  return logIndex;
}

function readLog(kind, openid, target) {
  return getLogIndex().get(logKey(kind, openid, target)) || null;
}

function writeLog(kind, openid, target, state, ts) {
  const idx = getLogIndex();
  const key = logKey(kind, openid, target);
  // _id 必须存在：upload-data.js 会校验每一条都有 _id，缺了会导致整批上传中止
  const rec = { _id: key, k: key, kind, openid, target, state, ts };
  idx.set(key, rec);
  const data = loadData('inbox_log');
  const pos = data.items.findIndex(it => it && it.k === key);
  if (pos >= 0) data.items[pos] = rec;
  else data.items.push(rec);
  markTouched('inbox_log');
}

// 记录单个 inbox 对象的处理失败次数（按 key 存在 inbox_log，kind=keyfail），
// 连续超过 MAX_KEY_FAILURES 次后放弃重试并删除，防止坏对象死循环占用。
function recordKeyFailure(key, ts) {
  const prev = readLog('keyfail', '', key);
  const count = (prev && Number(prev.state)) || 0;
  const next = count + 1;
  writeLog('keyfail', '', key, next, ts || Date.now());
  return next;
}

// ---------------------------------------------------------------------------
// 各类 kind 的处理
// ---------------------------------------------------------------------------

function bumpCounter(container, field, delta) {
  const cur = Number(container[field]);
  const base = Number.isFinite(cur) ? cur : 0;
  container[field] = Math.max(0, base + delta);
}

function handleLike(p) {
  const { openid, data, ts } = p;
  const photoId = data.photo_id;
  const like = data.like !== false;
  if (!photoId) return 'drop:no-photo-id';

  const photo = findItem('photo', photoId);
  if (!photo) return 'drop:photo-not-found';

  const prev = readLog('like', openid, photoId);
  if (prev && prev.state === like) return 'skip:duplicate';

  // 第一次点赞（无记录且 like=true）→ +1
  // 有记录且状态翻转 → ±1
  // 无记录但 like=false（用户声称取消一个从没点过的赞）→ 不动计数
  let delta = 0;
  if (prev) delta = like ? 1 : -1;
  else if (like) delta = 1;

  if (delta !== 0) bumpCounter(photo, 'like_count', delta);
  writeLog('like', openid, photoId, like, ts);
  markTouched('photo');
  return 'ok';
}

function handleFollow(p) {
  const { openid, data, ts } = p;
  const catId = data.cat_id;
  const follow = data.follow !== false;
  if (!catId) return 'drop:no-cat-id';

  const cat = findItem('cat', catId);
  if (!cat) return 'drop:cat-not-found';

  const prev = readLog('follow', openid, catId);
  if (prev && prev.state === follow) return 'skip:duplicate';

  let delta = 0;
  if (prev) delta = follow ? 1 : -1;
  else if (follow) delta = 1;

  if (delta !== 0) bumpCounter(cat, 'follow_count', delta);
  writeLog('follow', openid, catId, follow, ts);
  markTouched('cat');
  return 'ok';
}

function handlePop(p) {
  const openid = p.openid;
  const catId = p.data.cat_id;
  if (!catId) return 'drop:no-cat-id';
  const cat = findItem('cat', catId);
  if (!cat) return 'drop:cat-not-found';
  const ts = Number(p.ts) || Date.now();
  // 跨运行限频：同一 openid+cat 在 12 小时内只记一次人气（记在 inbox_log）
  const prev = readLog('pop', openid, catId);
  if (prev && Number(prev.state) && ts - Number(prev.state) < POP_COOLDOWN_MS) {
    return 'drop:pop-cooldown';
  }
  bumpCounter(cat, 'popularity', 1);
  markTouched('cat');
  writeLog('pop', openid, catId, ts, ts);
  return 'ok';
}

function handleRating(p) {
  const { openid, data, ts } = p;
  const catId = data.cat_id;
  const score = Number(data.score);
  if (!catId) return 'drop:no-cat-id';
  if (!Number.isInteger(score) || score < 1 || score > 5) return 'drop:bad-score';

  const cat = findItem('cat', catId);
  if (!cat) return 'drop:cat-not-found';

  if (!cat.rating || typeof cat.rating !== 'object') {
    cat.rating = { count: 0, scores: { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 }, avgScore: 0, avgScoreDisp: '0.0' };
  }
  const r = cat.rating;
  if (!r.scores) r.scores = { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 };

  const prev = readLog('rating', openid, catId);
  if (prev && prev.state === score) return 'skip:duplicate';

  // 同一人重复评分：先撤掉旧分，再记新分
  if (prev && prev.state >= 1 && prev.state <= 5) {
    r.scores['r' + prev.state] = Math.max(0, Number(r.scores['r' + prev.state] || 0) - 1);
    r.count = Math.max(0, Number(r.count || 0) - 1);
  }

  r.scores['r' + score] = Number(r.scores['r' + score] || 0) + 1;
  r.count = Number(r.count || 0) + 1;

  // 重算均分
  let sum = 0;
  let cnt = 0;
  for (let i = 1; i <= 5; i++) {
    const c = Number(r.scores['r' + i] || 0);
    sum += i * c;
    cnt += c;
  }
  r.count = cnt;
  r.avgScore = cnt ? sum / cnt : 0;
  r.avgScoreDisp = r.avgScore.toFixed(1);

  writeLog('rating', openid, catId, score, ts);
  markTouched('cat');
  return 'ok';
}

function handleComment(p) {
  const { openid, data, ts } = p;
  if (!data.cat_id) return 'drop:no-cat-id';
  const queue = loadData('review_queue');
  const id = genId('rv', ts);
  queue.items.push({
    _id: id,
    kind: 'comment',
    openid,
    ts,
    status: 'pending',
    create_time: new Date(ts || Date.now()).toISOString(),
    data: {
      cat_id: data.cat_id,
      content: String(data.content || '').slice(0, 500),
      nickname: String(data.nickname || '匿名猫友').slice(0, 30),
    },
  });
  markTouched('review_queue');
  return 'ok:queue';
}

function handleDecision(p) {
  const { data } = p;
  if (!tokenOk(data.token)) return 'drop:bad-token';
  const itemId = data.item_id;
  const action = data.action;
  if (!itemId) return 'drop:no-item-id';
  if (action !== 'approve' && action !== 'reject') return 'drop:bad-action';

  const queue = loadData('review_queue');
  const item = queue.items.find(it => it && it._id === itemId);
  if (!item) return 'drop:item-not-found';
  if (item.status !== 'pending') return 'skip:already-decided';

  item.status = action === 'approve' ? 'approved' : 'rejected';
  item.decide_time = new Date().toISOString();

  if (action === 'approve') {
    if (item.kind === 'comment') {
      const comments = loadData('comment');
      comments.items.unshift({
        _id: genId('cm', item.ts),
        cat_id: item.data.cat_id,
        content: item.data.content,
        nickname: item.data.nickname,
        _openid: item.openid,
        create_date: new Date(item.ts || Date.now()).toISOString(),
        deleted: false,
      });
      markTouched('comment');
    } else if (item.kind === 'photo') {
      // 照片落库依赖 photo 对象的字段结构，上传入口目前关闭，
      // 真开启时在这里按 photo.json 的字段补齐。
      console.log(`  [warn] 照片审核通过暂未落库（item ${itemId}），需要补齐 photo 字段映射`);
    }
  }

  markTouched('review_queue');
  return 'ok:decided';
}

function trimQueue() {
  const queue = loadData('review_queue');
  if (queue.items.length <= REVIEW_KEEP) return 0;
  // 只裁剪已决定（status !== 'pending'）的旧记录，保留最新 REVIEW_KEEP 条；
  // pending 记录不参与裁剪，避免把还没审核的内容裁掉。
  const pending = queue.items.filter(it => it && it.status === 'pending');
  const decided = queue.items.filter(it => it && it.status !== 'pending');
  if (decided.length <= REVIEW_KEEP) return 0;
  const removed = decided.length - REVIEW_KEEP;
  decided.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  queue.items = pending.concat(decided.slice(0, REVIEW_KEEP));
  markTouched('review_queue');
  return removed;
}

// manage/updateCat 允许修改的猫字段白名单（与 data/cat.json 实际字段对齐）。
// _id、rating、popularity、follow_count、photo_count_*、comment_count、deleted 等
// 统计/系统字段不在名单内，出现在 patch 里整条拒绝。
const MANAGE_CAT_PATCH_FIELDS = [
  'name',
  'nickname',
  'gender',
  'campus',
  'area',
  'colour',
  'birthday',
  'characteristics',
  'habit',
  'tutorial',
  'sterilized',
  'sterilized_time',
  'adopt',
  'adopt_time',
  'missing',
  'missing_time',
  'to_star',
  'deceased_time',
];

// 每个字段的类型约束（与 data/cat.json 实际值类型对齐）。
// missing_time / deceased_time 在数据里可为 null（表示未走失/未离世），
// 所以这两个字段额外允许 null。
const MANAGE_CAT_PATCH_TYPES = {
  name: 'string',
  nickname: 'string',
  gender: 'string',
  campus: 'string',
  area: 'string',
  colour: 'string',
  birthday: 'string',
  characteristics: 'string',
  habit: 'string',
  tutorial: 'string',
  sterilized: 'boolean',
  sterilized_time: 'string',
  adopt: 'number',
  adopt_time: 'string',
  missing: 'boolean',
  missing_time: 'string',
  to_star: 'boolean',
  deceased_time: 'string',
};

function patchValueOk(field, value) {
  const type = MANAGE_CAT_PATCH_TYPES[field];
  if (!type) return false;
  if (value === null && (field === 'missing_time' || field === 'deceased_time')) return true;
  if (type === 'string') return typeof value === 'string' && value.length <= 500;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function handleManage(p) {
  const { data } = p;
  if (!tokenOk(data.token)) return 'drop:bad-token';

  if (data.action === 'updateCat') return manageUpdateCat(data);
  if (data.action === 'managePhoto') return managePhoto(data);
  return 'drop:bad-action';
}

function manageUpdateCat(data) {
  const catId = data.cat_id;
  if (!catId) return 'drop:no-cat-id';
  const patch = data.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'drop:no-patch';

  const keys = Object.keys(patch);
  if (!keys.length) return 'drop:no-patch';
  for (const k of keys) {
    if (!MANAGE_CAT_PATCH_FIELDS.includes(k)) return 'drop:bad-patch-field';
  }
  for (const k of keys) {
    if (!patchValueOk(k, patch[k])) return 'drop:bad-patch-type';
  }

  const cat = findItem('cat', catId);
  if (!cat) return 'drop:cat-not-found';

  for (const k of keys) cat[k] = patch[k];
  markTouched('cat');
  return 'ok:cat-updated';
}

function managePhoto(data) {
  const photoId = data.photo_id;
  if (!photoId) return 'drop:no-photo-id';

  // photo_id 传的是 photo.json 里的 _id，和 like 的口径一致
  const photo = findItem('photo', photoId);
  if (!photo) return 'drop:photo-not-found';

  photo.hidden = !!data.hidden;
  markTouched('photo');
  return 'ok:photo-hidden';
}

const HANDLERS = {
  like: handleLike,
  follow: handleFollow,
  pop: handlePop,
  rating: handleRating,
  comment: handleComment,
  decision: handleDecision,
  manage: handleManage,
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function processObjects(objects, stats) {
  const perOpenid = new Map();
  const doneKeys = [];

  for (const obj of objects) {
    stats.read++;
    const parsed = parseObject(obj.key, obj.body);
    if (!parsed.ok) {
      stats.dropped[parsed.reason] = (stats.dropped[parsed.reason] || 0) + 1;
      doneKeys.push(obj.key);
      continue;
    }

    const p = parsed.payload;
    const used = perOpenid.get(p.openid) || 0;
    if (used >= MAX_PER_OPENID && p.kind !== 'decision') {
      stats.dropped['rate-limited'] = (stats.dropped['rate-limited'] || 0) + 1;
      doneKeys.push(obj.key);
      continue;
    }

    // pop 运行内按 openid+cat 去重；跨运行的 12 小时限频在 handlePop 里查 inbox_log
    if (p.kind === 'pop') {
      const k = p.openid + '|' + p.data.cat_id;
      if (stats.__popSeen.has(k)) {
        stats.dropped['pop-duplicate'] = (stats.dropped['pop-duplicate'] || 0) + 1;
        doneKeys.push(obj.key);
        continue;
      }
      stats.__popSeen.add(k);
    }

    let result;
    try {
      result = HANDLERS[p.kind](p);
    } catch (err) {
      result = 'error:' + (err && err.message ? err.message : String(err));
    }

    stats.byKind[p.kind] = stats.byKind[p.kind] || { applied: 0, skipped: 0 };

    if (result.startsWith('ok')) {
      stats.applied++;
      stats.byKind[p.kind].applied++;
      // 配额只统计真正生效的条目；skip/drop 不占配额
      if (p.kind !== 'decision') perOpenid.set(p.openid, used + 1);
      doneKeys.push(obj.key);
    } else if (result.startsWith('skip')) {
      stats.skipped++;
      stats.byKind[p.kind].skipped++;
      doneKeys.push(obj.key);
    } else if (result.startsWith('error')) {
      // handler 异常：不算处理成功，key 保留在桶里下轮重试（有上限防死循环）
      const fails = recordKeyFailure(obj.key, p.ts);
      if (fails > MAX_KEY_FAILURES) {
        stats.dropped['retry-limit'] = (stats.dropped['retry-limit'] || 0) + 1;
        console.error(`  [retry-limit] ${obj.key} 连续失败 ${fails} 次，放弃并删除`);
        doneKeys.push(obj.key);
      } else {
        stats.retried = (stats.retried || 0) + 1;
        console.error(`  [retry] ${obj.key} 处理失败（第 ${fails} 次），保留待下轮重试`);
      }
    } else {
      const reason = result.split(':')[1] || 'unknown';
      stats.dropped[reason] = (stats.dropped[reason] || 0) + 1;
      doneKeys.push(obj.key);
    }
  }

  return doneKeys;
}

function newStats() {
  return { read: 0, applied: 0, skipped: 0, retried: 0, dropped: {}, byKind: {}, __popSeen: new Set() };
}

// ---------------------------------------------------------------------------
// COS 操作
// ---------------------------------------------------------------------------

function cosClient() {
  const COS = require('cos-nodejs-sdk-v5');
  return new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });
}

function listInbox(cos) {
  return new Promise((resolve, reject) => {
    const keys = [];
    const loop = marker => {
      cos.getBucket(
        {
          Bucket: COS_BUCKET,
          Region: COS_REGION,
          Prefix: INBOX_PREFIX,
          Marker: marker,
          MaxKeys: 1000,
        },
        (err, data) => {
          if (err) return reject(err);
          const contents = (data && data.Contents) || [];
          for (const c of contents) {
            if (!c.Key) continue;
            if (c.Key.startsWith(SELFTEST_PREFIX)) continue;
            if (c.Key.endsWith('/')) continue;
            // Size 单位字节，list 阶段就能拿到，用于大对象前置过滤
            keys.push({ key: c.Key, size: Number(c.Size || 0) });
          }
          // IsTruncated 可能是 boolean 或字符串，统一转字符串比较
          if (data && String(data.IsTruncated) === 'true' && data.NextMarker) {
            loop(data.NextMarker);
          } else {
            resolve(keys);
          }
        }
      );
    };
    loop('');
  });
}

function getObject(cos, key) {
  return new Promise((resolve, reject) => {
    cos.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (err, data) => {
      if (err) return reject(err);
      resolve(Buffer.isBuffer(data.Body) ? data.Body.toString('utf8') : String(data.Body || ''));
    });
  });
}

function deleteKeys(cos, keys) {
  if (!keys.length) return Promise.resolve();
  const batches = [];
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    batches.push(keys.slice(i, i + DELETE_BATCH));
  }
  return batches.reduce(
    (prev, batch) =>
      prev.then(
        () =>
          new Promise((resolve, reject) => {
            cos.deleteMultipleObject(
              {
                Bucket: COS_BUCKET,
                Region: COS_REGION,
                Objects: batch.map(k => ({ Key: k })),
              },
              (err, data) => (err ? reject(err) : resolve(data))
            );
          })
      ),
    Promise.resolve()
  );
}

// ---------------------------------------------------------------------------
// DRY_RUN 自测
// ---------------------------------------------------------------------------

function selftestObjects() {
  const now = Date.now();
  const cat = 'demo-cat-1';
  const photo = 'demo-photo-1';
  const mk = (kind, openid, data, offset) => ({
    key: `inbox/${kind}/${now + offset}-${openid.slice(0, 8)}-aaaa.json`,
    body: JSON.stringify({ v: 1, kind, openid, ts: now + offset, data }),
  });

  return [
    mk('pop', 'openid-a', { cat_id: cat }, 1),
    mk('pop', 'openid-a', { cat_id: cat }, 2), // 同批重复，应被 pop 去重
    mk('pop', 'openid-b', { cat_id: cat }, 3),
    mk('like', 'openid-a', { photo_id: photo, cat_id: cat, like: true }, 4),
    mk('like', 'openid-a', { photo_id: photo, cat_id: cat, like: true }, 5), // 重复，应 skip
    mk('like', 'openid-b', { photo_id: photo, cat_id: cat, like: true }, 6),
    mk('follow', 'openid-a', { cat_id: cat, follow: true }, 7),
    mk('follow', 'openid-a', { cat_id: cat, follow: false }, 8), // 翻转，应 -1
    mk('rating', 'openid-a', { cat_id: cat, score: 5 }, 9),
    mk('rating', 'openid-a', { cat_id: cat, score: 4 }, 10), // 改分，应替换
    mk('comment', 'openid-a', { cat_id: cat, content: '自测评论', nickname: '自测' }, 11),
    {
      key: `inbox/decision/${now + 12}-xxxx-aaaa.json`,
      body: JSON.stringify({
        v: 1,
        kind: 'decision',
        openid: 'openid-a',
        ts: now + 12,
        data: { item_id: '__NONE__', action: 'approve', token: REVIEW_PASSCODE || 'wrong' },
      }),
    },
    { key: `inbox/like/${now + 13}-bad-aaaa.json`, body: 'not json at all' },
    { key: `inbox/evil/${now + 14}-bad-aaaa.json`, body: JSON.stringify({ v: 1, kind: 'evil', openid: 'x', ts: 1, data: {} }) },
    // manage 自测：token 从环境变量注入（REVIEW_PASSCODE），代码里不出现真实口令
    mk('manage', 'openid-a', { action: 'updateCat', token: REVIEW_PASSCODE || 'wrong', cat_id: cat, patch: { name: '大橘（自测改名）', habit: '自测晒太阳' } }, 15),
    mk('manage', 'openid-a', { action: 'managePhoto', token: REVIEW_PASSCODE || 'wrong', photo_id: photo, hidden: true }, 16),
    mk('manage', 'openid-a', { action: 'updateCat', token: 'definitely-wrong-token', cat_id: cat, patch: { name: '不该生效' } }, 17), // 口令错，应被丢弃
    mk('manage', 'openid-a', { action: 'updateCat', token: REVIEW_PASSCODE || 'wrong', cat_id: cat, patch: { popularity: 999, name: '也不该生效' } }, 18), // 白名单外字段，整条拒绝
    mk('manage', 'openid-a', { action: 'deleteEverything', token: REVIEW_PASSCODE || 'wrong' }, 19), // 未知 action，应被丢弃
  ];
}

function snapshot() {
  const cat = findItem('cat', 'demo-cat-1');
  const photo = findItem('photo', 'demo-photo-1');
  return {
    catPop: cat ? cat.popularity : null,
    catFollow: cat ? cat.follow_count : null,
    catRating: cat ? JSON.stringify(cat.rating) : null,
    catName: cat ? cat.name : null,
    catHabit: cat ? cat.habit : null,
    photoLike: photo ? photo.like_count : null,
    photoHidden: photo ? !!photo.hidden : null,
    queue: loadData('review_queue').items.length,
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const stats = newStats();

  if (DRY) {
    console.log('DRY_RUN=1，使用内置模拟对象跑聚合逻辑，不写文件、不发请求。');
    console.log('初始状态：' + JSON.stringify(snapshot()));
    console.log('----------------------------------------');

    const keys = processObjects(selftestObjects(), stats);
    trimQueue();

    console.log('聚合后状态：' + JSON.stringify(snapshot()));
    console.log('----------------------------------------');
    printStats(stats);
    console.log('----------------------------------------');
    console.log('处理成功/确定可删的对象（应被删除）：' + keys.length + ' 个');
    console.log('内存中标记为已改动的文件：' + Array.from(touched).join(', '));
    console.log('DRY_RUN 结束，未写入任何文件。');
    return;
  }

  const missing = [];
  if (!COS_SECRET_ID) missing.push('COS_SECRET_ID');
  if (!COS_SECRET_KEY) missing.push('COS_SECRET_KEY');
  if (!COS_BUCKET) missing.push('COS_BUCKET');
  if (!COS_REGION) missing.push('COS_REGION');
  if (missing.length) {
    console.error('缺少环境变量：' + missing.join(', '));
    process.exit(1);
  }
  if (!REVIEW_PASSCODE) {
    console.warn('警告：未设置 REVIEW_PASSCODE，所有 decision 都会被丢弃（审核页提交的内容不生效）。');
  }

  const cos = cosClient();
  const listed = await listInbox(cos);
  console.log(`inbox/ 下待处理对象：${listed.length} 个`);

  if (!listed.length) {
    console.log('没有待处理内容，结束。');
    return;
  }

  // 大对象在 list 阶段直接进删除名单，不下载不解析（只删不读）
  const toDelete = [];
  const objects = [];
  for (const item of listed) {
    if (item.size > MAX_OBJECT_BYTES) {
      console.log(`过大对象（${item.size} 字节 > ${MAX_OBJECT_BYTES}），不读取直接删除：${item.key}`);
      stats.dropped['too-large'] = (stats.dropped['too-large'] || 0) + 1;
      toDelete.push(item.key);
      continue;
    }
    try {
      objects.push({ key: item.key, body: await getObject(cos, item.key) });
    } catch (err) {
      console.error(`读取失败 ${item.key}：${err.message || err}`);
      const fails = recordKeyFailure(item.key);
      if (fails > MAX_KEY_FAILURES) {
        console.error(`  连续失败 ${fails} 次，放弃重试并删除：${item.key}`);
        stats.dropped['retry-limit'] = (stats.dropped['retry-limit'] || 0) + 1;
        toDelete.push(item.key);
      }
    }
  }

  // doneKeys 只包含已成功处理（含确定性 drop/skip）的 key；
  // 处理出错的对象不删，留在桶里下轮重试
  const doneKeys = processObjects(objects, stats);
  const trimmed = trimQueue();
  const written = flushData();

  // flush 成功后输出标记：workflow 的 commit step 据此判断可以提交。
  // 注意：删除 inbox 失败不影响此标记（data/ 已写好，应该照常提交）。
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, 'flush_ok=1\n');
  }

  printStats(stats);
  if (trimmed) console.log(`审核队列裁剪：移除 ${trimmed} 条超出上限的已决定旧记录`);
  console.log('写入文件：' + (written.length ? written.join(', ') : '（无变化）'));

  const deleteList = toDelete.concat(doneKeys);
  if (!deleteList.length) {
    console.log('没有可删除的 inbox 对象。');
    return;
  }
  try {
    await deleteKeys(cos, deleteList);
    console.log(`已从 inbox/ 删除 ${deleteList.length} 个对象`);
  } catch (err) {
    console.error('删除 inbox 对象失败（下次运行会重复处理，去重日志会自动拦住）：' + (err.message || err));
    process.exitCode = 1;
  }
}

function printStats(stats) {
  console.log('统计：');
  console.log(`  读取 ${stats.read} 条，生效 ${stats.applied} 条，跳过（重复）${stats.skipped} 条`);
  if (stats.retried) {
    console.log(`  处理失败待重试（保留在桶里）：${stats.retried} 条`);
  }
  const dropKeys = Object.keys(stats.dropped);
  if (dropKeys.length) {
    console.log('  丢弃：' + dropKeys.map(k => `${k} ${stats.dropped[k]}`).join('，'));
  } else {
    console.log('  丢弃：无');
  }
  for (const kind of Object.keys(stats.byKind)) {
    const b = stats.byKind[kind];
    console.log(`  - ${kind}: 生效 ${b.applied}，跳过 ${b.skipped}`);
  }
}

main().catch(err => {
  console.error('聚合脚本异常：', err);
  process.exit(1);
});
