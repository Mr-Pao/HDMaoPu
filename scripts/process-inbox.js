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
 *      - 单对象体积上限 16384 字节前置拦截（list 阶段 + parse 阶段双重）
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
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
} = process.env;

const DRY = DRY_RUN === '1' || DRY_RUN === 'true';

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const INBOX_PREFIX = 'inbox/';
const SELFTEST_PREFIX = 'inbox/_selftest/';

// 单个对象的体积上限，超过直接丢弃（普通 payload 都在 500 字节内）。
// 注意：这个 too-large 前置拦截保留——单对象大小上限是防止 inbox 被大文件灌爆的
// 第一道闸门，list 阶段（main）和 parseObject 阶段双重检查。
// 2026-11-01 由 4096 放宽到 16384：公告 manageNews 的正文最长 800 字，UTF-8 中文
// 约 3 字节/字（2400 字节），再加上 9 张图的 photosPath/photosPathId 完整 COS URL
// （每条 ~95 字符，两个数组约 1700 字节）、coverPath/coverPathId、标题与 JSON 结构，
// 实测最坏情况会顶到 4096 以上；服务端 mainContent 上限放宽到 5000 字（15000 字节）
// 后 4096 必然误杀。16384 仍远小于 pending/* 的 512KB 照片闸门，防刷效果不变。
const MAX_OBJECT_BYTES = 16384;
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

const VALID_KINDS = ['like', 'follow', 'pop', 'rating', 'comment', 'decision', 'manage', 'photo'];

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

// 防刷校验入口：体积上限 + JSON 解析 + body schema + openid 格式 + kind 白名单 + ts 窗口。
// 抽成独立函数并导出，便于单元测试（process-inbox.test.js）直接断言各类拒绝原因，
// 原聚合入口 processObjects 仍通过别名 parseObject 调用，行为不变。
function validateInboxItem(key, body) {
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
  // photo kind 字段校验：photo_key 必须是以 pending/ 开头的字符串，cat_id 必须是字符串
  if (payload.kind === 'photo') {
    const { photo_key, cat_id } = payload.data;
    if (typeof photo_key !== 'string' || !photo_key.startsWith('pending/') || photo_key.length > 512) {
      return { ok: false, reason: 'bad-photo-key' };
    }
    if (typeof cat_id !== 'string' || !cat_id) {
      return { ok: false, reason: 'bad-cat-id' };
    }
  }
  return { ok: true, payload, ts };
}

