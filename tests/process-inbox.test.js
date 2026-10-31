// 单元测试：scripts/process-inbox.js
// 覆盖：validateInboxItem 防刷校验（openid/kind/schema/大小/ts 窗口），
//       以及 handleRating 用到的 applyRatingToCat 五维累加器。
// 注意：模块已加 require.main 守卫，require 时不会触发聚合主流程。

const assert = require('node:assert');
const test = require('node:test');
const { validateInboxItem, applyRatingToCat, normalizeDims } = require('../scripts/process-inbox.js');

const now = Date.now();
const KEY = 'inbox/like/1700000000000-openid-aaaaaaaa.json';

function body(obj) {
  return JSON.stringify(obj);
}

function validLike(overrides) {
  return body(Object.assign({
    v: 1,
    kind: 'like',
    openid: 'openid-aaaaaaaa',
    ts: now,
    data: { photo_id: 'p1', cat_id: 'c1', like: true },
  }, overrides));
}

test('合法样本：标准 like 通过校验', () => {
  const r = validateInboxItem(KEY, validLike());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.payload.kind, 'like');
});

test('大小上限：超过 4096 字节直接拒绝（too-large）', () => {
  const big = body({
    v: 1, kind: 'like', openid: 'openid-aaaaaaaa', ts: now,
    data: { photo_id: 'p1', blob: 'x'.repeat(5000) },
  });
  assert.ok(Buffer.byteLength(big, 'utf8') > 4096);
  assert.strictEqual(validateInboxItem(KEY, big).reason, 'too-large');
});

test('body schema：非法 JSON 拒绝（bad-json）', () => {
  assert.strictEqual(validateInboxItem(KEY, 'not json at all').reason, 'bad-json');
});

test('body schema：顶层非对象/数组拒绝（bad-shape）', () => {
  assert.strictEqual(validateInboxItem(KEY, body([1, 2, 3])).reason, 'bad-shape');
  assert.strictEqual(validateInboxItem(KEY, body('a-string')).reason, 'bad-shape');
});

test('body schema：v 必须为 1（bad-version）', () => {
  assert.strictEqual(validateInboxItem(KEY, validLike({ v: 2 })).reason, 'bad-version');
});

test('body schema：data 缺失或非对象拒绝（no-data）', () => {
  assert.strictEqual(validateInboxItem(KEY, validLike({ data: undefined })).reason, 'no-data');
  assert.strictEqual(validateInboxItem(KEY, validLike({ data: [1, 2] })).reason, 'no-data');
});

test('kind 白名单：未知 kind 拒绝（bad-kind）', () => {
  assert.strictEqual(validateInboxItem(KEY, validLike({ kind: 'evil' })).reason, 'bad-kind');
  assert.strictEqual(validateInboxItem(KEY, validLike({ kind: 'DROP' })).reason, 'bad-kind');
});

test('openid 格式：非字符串拒绝（bad-openid）', () => {
  assert.strictEqual(validateInboxItem(KEY, validLike({ openid: 12345 })).reason, 'bad-openid');
});

test('openid 格式：含非法字符拒绝（bad-openid）', () => {
  assert.strictEqual(validateInboxItem(KEY, validLike({ openid: 'bad.openid!' })).reason, 'bad-openid');
});

test('openid 长度：超过 64 字符拒绝（bad-openid）', () => {
  const longId = 'a'.repeat(65);
  assert.strictEqual(validateInboxItem(KEY, validLike({ openid: longId })).reason, 'bad-openid');
});

test('openid 长度：恰好 64 字符合法', () => {
  const okId = 'a'.repeat(64);
  const r = validateInboxItem(KEY, validLike({ openid: okId }));
  assert.strictEqual(r.ok, true);
});

test('ts 窗口：明显未来时间戳拒绝（ts-future）', () => {
  const future = now + 6 * 60 * 1000; // 超过 5 分钟容差
  assert.strictEqual(validateInboxItem(KEY, validLike({ ts: future })).reason, 'ts-future');
});

test('ts 窗口：超过 365 天的历史拒绝（ts-expired）', () => {
  const expired = now - (366 * 24 * 60 * 60 * 1000);
  assert.strictEqual(validateInboxItem(KEY, validLike({ ts: expired })).reason, 'ts-expired');
});

test('ts 窗口：非有限数字拒绝（bad-ts）', () => {
  assert.strictEqual(validateInboxItem(KEY, validLike({ ts: 'not-a-number' })).reason, 'bad-ts');
});

