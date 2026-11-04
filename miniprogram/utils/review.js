// 审核态判定（版本号门禁）
//
// 语义：**只有包内版本号与 COS 上登记的那个版本号对上了，才显示正常态；
// 其它任何时候（提审中的新版本、审核员拿到的版本、白名单没配）都是审核态。**
//
// 开关文件：data/app-config.json（COS 上 data/app-config.json），沿用项目信封：
//   { "version": "...", "items": [ { "_id": "app-config", "normalVersions": ["v4.0.72"] } ] }
//
// normalVersions = 「允许正常显示」的版本号白名单（一般只放一个，就是**已经过审发布**的那个版本）。
//
// 提审/发布流程（全程只改两处）：
//   提审前：config.js 的 app_version 升到要提审的新版本（如 v4.0.73）
//           COS 上的 normalVersions 保持「上一个已发布版本」（如 ["v4.0.72"]）
//           → 审核员跑的是新包 v4.0.73，与 COS 对不上 → 审核态（只留首页、无 tabBar、隐藏 UGC）
//   过审发布后：把 COS 的 normalVersions 改成 ["v4.0.73"] → 恢复正常
//
// 为什么用「包内 app_version」而不是 wx.getAccountInfoSync().miniProgram.version：
//   - 审核员跑的是 develop（开发版），miniProgram.version 为空；
//   - 开发版/体验版也拿不到版本号。
//   所以以编译进包的 app_version 为准，拿不到线上版本号时用它兜底 ——
//   这样「版本号对不对得上」这件事在任何环境都可判定，且测的就是真包。
//
// 环境分派：
//   - devtools（开发者工具）：永远正常态（本机开发不受影响）
//   - 其它（develop 真机/体验版/正式版）：按 app_version 与 COS 白名单比对
//   - 远端拉不到 / 解析失败：正常态（绝不影响正常使用）
//   - 白名单为空数组：门禁未启用，正常态
//
// 同步读取：`isReviewSync()` 读 storage 里的判定结论 `appReviewResolved`，
// 给 tabBar / showTab 这类同步场景用；异步场景请用 `isReview()`。

// 用 require 而不是 import：本文件同时被 tests/review.test.js 直接 require 做单测，
// 走 CJS 才能被 Node 原生 test runner 加载。
const config = require("../config");

const CONFIG_KEY = "appReviewConfig"; // { ts, data } 远端原文缓存
const RESOLVED_KEY = "appReviewResolved"; // { review, ts } 判定结论（给同步读取方）

const TTL = 5 * 60 * 1000; // 远端配置缓存 5 分钟

// 当前运行环境：develop（开发版/审核员）/ trial（体验版）/ release（线上）
function envName() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    const env = info && info.miniProgram && info.miniProgram.envVersion;
    return env || "unknown";
  } catch (e) {
    // 基础库 < 2.2.2 或非小程序环境：当开发者工具处理，放行
    return "devtools";
  }
}

// 线上版本号；开发版/体验版为空串，此时不回落到 app_version ——
// 判定一律以包内 app_version 为准，见文件头的说明。
function onlineVersion() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync();
    return String((info && info.miniProgram && info.miniProgram.version) || "").trim();
  } catch (e) {
    return "";
  }
}

// 包内版本号（就是 config.js 的 app_version，随包编译进去）
function runtimeVersion() {
  return String((config && config.app_version) || "").trim();
}

