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

// ---------- adoptionOp：领养申请 ----------
// cloudApi.adoptionOp 之前根本不存在，三个领养页面一进来就是 TypeError。
// 这里按 datasource 的 invoke('unionOp', {unionAction:'adoptionOp'}) 口径验证整条链路。

function makeAdoptionDs(adoptionItems) {
  const wx = makeWx();
  global.wx = wx;
  wx._setResponder((url) => {
    if (url.indexOf('/data/adoption.json') >= 0) {
      return { statusCode: 200, data: { version: 'v1', items: adoptionItems } };
    }
    if (url.indexOf('/data/cat.json') >= 0) {
      return { statusCode: 200, data: { version: 'v1', items: [{ _id: 'demo-cat-1', name: '大橘' }] } };
    }
    return { statusCode: 200, data: { version: 'v1', items: [] } };
  });
  const ds = createJsonServerless({ baseUrl: 'https://example.com' });
  const call = (params, openid) => ds.function.invoke('unionOp', Object.assign(
    { unionAction: 'adoptionOp', openid: openid || 'openid-applicant' },
    params
  ));
  return { ds, call };
}

test('adoptionOp：不存在的操作不会抛异常，返回结构化失败', async () => {
  const { call } = makeAdoptionDs([]);
  const res = await call({ operation: 'nope' });
  assert.strictEqual(res.result.result, false);
  assert.ok(/未知操作/.test(res.result.msg));
});

test('adoptionOp apply：缺字段要拦下来', async () => {
  const { call } = makeAdoptionDs([]);
  const noName = await call({ operation: 'apply', data: { cat_id: 'demo-cat-1', contact: 'x', reason: 'y' } });
  assert.strictEqual(noName.result.result, false);

  const noCat = await call({ operation: 'apply', data: { applicant_name: '张三', contact: 'x', reason: 'y' } });
  assert.strictEqual(noCat.result.result, false);
});

test('adoptionOp：提交 → 我的列表能看到 → 撤销', async () => {
  const { call } = makeAdoptionDs([]);

  const applied = await call({
    operation: 'apply',
    data: { cat_id: 'demo-cat-1', applicant_name: '张三', contact: '13800000000', reason: '家里有院子' },
  });
  assert.strictEqual(applied.result.result, true, applied.result.msg);
  assert.ok(applied.result.id, '应返回新建申请的 id');

  const mine = await call({ operation: 'listMine' });
  assert.strictEqual(mine.result.result, true);
  assert.strictEqual(mine.result.data.length, 1);
  const item = mine.result.data[0];
  assert.strictEqual(item.status, 'pending');
  assert.strictEqual(item.cat_name, '大橘');
  assert.strictEqual(item.applicant_name, '张三');
  assert.ok(Array.isArray(item.timeline) && item.timeline.length === 1);

  const cancelled = await call({ operation: 'cancel', adoption_id: item._id });
  assert.strictEqual(cancelled.result.result, true);

  const after = await call({ operation: 'listMine' });
  assert.strictEqual(after.result.data[0].status, 'cancelled');
});

test('adoptionOp apply：同一只猫重复提交被拒绝', async () => {
  const { call } = makeAdoptionDs([]);
  const payload = {
    operation: 'apply',
    data: { cat_id: 'demo-cat-1', applicant_name: '张三', contact: '138', reason: '想养' },
  };
  await call(payload);
  const second = await call(payload);
  assert.strictEqual(second.result.result, false);
  assert.ok(/请勿重复提交/.test(second.result.msg));
});

test('adoptionOp cancel：不能撤销别人的申请', async () => {
  const { call } = makeAdoptionDs([{
    _id: 'a-1', _openid: 'openid-other', openid: 'openid-other',
    cat_id: 'demo-cat-1', status: 'pending', apply_time: '2026-10-01T00:00:00.000Z', timeline: [],
  }]);
  const res = await call({ operation: 'cancel', adoption_id: 'a-1' });
  assert.strictEqual(res.result.result, false);
  assert.ok(/只能撤销自己的/.test(res.result.msg));
});

test('adoptionOp review：受理后进入 reviewing，并记下审核人', async () => {
  const { call } = makeAdoptionDs([{
    _id: 'a-2', _openid: 'openid-applicant', openid: 'openid-applicant',
    cat_id: 'demo-cat-1', status: 'pending', apply_time: '2026-10-01T00:00:00.000Z', timeline: [],
  }]);

  const reviewing = await call({ operation: 'review', adoption_id: 'a-2', action: 'processing', note: '已联系' }, 'openid-admin');
  assert.strictEqual(reviewing.result.result, true);

  const list = await call({ operation: 'list', status: 'reviewing' });
  assert.strictEqual(list.result.data.length, 1);
  assert.strictEqual(list.result.data[0].status, 'reviewing');
  assert.strictEqual(list.result.data[0].reviewer, 'openid-admin');
  assert.strictEqual(list.result.data[0].review_note, '已联系');
});

test('adoptionOp review：未知 action 返回失败而不是静默成功', async () => {
  const { call } = makeAdoptionDs([{
    _id: 'a-3', _openid: 'openid-applicant', openid: 'openid-applicant',
    cat_id: 'demo-cat-1', status: 'pending', apply_time: '2026-10-01T00:00:00.000Z', timeline: [],
  }]);
  const res = await call({ operation: 'review', adoption_id: 'a-3', action: 'whatever' });
  assert.strictEqual(res.result.result, false);
});
