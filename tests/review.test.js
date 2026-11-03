// 单元测试：miniprogram/utils/review.js 的审核态判定
// 覆盖 applyVersionRule 的全部分支：白名单空/非空、devtools、develop、trial、
// release（命中/不命中）、模拟版本号、布尔强制、老配置兜底、拿不到版本号。
// 只测纯函数，不碰 storage / 网络。

const assert = require('node:assert');
const test = require('node:test');

let envVersion = 'develop';
let accountInfoThrows = false;

// review.js 顶层 import 了 config（会 require appSecret.js），且判定时读 wx
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

test('devtools：白名单非空也放行（本机开发不受影响）', () => {
  setEnv('devtools');
  assert.strictEqual(
    review.applyVersionRule({ reviewVersions: [APP_VERSION] }, null),
    false
  );
});

test('devtools + 模拟版本号：按白名单匹配，可测出审核态', () => {
  setEnv('devtools');
  assert.strictEqual(
    review.applyVersionRule({ reviewVersions: [APP_VERSION] }, { version: APP_VERSION }),
    true
  );
  assert.strictEqual(
    review.applyVersionRule({ reviewVersions: ['v9.9.9'] }, { version: APP_VERSION }),
    false
  );
});

test('develop（审核员）：白名单非空即审核态', () => {
  setEnv('develop');
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ['v1.0.0'] }, null), true);
});

test('develop：白名单为空 = 正常态', () => {
  setEnv('develop');
  assert.strictEqual(review.applyVersionRule({ reviewVersions: [] }, null), false);
});

test('trial：白名单非空即审核态', () => {
  setEnv('trial');
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ['v1.0.0'] }, null), true);
});

test('release：版本号命中白名单 = 审核态', () => {
  setEnv('release');
  assert.strictEqual(
    review.applyVersionRule({ reviewVersions: [APP_VERSION] }, null),
    true
  );
});

test('release：版本号不在白名单 = 正常态', () => {
  setEnv('release');
  assert.strictEqual(
    review.applyVersionRule({ reviewVersions: ['v9.9.9'] }, null),
    false
  );
});

test('release：白名单为空 = 正常态', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule({ reviewVersions: [] }, null), false);
});

test('布尔覆盖优先级最高：强制审核态压过 devtools 放行', () => {
  setEnv('devtools');
  assert.strictEqual(
    review.applyVersionRule({ reviewVersions: [] }, { review: true }),
    true
  );
});

test('布尔覆盖优先级最高：强制正常态压过 release 命中', () => {
  setEnv('release');
  assert.strictEqual(
    review.applyVersionRule({ reviewVersions: [APP_VERSION] }, { review: false }),
    false
  );
});

test('老配置兼容：没有 reviewVersions 时读 review 布尔', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule({ review: true }, null), true);
  assert.strictEqual(review.applyVersionRule({ review: false }, null), false);
});

test('远端配置为空 / 非法：一律完整态', () => {
  setEnv('release');
  assert.strictEqual(review.applyVersionRule(null, null), false);
  assert.strictEqual(review.applyVersionRule(undefined, null), false);
  assert.strictEqual(review.applyVersionRule('oops', null), false);
  assert.strictEqual(review.applyVersionRule({}, null), false);
});

test('白名单里的非字符串项被规范化，空白项被丢弃', () => {
  setEnv('release');
  // 纯空白项过滤后列表为空 → 正常态
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ['  ', ''] }, null), false);
  // 数字版本号转字符串后仍能匹配
  assert.strictEqual(review.applyVersionRule({ reviewVersions: [4] }, { version: '4' }), true);
});

test('getAccountInfoSync 不存在：按 devtools 放行', () => {
  accountInfoThrows = true;
  assert.strictEqual(review.envName(), 'devtools');
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ['v1.0.0'] }, null), false);
});

test('runtimeVersion 就等于 config.app_version', () => {
  setEnv('release');
  assert.strictEqual(review.runtimeVersion(), APP_VERSION);
});
