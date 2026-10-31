// 单元测试：scripts/process-inbox.js 的防刷校验 validateInboxItem
// 覆盖：openid 格式/长度、kind 白名单、body schema、单对象大小上限、ts 窗口、合法样本。
// 注意：模块已加 require.main 守卫，require 时不会触发聚合主流程。

const assert = require('node:assert');
const test = require('node:test');
const { validateInboxItem } = require('../scripts/process-inbox.js');

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
