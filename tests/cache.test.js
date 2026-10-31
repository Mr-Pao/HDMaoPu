// 单元测试：miniprogram/utils/cache.js
// 覆盖：频控（内存缓存避免重复读存储）、过期逻辑（存储 expire_date）、nocache、日期缓存。

const assert = require('node:assert');
const test = require('node:test');
const { mock } = require('node:test');
const {
  getCacheItem,
  setCacheItem,
  getCacheDate,
  setCacheDate,
  cacheTime,
} = require('../miniprogram/utils/cache.js');

// ---- wx 桩：内存存储 + 统计 getStorageSync 调用次数（用于验证频控/命中）----
function makeWx() {
  const store = new Map();
  let getCount = 0;
  return {
    _store: store,
    _getCount: () => getCount,
    getStorageSync(key) {
      getCount++;
      const v = store.get(key);
      return v === undefined ? '' : v;
    },
    setStorageSync(key, value) { store.set(key, value); },
    removeStorageSync(key) { store.delete(key); },
  };
}

test('set/get 往返：写入后未过期可读取', () => {
  const wx = makeWx();
  global.wx = wx;
  setCacheItem('k1', { hello: 'world' }, 24);
  assert.deepStrictEqual(getCacheItem('k1'), { hello: 'world' });
});

test('过期逻辑：存储 expire_date 已过则失效并清理', () => {
  const wx = makeWx();
  global.wx = wx;
  // 直接种入一份已过期的存储项
  wx._store.set('k2', {
    item: 'stale',
    expire_date: new Date(Date.now() - 1000).toISOString(),
  });
  assert.strictEqual(getCacheItem('k2'), undefined);
  // 过期项应被移除
  assert.strictEqual(wx.getStorageSync('k2'), '');
});

test('频控/命中：内存缓存命中时不落存储（不重复 getStorageSync）', () => {
  const wx = makeWx();
  global.wx = wx;
  // 直接种入存储（冷内存），首次读取会回填内存并读一次存储
  wx._store.set('k3', { item: 'v', expire_date: new Date(Date.now() + 3600 * 1000).toISOString() });
  assert.strictEqual(getCacheItem('k3'), 'v'); // 首次：内存未命中 → 读存储（getCount=1）
  assert.strictEqual(getCacheItem('k3'), 'v'); // 二次：内存命中 → 不再读存储
  assert.strictEqual(wx._getCount(), 1, '内存命中应跳过存储读取');
});

test('nocache 选项：跳过缓存直接返回 undefined', () => {
  const wx = makeWx();
  global.wx = wx;
  setCacheItem('k4', 'v', 24);
  assert.strictEqual(getCacheItem('k4', { nocache: true }), undefined);
  // nocache 不应污染内存缓存，普通读仍能命中
  assert.strictEqual(getCacheItem('k4'), 'v');
});

test('内存 TTL：超过 MEMORY_TTL 后内存失效，回退到存储', () => {
  mock.timers.enable(['Date']);
  try {
    mock.timers.setTime(0);
    const wx = makeWx();
    global.wx = wx;
    // 直接种入存储（冷内存）；存储 expire_date 设为 100h 后，远大于本次测试窗口
    wx._store.set('k5', { item: 'v', expire_date: new Date(100 * 3600 * 1000).toISOString() });
    assert.strictEqual(getCacheItem('k5'), 'v'); // 冷内存 → 读存储，回填内存（getCount=1）
    assert.strictEqual(wx._getCount(), 1);

    mock.timers.setTime(70000); // 超过内存 TTL(60000)，但存储仍有效
    assert.strictEqual(getCacheItem('k5'), 'v', '应回退到尚未过期的存储');
    assert.strictEqual(wx._getCount(), 2, '内存失效后应再次读存储');
  } finally {
    mock.timers.reset();
  }
});

test('日期缓存 getCacheDate/setCacheDate 往返', () => {
  const wx = makeWx();
  global.wx = wx;
  const d = new Date('2026-01-01T00:00:00Z');
  setCacheDate('d1', d);
  const got = getCacheDate('d1');
  assert.ok(got instanceof Date);
  assert.strictEqual(got.toISOString(), d.toISOString());
  assert.strictEqual(getCacheDate('missing'), undefined);
});

test('cacheTime 导出且为对象', () => {
  assert.ok(cacheTime && typeof cacheTime === 'object');
  assert.strictEqual(typeof cacheTime.catItem, 'number');
});