// 纯函数：给定远端配置，算出是否审核态。刻意无副作用，方便单测直接调。
function applyVersionRule(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};

  // 兼容 SpaceLaunch 那套老配置：没有 normalVersions 时看 reviewVersions
  // （旧语义是「非空 = 审核中」，方向相反，这里只做兜底识别，不再推荐使用）
  const list = Array.isArray(cfg.normalVersions)
    ? cfg.normalVersions.map(v => String(v).trim()).filter(Boolean)
    : null;

  if (list === null) {
    if (Array.isArray(cfg.reviewVersions)) {
      return cfg.reviewVersions.map(v => String(v).trim()).filter(Boolean).length > 0;
    }
    // 老格式：布尔 review
    return Boolean(cfg.review);
  }

  // 白名单为空 = 门禁未启用（新部署 / 刚建文件时不会误伤所有人）
  if (!list.length) return false;

  // 开发者工具永远正常态，本机开发不受影响
  if (envName() === "devtools") return false;

  // 版本号对上了才正常；对不上（含拿不到线上版本号 → 回落到包内 app_version）一律审核态
  const v = runtimeVersion();
  return !(v && list.indexOf(v) !== -1);
}

function readResolved() {
  try {
    const raw = wx.getStorageSync(RESOLVED_KEY);
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch (e) {
    return null;
  }
}

function writeResolved(review) {
  try {
    wx.setStorageSync(RESOLVED_KEY, { review: !!review, ts: Date.now() });
  } catch (e) {
    // 写不进去也无所谓，下次重新算
  }
}

// 同步读取判定结论：用上次算好的结论；从没算过就当正常态（保守，不影响正常用户）
function isReviewSync() {
  const r = readResolved();
  return r ? !!r.review : false;
}

// 拉远端配置。失败返回 null（调用方按正常态兜底）。
// db 可以不传：不传时从 getApp().mpServerless.db 取（页面/组件里调用都走这条）；
// app.js 的 onLaunch 里 getApp() 可能还是 undefined，所以那里会把 db 显式传进来。
function fetchConfig(db) {
  return new Promise(resolve => {
    try {
      let handle = db;
      if (!handle) {
        const app = getApp();
        handle = app && app.mpServerless && app.mpServerless.db;
      }
      if (!handle) return resolve(null);
      handle
        .collection("app-config")
        .findOne({ _id: "app-config" })
        .then(res => {
          const item = res && res.result;
          resolve(item && typeof item === "object" ? item : null);
        })
        .catch(() => resolve(null));
    } catch (e) {
      resolve(null);
    }
  });
}

// 取远端配置（5 分钟本地缓存）
async function getConfig(force, db) {
  const now = Date.now();
  if (!force) {
    try {
      const cached = wx.getStorageSync(CONFIG_KEY);
      if (cached && cached.ts && now - cached.ts < TTL && cached.data) {
        return cached.data;
      }
    } catch (e) {
      // 落到下面重新拉
    }
  }
  const data = await fetchConfig(db);
  if (data) {
    try {
      wx.setStorageSync(CONFIG_KEY, { ts: now, data });
    } catch (e) {
      // 存不下就每次重拉，不影响正确性
    }
  }
  return data;
}

// 完整判定：异步，带缓存。force = true 时绕过缓存重新拉远端。
async function isReview(opts) {
  const force = !!(opts && opts.force);
  const db = (opts && opts.db) || null;
  const raw = await getConfig(force, db);
  const review = applyVersionRule(raw || {});
  writeResolved(review);
  return review;
}

// 面板用：把现场信息原样吐出来，不做任何判定
function getDebugInfo() {
  return {
    envVersion: envName(),
    version: runtimeVersion(),
    onlineVersion: onlineVersion(),
  };
}

// UGC 页兜底：审核态下不允许进入（详情页已隐藏入口，这里防深链/历史栈）
// 返回 true = 已被拦下，调用方直接 return
async function blockInReview(tip) {
  let review = false;
  try {
    review = isReviewSync();
    if (!review) review = await isReview();
  } catch (e) {
    review = isReviewSync();
  }
  if (!review) return false;
  wx.showToast({ title: tip || '当前不可用', icon: 'none' });
  setTimeout(() => {
    wx.navigateBack({ fail() { } });
  }, 1200);
  return true;
}

module.exports = {
  envName,
  runtimeVersion,
  onlineVersion,
  applyVersionRule,
  getDebugInfo,
  getConfig,
  isReview,
  isReviewSync,
  blockInReview,
};