// 兼容别名：聚合入口 processObjects 仍调用 parseObject，行为不变
function parseObject(key, body) {
  return validateInboxItem(key, body);
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

function writeLog(kind, openid, target, state, ts, extra) {
  const idx = getLogIndex();
  const key = logKey(kind, openid, target);
  // _id 必须存在：upload-data.js 会校验每一条都有 _id，缺了会导致整批上传中止
  const rec = { _id: key, k: key, kind, openid, target, state, ts };
  // 额外字段（目前只有 rating 的五维分）：随日志存下来，
  // 同一人重复评分时才可能把旧的五维分精确撤回，否则 dimAvg 会越漂越偏。
  if (extra && typeof extra === 'object') Object.assign(rec, extra);
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
  const like = data.like !== false;

  // 两种粒度共用 like 通道：
  //   带 photo_id → 照片点赞（photo.like_count）
  //   只带 cat_id → 猫咪点赞（cat.like_count）
  // 日志 key 分开写，避免同一 openid 的猫赞和照片赞互相覆盖。
  const photoId = data.photo_id;
  const catId = data.cat_id;

  if (!photoId) {
    if (!catId) return 'drop:no-photo-id';
    const cat = findItem('cat', catId);
    if (!cat) return 'drop:cat-not-found';

    const prevCat = readLog('catlike', openid, catId);
    if (prevCat && prevCat.state === like) return 'skip:duplicate';

    let catDelta = 0;
    if (prevCat) catDelta = like ? 1 : -1;
    else if (like) catDelta = 1;

    if (catDelta !== 0) bumpCounter(cat, 'like_count', catDelta);
    writeLog('catlike', openid, catId, like, ts);
    markTouched('cat');
    return 'ok';
  }

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

const DIM_KEYS = ['r1', 'r2', 'r3', 'r4', 'r5'];

// 五维分（猫德/颜值/社交/干饭/活力）规整。
// 有任何一项缺失或越界就整票丢弃维度分，返回 null——宁可少算一票维度分，
// 也不能把半截数据混进累加器（一旦混进去就没有办法再还原）。
function normalizeDims(dims) {
  if (!dims || typeof dims !== 'object') return null;
  const out = {};
  for (const k of DIM_KEYS) {
    const v = Number(dims[k]);
    if (!Number.isInteger(v) || v < 1 || v > 5) return null;
    out[k] = v;
  }
  return out;
}

// 把「一票评分」落到 cat.rating 上（纯计算，不读写 inbox_log）。
// prevState / prevDims 是该用户上一次的票，先撤回再记新票，所以重复评分不会让
// count 和 dimAvg 虚高。抽成独立函数是为了能单测——这段算术出错不会有任何报错，
// 只会让页面上的分数慢慢偏掉。
function applyRatingToCat(r, prevState, prevDims, score, dims) {
  if (!r.scores) r.scores = { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 };
  // 五维累加器：dimSums = 各维分数之和，dimCounts = 各维参评人数，
  // dimAvg = 对外暴露的每维平均分（页面「各项评分」读的就是它）。
  if (!r.dimSums) r.dimSums = { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 };
  if (!r.dimCounts) r.dimCounts = { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 };

  // 同一人重复评分：先撤掉旧分，再记新分
  if (prevState >= 1 && prevState <= 5) {
    r.scores['r' + prevState] = Math.max(0, Number(r.scores['r' + prevState] || 0) - 1);
    r.count = Math.max(0, Number(r.count || 0) - 1);
  }
  if (prevDims) {
    for (const k of DIM_KEYS) {
      r.dimSums[k] = Math.max(0, Number(r.dimSums[k] || 0) - prevDims[k]);
      r.dimCounts[k] = Math.max(0, Number(r.dimCounts[k] || 0) - 1);
    }
  }

  r.scores['r' + score] = Number(r.scores['r' + score] || 0) + 1;
  r.count = Number(r.count || 0) + 1;

  if (dims) {
    for (const k of DIM_KEYS) {
      r.dimSums[k] = Number(r.dimSums[k] || 0) + dims[k];
      r.dimCounts[k] = Number(r.dimCounts[k] || 0) + 1;
    }
  }

  // 重算综合均分
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

  // 重算五维均分
  const dimAvg = {};
  for (const k of DIM_KEYS) {
    const c = Number(r.dimCounts[k] || 0);
    dimAvg[k] = c ? Number((Number(r.dimSums[k] || 0) / c).toFixed(2)) : 0;
  }
  r.dimAvg = dimAvg;

  return r;
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

  const dims = normalizeDims(data.dims);
  const prev = readLog('rating', openid, catId);
  const prevDims = prev && normalizeDims(prev.dims);
  if (prev && prev.state === score) {
    // 分数没变、维度分也没变，才是真重复，直接跳过。
    if (!dims && !prevDims) return 'skip:duplicate';
    if (dims && prevDims && DIM_KEYS.every(k => prevDims[k] === dims[k])) return 'skip:duplicate';
  }

  applyRatingToCat(
    cat.rating,
    prev ? Number(prev.state) : 0,
    prevDims,
    score,
    dims
  );

  writeLog('rating', openid, catId, score, ts, dims ? { dims } : null);
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

// 照片审核：photo 的 inbox 元数据是小 JSON（只有 photo_key/cat_id 等字符串字段，
// 不含二进制），聚合后进 review_queue，并（非 DRY 且配了 GitHub 凭据时）建一个
// 「照片审核」Issue，正文夹带机器可读标记供 review.js 消费。
function handlePhoto(p) {
  const { openid, data, ts } = p;
  const photoKey = data.photo_key;
  const catId = data.cat_id;
  const queue = loadData('review_queue');
  const id = genId('rv', ts);
  queue.items.push({
    _id: id,
    kind: 'photo',
    openid,
    ts,
    status: 'pending',
    create_time: new Date(ts || Date.now()).toISOString(),
    data: {
      photo_key: photoKey,
      cat_id: catId,
      photographer: String(data.photographer || '').slice(0, 60),
      shooting_date: String(data.shooting_date || '').slice(0, 20),
    },
  });
  markTouched('review_queue');

  // 非 DRY 且配了 GitHub 凭据时，异步建「照片审核」Issue；建单失败不阻塞聚合（数据已入队）。
  if (!DRY && GITHUB_TOKEN && GITHUB_REPOSITORY) {
    createPhotoIssue({ photoKey, catId, openid, data, ts, queueId: id }).catch((err) => {
      console.error(`  [issue] 照片审核建单失败（不影响入队）：${err.message || err}`);
    });
  }

  return 'ok:queue';
}

// 建「照片审核」Issue。正文夹带 <!-- photo-key --> 和 <!-- photo-cat-id --> 两个
// 机器可读标记：review.js 靠它们定位 pending 对象和归属猫（新 key 格式不含 cat_id）。
async function createPhotoIssue({ photoKey, catId, openid, data, ts, queueId }) {
  const ext = (photoKey.split('.').pop() || 'jpg').toLowerCase();
  const body = [
    '待审照片（匿名直传）',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    `| 猫 ID | \`${catId}\` |`,
    `| 摄影师 | ${data.photographer || '未填写'} |`,
    `| 拍摄日期 | ${data.shooting_date || '未填写'} |`,
    `| 上传者 | \`${openid}\` |`,
    `| 对象路径 | \`${photoKey}\` |`,
    `| 审核队列 ID | \`${queueId}\` |`,
    '',
    '---',
    '评论 `/ok` 通过（移动到 photos/ 并公开），评论 `/no` 驳回（移动到 rejected/）。',
    '',
    `<!-- photo-key: ${photoKey} -->`,
    `<!-- photo-cat-id: ${catId} -->`,
    `<!-- photo-openid: ${openid} -->`,
    `<!-- photo-photographer: ${data.photographer || ''} -->`,
    `<!-- photo-shooting-date: ${data.shooting_date || ''} -->`,
  ].join('\n');
  const title = `[照片审核] ${catId} · ${ext}`;
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'maopu-process-inbox',
    },
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`创建 Issue 失败 ${res.status}: ${text.slice(0, 300)}`);
  }
  const issue = await res.json();
  console.log(`  [issue] 已建照片审核单 #${issue.number}（${title}）`);
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
  if (data.action === 'saveFriendLinks') return manageSaveFriendLinks(data);
  if (data.action === 'manageNews') return manageNews(data);
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

// 友情链接：整体覆盖 setting 里 _id='friendLink' 的 apps。
// 管理端是「增删后整批提交」，天然处理并发覆盖；这里只做服务端校验。
const FRIEND_LINK_MAX = 20;
const APPID_RE = /^wx[0-9a-zA-Z]{16}$/;

function normalizeFriendApp(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const appid = typeof raw.appid === 'string' ? raw.appid.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const logo = typeof raw.logo === 'string' ? raw.logo.trim() : '';
  if (!APPID_RE.test(appid)) return null;
  if (!name || name.length > 20) return null;
  if (logo.length > 300) return null;
  return { appid, name, logo };
}

// 友链 Logo 的公开地址：管理端选图后先匿名直传到 pending/（客户端零密钥），
// 聚合时复制到 photos/friendlink/<appid>.<ext> 并给 public-read，再把 logo 换成完整 URL。
// 这样小程序里 <image src> 直接可用，且没有把上传密钥下发到客户端。
const FRIEND_LOGO_PREFIX = 'photos/friendlink/';

function publicUrlOf(key) {
  // DRY_RUN 下通常没配 COS 环境变量，给个占位域名，只为了自测 trace 能看出结构
  const bucket = COS_BUCKET || 'maopu-bucket';
  const region = COS_REGION || 'ap-guangzhou';
  return `https://${bucket}.cos.${region}.myqcloud.com/${key}`;
}

// COS 的 CopySource 要 `<bucket>-<appid>.cos.<region>.myqcloud.com/<key>`，
// SDK 内部只 decode 不 encode，key 必须按 / 分段编码（和 review.js 保持一致）。
function copySourceOf(key) {
  return `${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function contentTypeOfKey(key) {
  const ext = String(key).split('.').pop().toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

function extOfKey(key) {
  const ext = String(key).split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return 'jpg';
}

function putObjectCopy(cos, fromKey, toKey) {
  return new Promise((resolve, reject) => {
    cos.putObjectCopy(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: toKey,
        CopySource: copySourceOf(fromKey),
        MetadataDirective: 'Replaced',
        Headers: {
          'Content-Type': contentTypeOfKey(toKey),
          'x-cos-metadata-directive': 'Replaced',
          'x-cos-acl': 'public-read',
        },
      },
      (err, data) => (err ? reject(err) : resolve(data))
    );
  });
}

function deleteObject(cos, key) {
  return new Promise((resolve, reject) => {
    cos.deleteObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (err, data) =>
      err ? reject(err) : resolve(data)
    );
  });
}

async function manageSaveFriendLinks(data) {
  const apps = data.apps;
  if (!Array.isArray(apps)) return 'drop:no-apps';

  const seen = {};
  const cleaned = [];
  const pendingLogoApps = [];
  for (const raw of apps) {
    const item = normalizeFriendApp(raw);
    if (!item) return 'drop:bad-friend-app';
    if (seen[item.appid]) continue;
    seen[item.appid] = true;
    if (item.logo && item.logo.startsWith('pending/')) pendingLogoApps.push(item);
    cleaned.push(item);
    if (cleaned.length > FRIEND_LINK_MAX) return 'drop:too-many-links';
  }

  // 先落图片再改数据：复制失败就整条返回 error 让 inbox 对象留到下轮重试，
  // 不会出现「setting 里写着 URL、COS 上却没有对象」的空引用。
  if (pendingLogoApps.length) {
    const cos = DRY ? null : cosClient();
    for (const item of pendingLogoApps) {
      const targetKey = `${FRIEND_LOGO_PREFIX}${item.appid}.${extOfKey(item.logo)}`;
      if (!DRY) {
        try {
          await putObjectCopy(cos, item.logo, targetKey);
        } catch (err) {
          console.error(`  [friendlink] 复制 Logo 失败 ${item.logo} → ${targetKey}：${err.message || err}`);
          return 'error:logo-copy';
        }
        // 复制成功后删掉 pending 原件；删除失败只警告（最坏情况是留个孤儿对象）
        try {
          await deleteObject(cos, item.logo);
        } catch (err) {
          console.warn(`  [friendlink] 删除 pending 原件失败（忽略）：${item.logo} ${err.message || err}`);
        }
      }
      item.logo = publicUrlOf(targetKey);
    }
  }

  const setting = loadData('setting');
  const record = setting.items.find(it => it && it._id === 'friendLink');
  if (record) record.apps = cleaned;
  else setting.items.push({ _id: 'friendLink', apps: cleaned });

  markTouched('setting');
  return 'ok:friend-links';
}

// ---------------------------------------------------------------------------
// 公告（news）增删改：客户端 manageNews → inbox/manage/ → 这里
//
// 为什么必须是服务端生成 _id 和 date：
//   - _id 由客户端给会和聚合端的其它写入撞车，也挡不住伪造已有 _id 覆盖别人的公告。
//   - date 是发布时间，客户端传会被人改手机时间伪造，一律用服务端当前时间。
//   - update 走白名单：_id / date / show 都不允许客户端改。
// ---------------------------------------------------------------------------

// 分类枚举：与 miniprogram/pages/news/news.js 的筛选按钮一致。
// 「全部」是筛选用的假分类，不在枚举里——传进来按非法处理。
const NEWS_CLASSES = ['领养', '救助', '活动', '其他'];
const NEWS_TITLE_MAX = 30;
// 客户端限制 800 字，服务端放宽到 5000 留余地（邮件客户端/旧版本提交的长文不误杀）
const NEWS_CONTENT_MAX = 5000;
const NEWS_NICKNAME_MAX = 30;
const NEWS_PHOTOS_MAX = 9;
const NEWS_PATH_MAX = 400;

// 可被 update 覆盖的字段白名单（_id / date / show 刻意不在其中）
const NEWS_UPDATE_FIELDS = [
  'title',
  'mainContent',
  'class',
  'setNewsModal',
  'coverPath',
  'photosPath',
  'photosPathId',
  'coverPathId',
  'dateLastModify',
  'userNicknameLastModify',
];

function newsString(v, max) {
  if (typeof v !== 'string') return null;
  if (v.length > max) return null;
  return v;
}

// 路径字段：可空字符串，非空时必须是 http(s) URL 或 / 开头的站内路径。
// 不校验的话客户端可以把 javascript: / 任意超长串写进 data/news.json，
// detailNews 直接拿去 wx.previewImage / image src。
function newsPath(v) {
  if (v == null || v === '') return '';
  const s = newsString(v, NEWS_PATH_MAX);
  if (s === null) return null;
  if (!/^(https?:\/\/|\/)/.test(s)) return null;
  return s;
}

// photosPath / photosPathId：必须是数组，元素为字符串，空串元素剔除。
// detailNews 直接 photosPath.map(...)，传非数组会崩，所以这里必须兜住。
function newsPathList(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) return null;
  if (v.length > NEWS_PHOTOS_MAX) return null;
  const out = [];
  for (const raw of v) {
    const s = newsPath(raw);
    if (s === null) return null;
    if (s) out.push(s);
  }
  return out;
}

// 校验并规整「一条公告的可写字段」。partial=true 时只处理出现的字段（update 用）。
// 返回 null 表示这条数据不合法，调用方统一回 'drop:bad-news'。
function normalizeNewsFields(raw, partial) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const has = k => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] !== undefined;

  if (has('title') || !partial) {
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    // 标题必填且非空（空标题在列表页是一行空白，无法辨认）
    if (!title) return null;
    if (title.length > NEWS_TITLE_MAX) return null;
    out.title = title;
  }

  if (has('mainContent') || !partial) {
    if (raw.mainContent == null) {
      out.mainContent = '';
    } else {
      const s = newsString(raw.mainContent, NEWS_CONTENT_MAX);
      if (s === null) return null;
      out.mainContent = s;
    }
  }

  if (has('class') || !partial) {
    const cls = typeof raw.class === 'string' ? raw.class.trim() : '';
    // 「全部」是筛选用的假分类，不在 NEWS_CLASSES 里，会在这里被拒
    if (!NEWS_CLASSES.includes(cls)) return null;
    out.class = cls;
  }

  if (has('setNewsModal') || !partial) {
    if (raw.setNewsModal != null && typeof raw.setNewsModal !== 'boolean') return null;
    out.setNewsModal = raw.setNewsModal === true;
  }

  if (has('coverPath') || !partial) {
    const s = newsPath(raw.coverPath);
    if (s === null) return null;
    out.coverPath = s;
  }

  if (has('coverPathId') || !partial) {
    const s = newsPath(raw.coverPathId);
    if (s === null) return null;
    out.coverPathId = s;
  }

  if (has('photosPath') || !partial) {
    const list = newsPathList(raw.photosPath);
    if (list === null) return null;
    out.photosPath = list;
  }

  if (has('photosPathId') || !partial) {
    const list = newsPathList(raw.photosPathId);
    if (list === null) return null;
    out.photosPathId = list;
  }

  if (has('dateLastModify')) {
    const s = newsString(raw.dateLastModify, 40);
    if (s === null) return null;
    out.dateLastModify = s;
  }

  if (has('userNicknameLastModify')) {
    const s = typeof raw.userNicknameLastModify === 'string'
      ? raw.userNicknameLastModify.trim().slice(0, NEWS_NICKNAME_MAX)
      : '';
    out.userNicknameLastModify = s || '匿名猫友';
  }

  return out;
}

// 公告 _id：优先从 ASCII 标题做可读 slug（news-xxx），中文标题退回 news-<ts36>。
// 冲突时依次加 -2 / -3……，保证唯一。
function genNewsId(title) {
  const news = loadData('news');
  const used = new Set(news.items.filter(it => it && it._id).map(it => it._id));
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const head = slug ? `news-${slug}` : `news-${Date.now().toString(36)}`;
  if (!used.has(head)) return head;
  for (let i = 2; i < 1000; i++) {
    const id = `${head}-${i}`;
    if (!used.has(id)) return id;
  }
  return `news-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function manageNews(data) {
  const op = data.op;
  if (op !== 'add' && op !== 'update' && op !== 'remove') return 'drop:bad-op';

  const news = loadData('news');

  if (op === 'add') {
    const fields = normalizeNewsFields(data.news, false);
    if (!fields) return 'drop:bad-news';

    // 昵称由提交者自填，空则兜底「猫谱管理员」（公告本来就是管理员发的）
    const rawNick = data.news.userNickname;
    const nickname = typeof rawNick === 'string' && rawNick.trim()
      ? rawNick.trim().slice(0, NEWS_NICKNAME_MAX)
      : '猫谱管理员';

    const now = new Date();
    const id = genNewsId(fields.title);
    news.items.push({
      _id: id,
      userNickname: nickname,
      userNicknameLastModify: nickname,
      title: fields.title,
      class: fields.class,
      // 发布时间由服务端决定，不信客户端传的 date
      date: now.toISOString(),
      mainContent: fields.mainContent,
      coverPath: fields.coverPath || '',
      coverPathId: fields.coverPathId || '',
      photosPath: fields.photosPath || [],
      photosPathId: fields.photosPathId || [],
      setNewsModal: fields.setNewsModal === true,
      // news 记录必须带 show 布尔（列表页/详情页都读它），新增默认展示
      show: true,
    });
    markTouched('news');
    return 'ok:news-add';
  }

  // update / remove 都要先定位记录
  const newsId = data.news_id;
  if (typeof newsId !== 'string' || !newsId) return 'drop:no-news-id';
  const item = news.items.find(it => it && it._id === newsId);
  if (!item) return 'drop:no-news';

  if (op === 'remove') {
    news.items.splice(news.items.indexOf(item), 1);
    markTouched('news');
    return 'ok:news-remove';
  }

  // update：只允许白名单字段，白名单外的键直接忽略（客户端还带 openidLastModify，
  // data/user.json 里没有它的位置，忽略即丢弃）。
  const raw = data.news;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'drop:bad-news';
  const patch = {};
  for (const k of Object.keys(raw)) {
    if (NEWS_UPDATE_FIELDS.includes(k)) patch[k] = raw[k];
  }
  if (!Object.keys(patch).length) return 'drop:bad-news';

  const fields = normalizeNewsFields(patch, true);
  if (!fields) return 'drop:bad-news';

  for (const k of Object.keys(fields)) {
    if (!NEWS_UPDATE_FIELDS.includes(k)) continue;
    item[k] = fields[k];
  }
  // 最后修改时间兜底：客户端没传或传了空串就用服务端时间
  if (!item.dateLastModify) item.dateLastModify = new Date().toISOString();
  markTouched('news');
  return 'ok:news-update';
}

const HANDLERS = {
  like: handleLike,
  follow: handleFollow,
  pop: handlePop,
  rating: handleRating,
  comment: handleComment,
  photo: handlePhoto,
  decision: handleDecision,
  manage: handleManage,
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function processObjects(objects, stats) {
  const perOpenid = new Map();
  const doneKeys = [];

  for (const obj of objects) {    stats.read++;
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
      result = await HANDLERS[p.kind](p);
    } catch (err) {
      result = 'error:' + (err && err.message ? err.message : String(err));
    }

    stats.byKind[p.kind] = stats.byKind[p.kind] || { applied: 0, skipped: 0 };
    // DRY_RUN 下留一份逐条结果，自测能直接看到每条用例是 ok 还是 drop
    if (DRY) stats.__trace.push(`${obj.key.split('/').pop()} [${p.kind}] → ${result}`);

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
  return { read: 0, applied: 0, skipped: 0, retried: 0, dropped: {}, byKind: {}, __popSeen: new Set(), __trace: [] };
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
    mk('photo', 'openid-a', { photo_key: 'pending/openid-a-12345.jpg', cat_id: cat, photographer: '自测', shooting_date: '2026-05-10' }, 20),
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
    mk('manage', 'openid-a', {
      action: 'saveFriendLinks',
      token: REVIEW_PASSCODE || 'wrong',
      apps: [{ appid: 'wx5bd705b2bc91c73b', name: '笃行猫谱（自测）', logo: '/pages/public/images/system/zdmp.png' }],
    }, 21),
    mk('manage', 'openid-a', {
      action: 'saveFriendLinks',
      token: REVIEW_PASSCODE || 'wrong',
      apps: [{ appid: 'not-an-appid', name: '坏数据' }],
    }, 22), // 非法 appid，整条拒绝

    // ---- 公告（manageNews）自测 ----
    // 标题带 ASCII 时 _id 走 slug，是确定值（'自测公告 self-test' → news-self-test），
    // 后面的 update/remove 才能稳定指向同一条。
    mk('manage', 'openid-a', {
      action: 'manageNews',
      token: REVIEW_PASSCODE || 'wrong',
      op: 'add',
      news: { title: '自测公告 self-test', class: '活动', mainContent: '自测正文：新增' },
    }, 23),
    mk('manage', 'openid-a', {
      action: 'manageNews',
      token: REVIEW_PASSCODE || 'wrong',
      op: 'update',
      news_id: 'news-self-test',
      news: { title: '自测公告（已改）', class: '其他', dateLastModify: '' },
    }, 24), // 只覆盖白名单字段
    mk('manage', 'openid-a', {
      action: 'manageNews',
      token: REVIEW_PASSCODE || 'wrong',
      op: 'remove',
      news_id: 'news-self-test',
    }, 25),
    mk('manage', 'openid-a', {
      action: 'manageNews',
      token: REVIEW_PASSCODE || 'wrong',
      op: 'add',
      news: { title: '自测公告（保留）', class: '救助', mainContent: '这条留在新闻表里供快照查看' },
    }, 26), // 留着，snapshot 里能看到
    mk('manage', 'openid-a', {
      action: 'manageNews',
      token: REVIEW_PASSCODE || 'wrong',
      op: 'add',
      news: { title: '坏分类公告', class: '全部' }, // 「全部」是筛选假分类，应被丢弃
    }, 27),
    mk('manage', 'openid-a', {
      action: 'manageNews',
      token: REVIEW_PASSCODE || 'wrong',
      op: 'update',
      news_id: 'news-does-not-exist',
      news: { title: '改不存在的公告' },
    }, 28), // 找不到记录，应被丢弃
    mk('manage', 'openid-a', {
      action: 'manageNews',
      token: 'definitely-wrong-token',
      op: 'add',
      news: { title: '口令错不该写入', class: '其他' },
    }, 29), // 口令错，整条丢弃

    // ---- 友情链接 Logo 选图上传（pending/ → photos/friendlink/）----
    // DRY 下不真发 COS 请求，只验证「pending/ 开头的 logo 会被改写成完整公网 URL」。
    mk('manage', 'openid-a', {
      action: 'saveFriendLinks',
      token: REVIEW_PASSCODE || 'wrong',
      apps: [{ appid: 'wx5bd705b2bc91c73b', name: '带图友链', logo: 'pending/openid-a-99999.jpg' }],
    }, 30),
  ];
}

function snapshot() {
  const cat = findItem('cat', 'demo-cat-1');
  const photo = findItem('photo', 'demo-photo-1');
  const friendLink = findItem('setting', 'friendLink');
  return {
    catPop: cat ? cat.popularity : null,
    catFollow: cat ? cat.follow_count : null,
    catRating: cat ? JSON.stringify(cat.rating) : null,
    catName: cat ? cat.name : null,
    catHabit: cat ? cat.habit : null,
    photoLike: photo ? photo.like_count : null,
    photoHidden: photo ? !!photo.hidden : null,
    friendLinks: friendLink ? JSON.stringify((friendLink.apps || []).map(a => a.name)) : null,
    friendLogos: friendLink ? JSON.stringify((friendLink.apps || []).map(a => a.logo || '')) : null,
    newsTitles: JSON.stringify(loadData('news').items.map(it => it.title)),
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

    const keys = await processObjects(selftestObjects(), stats);
    trimQueue();

    console.log('聚合后状态：' + JSON.stringify(snapshot()));
    console.log('----------------------------------------');
    console.log('逐条结果：');
    for (const line of stats.__trace) console.log('  ' + line);
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
  const doneKeys = await processObjects(objects, stats);
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

// 仅当作为脚本直接运行时才执行聚合主流程；被单元测试 require 时不触发，
// 避免测试引入时误跑 COS 操作 / 文件写入。
if (require.main === module) {
  main().catch(err => {
    console.error('聚合脚本异常：', err);
    process.exit(1);
  });
}

module.exports = { validateInboxItem, applyRatingToCat, normalizeDims };