// ---------- applyRatingToCat：五维累加器 ----------

const DIMS = (a, b, c, d, e) => ({ r1: a, r2: b, r3: c, r4: d, r5: e });

test('normalizeDims：五项齐全且在 1-5 才有效', () => {
  assert.deepStrictEqual(normalizeDims(DIMS(5, 4, 3, 2, 1)), DIMS(5, 4, 3, 2, 1));
  assert.strictEqual(normalizeDims(undefined), null, '缺 dims 应返回 null');
  assert.strictEqual(normalizeDims(DIMS(5, 4, 3, 2, 0)), null, '越界整票丢弃');
  assert.strictEqual(normalizeDims({ r1: 5, r2: 4 }), null, '缺项整票丢弃');
  assert.strictEqual(normalizeDims(DIMS(5, 4, 3, 2, 2.5)), null, '非整数丢弃');
});

test('applyRatingToCat：第一票建立起 scores/dimAvg', () => {
  const r = {};
  applyRatingToCat(r, 0, null, 4, DIMS(5, 4, 3, 4, 3));
  assert.strictEqual(r.count, 1);
  assert.deepStrictEqual(r.scores, { r1: 0, r2: 0, r3: 0, r4: 1, r5: 0 });
  assert.strictEqual(r.avgScore, 4);
  assert.strictEqual(r.avgScoreDisp, '4.0');
  assert.deepStrictEqual(r.dimCounts, { r1: 1, r2: 1, r3: 1, r4: 1, r5: 1 });
  assert.deepStrictEqual(r.dimAvg, DIMS(5, 4, 3, 4, 3));
});

test('applyRatingToCat：多票时 dimAvg 是各维平均，不是得票计数', () => {
  const r = {};
  applyRatingToCat(r, 0, null, 5, DIMS(5, 5, 5, 5, 5));
  applyRatingToCat(r, 0, null, 3, DIMS(3, 3, 3, 3, 3));
  assert.deepStrictEqual(r.dimAvg, DIMS(4, 4, 4, 4, 4));
  // scores 必须是「综合分 = N 的票数」，和 dimAvg 完全不同的一组数
  assert.deepStrictEqual(r.scores, { r1: 0, r2: 0, r3: 1, r4: 0, r5: 1 });
  assert.strictEqual(r.count, 2);
});

test('applyRatingToCat：同一人改分 → 旧票被撤回，count 不虚高', () => {
  const r = {};
  applyRatingToCat(r, 0, null, 5, DIMS(5, 5, 5, 5, 5));
  // 该用户此前打了 5 分、五维全 5，现在改成 2 分、五维全 2
  applyRatingToCat(r, 5, DIMS(5, 5, 5, 5, 5), 2, DIMS(2, 2, 2, 2, 2));
  assert.strictEqual(r.count, 1, '还是一个人，总票数应为 1');
  assert.deepStrictEqual(r.scores, { r1: 0, r2: 1, r3: 0, r4: 0, r5: 0 });
  assert.deepStrictEqual(r.dimAvg, DIMS(2, 2, 2, 2, 2), '旧五维分必须被完整撤回');
});

test('applyRatingToCat：只有综合分（无 dims）时不影响 dimAvg', () => {
  const r = {};
  applyRatingToCat(r, 0, null, 4, DIMS(5, 5, 5, 5, 5));
  applyRatingToCat(r, 0, null, 2, null);
  assert.strictEqual(r.count, 2);
  assert.deepStrictEqual(r.dimAvg, DIMS(5, 5, 5, 5, 5), '无维度分的票不该拉低维度均分');
  assert.deepStrictEqual(r.dimCounts, { r1: 1, r2: 1, r3: 1, r4: 1, r5: 1 });
});

test('applyRatingToCat：撤回不会让累加器变成负数', () => {
  const r = {};
  applyRatingToCat(r, 0, null, 3, DIMS(3, 3, 3, 3, 3));
  // 传一个比实际更大的旧票，模拟日志与实际数据不同步
  applyRatingToCat(r, 5, DIMS(5, 5, 5, 5, 5), 4, DIMS(4, 4, 4, 4, 4));
  assert.strictEqual(r.dimSums.r1, 4);
  assert.strictEqual(r.dimCounts.r1, 1);
  assert.ok(r.scores.r5 >= 0);
});
