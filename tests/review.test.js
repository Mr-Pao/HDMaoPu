// 单元测试：miniprogram/utils/review.js 的审核态判定（版本号门禁）
// 语义：包内版本号（config.app_version）在 COS 的 normalVersions 白名单里 → 正常态；
//       不在、或白名单为空以外的任何异常 → 审核态。devtools 永远放行。
// 只测纯函数，不碰网络。

const assert = require('node:assert');
const test = require('node:test');

let envVersion = 'develop';
let accountInfoThrows = false;

// review.js 顶层 require 了 config（会 require appSecret.js），且判定时读 wx
global.wx = {
  getAccountInfoSync() {
    if (accountInfoThrows) throw new Error('not supported');
    return { miniProgram: { envVersion } };
  },
  getStorageSync() {
    return '';
  },
  setStorageSync() {},
  removeStorageSync() {},
};

const review = require('../miniprogram/utils/review.js');
const config = require('../miniprogram/config.js');

const APP_VERSION = config.app_version;

function setEnv(v) {
  envVersion = v;
  accountInfoThrows = false;
}

// ---- 核心：版本号对得上才正常 ----

test('release：包内版本号在白名单里 = 正常态', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule({ normalVersions: [APP_VERSION] }), false);
});

test('release：包内版本号不在白名单 = 审核态', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule({ normalVersions: ['v9.9.9'] }), true);
});

test('release：白名单有多个时命中任一即正常', () => {
  setEnv('release');
  assert.strictEqual(
    review.applyVersionRule({ normalVersions: ['v9.9.9', APP_VERSION, 'v0.0.1'] }),
    false
  );
});

test('develop（审核员）：新包版本号对不上 = 审核态', () => {
  setEnv('develop');
  assert.strictEqual(review.applyVersionRule({ normalVersions: ['v0.0.9'] }), true);
});

test('develop：版本号恰好对上 = 正常态（审核员也可能拿旧包）', () => {
  setEnv('develop');
  assert.strictEqual(review.applyVersionRule({ normalVersions: [APP_VERSION] }), false);
});

test('trial（体验版）：同样按版本号判定', () => {
  setEnv('trial');
  assert.strictEqual(review.applyVersionRule({ normalVersions: ['v0.0.9'] }), true);
  assert.strictEqual(review.applyVersionRule({ normalVersions: [APP_VERSION] }), false);
});

test('devtools：永远正常态（本机开发不受影响）', () => {
  setEnv('devtools');
  assert.strictEqual(review.applyVersionRule({ normalVersions: ['v9.9.9'] }), false);
});

// ---- 门禁未启用 / 异常兜底 ----

test('白名单为空 = 门禁未启用 = 正常态', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule({ normalVersions: [] }), false);
});

test('白名单全是空白项 → 过滤后为空 → 正常态', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule({ normalVersions: ['  ', ''] }), false);
});

test('远端配置为空 / 非法 / 字段缺失：一律正常态', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule(null), false);
  assert.strictEqual(review.applyVersionRule(undefined), false);
  assert.strictEqual(review.applyVersionRule('oops'), false);
  assert.strictEqual(review.applyVersionRule({}), false);
});

test('白名单里的数字项被规范化成字符串再比对', () => {
  setEnv('release');
  // 4 与 "4" 不等 —— 版本号是带 v 的字符串，这里只验证不会崩
  assert.strictEqual(review.applyVersionRule({ normalVersions: [4] }), true);
});

// ---- 兼容老配置（SpaceLaunch 语义，仅兜底） ----

test('老配置 reviewVersions 非空 = 审核态', () => {
  setEnv('develop');
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ['v1.0.0'] }), true);
});

test('老配置 reviewVersions 为空 = 正常态', () => {
  setEnv('develop');
  assert.strictEqual(review.applyVersionRule({ reviewVersions: [] }), false);
});

test('更老的布尔 review 仍被识别', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule({ review: true }), true);
  assert.strictEqual(review.applyVersionRule({ review: false }), false);
});

test('normalVersions 优先于老字段：同时存在时按 normalVersions 判', () => {
  setEnv('release');
  assert.strictEqual(
    review.applyVersionRule({ normalVersions: [APP_VERSION], reviewVersions: ['v9.9.9'] }),
    false
  );
});

// ---- 环境与版本号读取 ----

test('getAccountInfoSync 不存在：按 devtools 放行', () => {
  accountInfoThrows = true;
  assert.strictEqual(review.envName(), 'devtools');
  assert.strictEqual(review.applyVersionRule({ normalVersions: ['v1.0.0'] }), false);
});

test('runtimeVersion 就等于 config.app_version（包内版本，不依赖线上 version）', () => {
  setEnv('release');
  assert.strictEqual(review.runtimeVersion(), APP_VERSION);
});

test('onlineVersion 在开发版/体验版为空串时返回空串，不回落包内版本', () => {
  setEnv('develop');
  assert.strictEqual(review.onlineVersion(), '');
});

test('getDebugInfo 只吐现场信息，不做判定', () => {
  setEnv('release');
  const info = review.getDebugInfo();
  assert.strictEqual(info.envVersion, 'release');
  assert.strictEqual(info.version, APP_VERSION);
  assert.strictEqual(typeof info.onlineVersion, 'string');
});
