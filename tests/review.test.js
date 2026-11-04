// 审核期开关（reviewVersions）判定单测 —— 逻辑与 SpaceLaunch 的 utils/config.js 同源
// 语义：reviewVersions 非空 = 审核中；空 = 正常期。
const test = require("node:test");
const assert = require("node:assert");

const store = {};

global.wx = {
  getAccountInfoSync() {
    return { miniProgram: { envVersion: global.__env || "release", version: global.__ver || "" } };
  },
  getStorageSync(k) {
    return store[k];
  },
  setStorageSync(k, v) {
    store[k] = v;
  },
  removeStorageSync(k) {
    delete store[k];
  },
};

const review = require("../miniprogram/utils/review.js");

function setEnv(env, ver) {
  global.__env = env;
  global.__ver = ver === undefined ? "" : ver;
}

test("reviewVersions 为空：任何环境都是正常态", () => {
  const raw = { reviewVersions: [] };
  setEnv("release", "4.0.72");
  assert.strictEqual(review.applyVersionRule(raw).review, false);
  setEnv("develop", "");
  assert.strictEqual(review.applyVersionRule(raw).review, false);
  setEnv("trial", "");
  assert.strictEqual(review.applyVersionRule(raw).review, false);
});

test("reviewVersions 非空 + release 命中：审核态（列表里的版本就是要藏起来的那版）", () => {
  setEnv("release", "4.0.72");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }).review, true);
});

test("reviewVersions 非空 + release 不命中：正常态", () => {
  setEnv("release", "4.0.71");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }).review, false);
});

test("多版本白名单，命中任意一个即审核态", () => {
  setEnv("release", "4.0.71");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72", "4.0.71"] }).review, true);
});

test("reviewVersions 非空 + develop（审核员）拿不到版本号：审核态", () => {
  setEnv("develop", "");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }).review, true);
});

test("reviewVersions 非空 + trial（体验版）拿不到版本号：审核态", () => {
  setEnv("trial", "");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }).review, true);
});

test("develop 环境拿到版本号且命中：审核态", () => {
  setEnv("develop", "4.0.72");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }).review, true);
});

test("devtools 永远正常态，无论白名单是否非空", () => {
  setEnv("devtools", "");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }).review, false);
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["9.9.9"] }).review, false);
});

test("devtools 下给了模拟版本号则走真实规则（用于本机看审核态）", () => {
  setEnv("devtools", "");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }, "4.0.72").review, true);
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }, "3.1.0").review, false);
});

test("模拟版本号在白名单为空时仍是正常态", () => {
  setEnv("devtools", "");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: [] }, "9.9.9").review, false);
});

test("没有 reviewVersions 字段时回落到布尔 review", () => {
  setEnv("release", "4.0.72");
  assert.strictEqual(review.applyVersionRule({ review: true }).review, true);
  assert.strictEqual(review.applyVersionRule({ review: false }).review, false);
});

test("raw 为空/非法时一律正常态，绝不因开关读不到而锁功能", () => {
  setEnv("release", "4.0.72");
  [null, undefined, "oops", 0, {}].forEach(raw => {
    assert.strictEqual(review.applyVersionRule(raw).review, false, String(raw));
  });
});

test("白名单元素是数字也能正确比较（配置写错不容崩）", () => {
  setEnv("release", "4");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: [4] }).review, true);
  setEnv("release", "4.0.72");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: [4] }).review, false);
});

test("release 但拿不到版本号：白名单非空即审核态", () => {
  setEnv("release", "");
  assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }).review, true);
});

test("getAccountInfoSync 抛错时按 devtools 口径放行", () => {
  const backup = global.wx.getAccountInfoSync;
  global.wx.getAccountInfoSync = () => {
    throw new Error("no api");
  };
  try {
    assert.strictEqual(review.envName(), "devtools");
    assert.strictEqual(review.applyVersionRule({ reviewVersions: ["4.0.72"] }).review, false);
  } finally {
    global.wx.getAccountInfoSync = backup;
  }
});

test("readOverride / setOverride 四种形态", () => {
  setEnv("release", "4.0.72");
  review.setOverride("3.1.0");
  assert.deepStrictEqual(review.readOverride(), { version: "3.1.0" });
  review.setOverride(true);
  assert.deepStrictEqual(review.readOverride(), { review: true });
  review.setOverride(false);
  assert.deepStrictEqual(review.readOverride(), { review: false });
  review.setOverride(null);
  assert.strictEqual(review.readOverride(), null);
});

test("runtimeVersion 读线上版本号，packagedVersion 读包内 app_version", () => {
  setEnv("release", "4.0.72");
  assert.strictEqual(review.runtimeVersion(), "4.0.72");
  const config = require("../miniprogram/config.js");
  assert.strictEqual(review.packagedVersion(), String(config.app_version).trim());
});

test("getDebugInfo 给出环境、线上版本、包内版本、覆盖", () => {
  setEnv("develop", "");
  review.setOverride("3.1.0");
  const info = review.getDebugInfo();
  assert.strictEqual(info.envVersion, "develop");
  assert.strictEqual(info.version, "");
  assert.ok(info.packagedVersion);
  assert.deepStrictEqual(info.override, { version: "3.1.0" });
  review.setOverride(null);
});
