// 单元测试：miniprogram/utils/datasource.js
// 覆盖：_matchValue（含数组包含分支）、缓存/SWR、并发去重。
// 通过注入全局 wx 桩（存储 + 可编排 request）在 Node 下跑通，无需小程序运行时。

const assert = require('node:assert');
const test = require('node:test');
const { createJsonServerless, _matchValue } = require('../miniprogram/utils/datasource.js');

// ---- 轻量 wx 桩：内存存储 + 可编排的 request 响应 ----
function makeWx() {
  const store = new Map();
  let requestCount = 0;
  let responder = () => ({ statusCode: 200, data: { version: 'v1', items: [{ _id: 'a' }] } });

  const wx = {
    _store: store,
    _requestCount: () => requestCount,
    _setResponder(fn) { responder = fn; },
    getStorageSync(key) {
      const v = store.get(key);
      return v === undefined ? '' : v;
    },
    setStorageSync(key, value) { store.set(key, value); },
    removeStorageSync(key) { store.delete(key); },
    request(opts) {
      requestCount++;
      const res = responder(opts.url);
      // 模拟网络异步返回，便于观察并发去重
      queueMicrotask(() => {
        if (res && res.statusCode === 200) {
          if (opts.success) opts.success(res);
        } else if (opts.fail) {
          opts.fail({ errMsg: 'fail' });
        }
      });
    },
  };
  return wx;
}

test('前置：_matchValue 标量等值', () => {
  assert.strictEqual(_matchValue(5, 5), true);
  assert.strictEqual(_matchValue('x', 'x'), true);
  assert.strictEqual(_matchValue(5, 6), false);
  assert.strictEqual(_matchValue(null, undefined), false);
});

test('前置：_matchValue 对象条件按 JSON 等值', () => {
  assert.strictEqual(_matchValue({ a: 1 }, { a: 1 }), true);
  assert.strictEqual(_matchValue({ a: 1 }, { a: 2 }), false);
});

test('核心：_matchValue 数组字段 vs 标量条件 = 数组包含', () => {
  // 对应 MongoDB {tags:'x'} 语义：数组字段包含该值即匹配
  assert.strictEqual(_matchValue(['a', 'b'], 'a'), true);
  assert.strictEqual(_matchValue(['a', 'b'], 'c'), false);
  assert.strictEqual(_matchValue([1, 2, 3], 2), true);
  assert.strictEqual(_matchValue([], 'x'), false);
});

test('核心：_matchValue 操作符 $in / $nin / $ne', () => {
  assert.strictEqual(_matchValue('x', { $in: ['x', 'y'] }), true);
  assert.strictEqual(_matchValue('z', { $in: ['x', 'y'] }), false);
  assert.strictEqual(_matchValue('x', { $nin: ['x', 'y'] }), false);
  assert.strictEqual(_matchValue('z', { $nin: ['x', 'y'] }), true);
  assert.strictEqual(_matchValue('x', { $ne: 'y' }), true);
  assert.strictEqual(_matchValue('x', { $ne: 'x' }), false);
});

test('核心：_matchValue 正则（RegExp 直传 / $regex）', () => {
  assert.strictEqual(_matchValue('abc', /b/), true);
  assert.strictEqual(_matchValue('abc', /z/), false);
  assert.strictEqual(_matchValue('abc', { $regex: '^a' }), true);
  assert.strictEqual(_matchValue('abc', { $regex: '^z' }), false);
});

test('核心：_matchValue $gt/$gte/$lt/$lte/$exists', () => {
  assert.strictEqual(_matchValue(10, { $gt: 5 }), true);
  assert.strictEqual(_matchValue(10, { $gt: 10 }), false);
  assert.strictEqual(_matchValue(10, { $gte: 10 }), true);
  assert.strictEqual(_matchValue(10, { $lt: 20 }), true);
  assert.strictEqual(_matchValue(10, { $lte: 10 }), true);
  assert.strictEqual(_matchValue(undefined, { $exists: true }), false);
  assert.strictEqual(_matchValue(1, { $exists: true }), true);
  assert.strictEqual(_matchValue(undefined, { $exists: false }), true);
});

