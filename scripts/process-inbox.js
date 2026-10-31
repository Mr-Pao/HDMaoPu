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

// 单个对象的体积上限，超过直接丢弃（正常 payload 都在 500 字节内）
const MAX_OBJECT_BYTES = 4096;
// 单次运行内，单个 openid 最多处理多少条
const MAX_PER_OPENID = 200;
// 审核队列保留条数
const REVIEW_KEEP = 200;
// 批量删除单次上限
const DELETE_BATCH = 1000;

const VALID_KINDS = ['like', 'follow', 'pop', 'rating', 'comment', 'decision', 'manage'];

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
    fs.writeFileSync(dataFile(name), JSON.stringify(obj, null, 2) + '\n', 'utf8');
    written.push(name);
  }
  return written;
}

function findItem(name, id) {
  const data = loadData(name);
  return data.items.find(it => it && it._id === id);
}

// ---------------------------------------------------------------------------
// 入站对象的解析与校验
// ---------------------------------------------------------------------------

function parseObject(key, body) {
  if (Buffer.byteLength(body, 'utf8') > MAX_OBJECT_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return { ok: false, reason: 'bad-json' };
  }
  if (!payload || payload.v !== 1) return { ok: false, reason: 'bad-version' };
  if (!VALID_KINDS.includes(payload.kind)) return { ok: false, reason: 'bad-kind' };
  if (typeof payload.openid !== 'string' || !payload.openid) {
    return { ok: false, reason: 'no-openid' };
  }
  if (!payload.data || typeof payload.data !== 'object') {
    return { ok: false, reason: 'no-data' };
  }
  return { ok: true, payload };
}

function tokenOk(token) {
  const expect = REVIEW_PASSCODE || '';
  if (!expect) return false;
  if (typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return false;
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
  const catId = p.data.cat_id;
  if (!catId) return 'drop:no-cat-id';
  const cat = findItem('cat', catId);
  if (!cat) return 'drop:cat-not-found';
  bumpCounter(cat, 'popularity', 1);
  markTouched('cat');
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
  const id = 'rv-' + ts + '-' + Math.random().toString(36).slice(2, 6);
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
        _id: 'cm-' + item.ts + '-' + Math.random().toString(36).slice(2, 6),
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
  queue.items.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const removed = queue.items.length - REVIEW_KEEP;
  queue.items = queue.items.slice(0, REVIEW_KEEP);
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
    perOpenid.set(p.openid, used + 1);

    // pop 只在单次运行内按 openid+cat 去重，不做跨天日志
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

    if (result.startsWith('ok')) stats.applied++;
    else if (result.startsWith('skip')) stats.skipped++;
    else {
      const reason = result.split(':')[1] || 'unknown';
      stats.dropped[reason] = (stats.dropped[reason] || 0) + 1;
    }

    stats.byKind[p.kind] = stats.byKind[p.kind] || { applied: 0, skipped: 0 };
    if (result.startsWith('ok')) stats.byKind[p.kind].applied++;
    else if (result.startsWith('skip')) stats.byKind[p.kind].skipped++;

    doneKeys.push(obj.key);
  }

  return doneKeys;
}

function newStats() {
  return { read: 0, applied: 0, skipped: 0, dropped: {}, byKind: {}, __popSeen: new Set() };
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
            keys.push(c.Key);
          }
          if (data && data.IsTruncated === 'true' && data.NextMarker) {
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
    console.log('入站对象（处理完应被删除）：' + keys.length + ' 个');
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
  const keys = await listInbox(cos);
  console.log(`inbox/ 下待处理对象：${keys.length} 个`);

  if (!keys.length) {
    console.log('没有待处理内容，结束。');
    return;
  }

  const objects = [];
  for (const key of keys) {
    try {
      objects.push({ key, body: await getObject(cos, key) });
    } catch (err) {
      console.error(`读取失败 ${key}：${err.message || err}`);
    }
  }

  processObjects(objects, stats);
  const trimmed = trimQueue();
  const written = flushData();

  printStats(stats);
  if (trimmed) console.log(`审核队列裁剪：移除 ${trimmed} 条超出上限的旧记录`);
  console.log('写入文件：' + (written.length ? written.join(', ') : '（无变化）'));

  try {
    await deleteKeys(cos, keys);
    console.log(`已从 inbox/ 删除 ${keys.length} 个对象`);
  } catch (err) {
    console.error('删除 inbox 对象失败（下次运行会重复处理，去重日志会自动拦住）：' + (err.message || err));
    process.exitCode = 1;
  }
}

function printStats(stats) {
  console.log('统计：');
  console.log(`  读取 ${stats.read} 条，生效 ${stats.applied} 条，跳过（重复）${stats.skipped} 条`);
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