test('缓存/SWR：首次无缓存走网络，二次命中缓存不再请求', async () => {
  const wx = makeWx();
  global.wx = wx;
  const ds = createJsonServerless({ baseUrl: 'https://example.com' });
  const coll = ds.db.collection('cat');

  const r1 = await coll.find();
  assert.deepStrictEqual(r1.result, [{ _id: 'a' }]);
  assert.strictEqual(wx._requestCount(), 1, '首次应触发一次请求');

  const r2 = await coll.find();
  assert.deepStrictEqual(r2.result, [{ _id: 'a' }]);
  assert.strictEqual(wx._requestCount(), 1, '缓存命中不应再次请求');
});

test('缓存/SWR：旧缓存立即返回 + 后台静默刷新', async () => {
  const wx = makeWx();
  global.wx = wx;
  // 预置一份过期的旧缓存（fetchedAt=0，必然过期）
  wx.setStorageSync('ds_cache_cat', { version: '', items: [{ _id: 'old' }], fetchedAt: 0 });
  wx._setResponder(() => ({ statusCode: 200, data: { version: 'v2', items: [{ _id: 'new' }] } }));

  const ds = createJsonServerless({ baseUrl: 'https://example.com' });
  const coll = ds.db.collection('cat');

  // 立即返回旧缓存（stale-while-revalidate）
  const r1 = await coll.find();
  assert.deepStrictEqual(r1.result, [{ _id: 'old' }]);
  assert.strictEqual(wx._requestCount(), 1, '过期应触发后台刷新');

  // 等后台刷新落盘后，下一次读取应为新数据
  await new Promise(res => setImmediate(res));
  const r2 = await coll.find();
  assert.deepStrictEqual(r2.result, [{ _id: 'new' }]);
});

test('并发去重：同一集合并发加载只发一次网络请求', async () => {
  const wx = makeWx();
  global.wx = wx;
  const ds = createJsonServerless({ baseUrl: 'https://example.com' });
  const coll = ds.db.collection('cat');

  // 两个 find 同步发起，请求尚未 resolve 时应复用同一个 inflight promise
  const p1 = coll.find();
  const p2 = coll.find();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.deepStrictEqual(r1.result, [{ _id: 'a' }]);
  assert.deepStrictEqual(r2.result, [{ _id: 'a' }]);
  assert.strictEqual(wx._requestCount(), 1, '并发应去重为一次请求');
});

// ---- 演示数据模式下的管理员引导 ----
// 背景：data/user.json 只有 demo 种子账号时，新访客仍应拿到 manager=99，
// 否则填充演示数据后清缓存/换设备就再也看不到管理入口。

test('userOp：user 表为空且已拉取成功 → 首个用户 manager=99', async () => {
  const wx = makeWx();
  global.wx = wx;
  wx._setResponder(() => ({ statusCode: 200, data: { version: 'v1', items: [] } }));
  const ds = createJsonServerless({ baseUrl: 'https://example.com' });

  const res = await ds.function.invoke('userOp', { op: 'get' });
  assert.strictEqual(res.result.manager, 99);
});

test('userOp：user 表只有 demo 种子账号 → 新访客仍为 manager=99', async () => {
  const wx = makeWx();
  global.wx = wx;
  wx._setResponder(() => ({
    statusCode: 200,
    data: { version: 'v1', items: [{ _id: 'demo-user-1', openid: 'demo-openid-1', manager: 0 }] },
  }));
  const ds = createJsonServerless({ baseUrl: 'https://example.com' });

  const res = await ds.function.invoke('userOp', { op: 'get' });
  assert.strictEqual(res.result.manager, 99, '演示数据期新访客应拿到管理员');
});

test('userOp：user 表出现真实用户后 → 新访客 manager=0（引导失效）', async () => {
  const wx = makeWx();
  global.wx = wx;
  wx._setResponder(() => ({
    statusCode: 200,
    data: {
      version: 'v1',
      items: [
        { _id: 'demo-user-1', openid: 'demo-openid-1', manager: 0 },
        { _id: 'local_real_1', openid: 'guest_real', manager: 0 },
      ],
    },
  }));
  const ds = createJsonServerless({ baseUrl: 'https://example.com' });

  const res = await ds.function.invoke('userOp', { op: 'get' });
  assert.strictEqual(res.result.manager, 0, '一旦有非 demo 用户，不应再自动提权');
});
