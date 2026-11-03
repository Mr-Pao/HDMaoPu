// 审核态判定（版本号白名单开关）
//
// 背景：微信提审时审核员看到的是 develop（开发版），审完发布后任何人都能看到。
// 有些功能（管理后台、UGC 上传入口、数据看板）不希望在审核期被发现，
// 于是用一个「远端配置 + 版本号白名单」的统一开关，在审核期把小程序收成只读。
//
// 开关文件：data/app-config.json（COS 上 data/app-config.json），格式沿用项目信封：
//   { "version": "...", "items": [ { "_id": "app-config", "reviewVersions": [] } ] }
//
// 语义：reviewVersions 非空 = 审核中（工具态）；[] = 正常期（完整态）。
// 提审前把版本号写进去，过审发布后清回 []。
//
// 判定口径（照搬 SpaceLaunch 的实测经验，2026-10-25）：
//   - devtools：永远完整态（本机开发不受影响）
//   - develop / trial：白名单非空即审核态（审核员跑的是开发版，拿不到版本号）
//   - release：按白名单匹配 app_version；拿不到版本号时兜底为审核态
//   - 远端拉不到 / 解析失败：一律完整态（绝不影响正常使用）
//
// 本机覆盖（暗门面板）：storage `appReviewConfigOverride`
//   { version: "v4.0.72" } 模拟版本号 | { review: true } 强制审核态 | { review: false } 强制完整态
//   由首页「火大猫谱」标题连击 5 次后的面板写入，仅本机生效。
//
// 同步读取：`isReviewSync()` 读 storage 里的判定结论 `appReviewResolved`，
// 给 tabBar / showTab 这类同步场景用；异步场景请用 `isReview()`。

// 用 require 而不是 import：本文件同时被 tests/review.test.js 直接 require 做单测，
// 走 CJS 才能被 Node 原生 test runner 加载。
const config = require("../config");

const CONFIG_KEY = "appReviewConfig"; // { ts, data } 远端原文缓存
const RESOLVED_KEY = "appReviewResolved"; // { review, ts } 判定结论（给同步读取方）
const OVERRIDE_KEY = "appReviewConfigOverride"; // { version } 或 { review }

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

// 本机当前版本号（就是 config.js 的 app_version，随包编译进去）
function runtimeVersion() {
  return String((config && config.app_version) || "").trim();
}

function readOverride() {
  try {
    const raw = wx.getStorageSync(OVERRIDE_KEY);
    if (!raw || typeof raw !== "object") return null;
    return raw;
  } catch (e) {
    return null;
  }
}

// 写本机覆盖。val 支持：
//   null / "" / undefined → 清除
//   "v4.0.72"            → 模拟版本号
//   true / false          → 强制审核态 / 强制完整态
//   { version } / { review }
function setOverride(val) {
  try {
    if (val === null || val === undefined || val === "") {
      wx.removeStorageSync(OVERRIDE_KEY);
      return;
    }
    if (typeof val === "boolean") {
      wx.setStorageSync(OVERRIDE_KEY, { review: val });
      return;
    }
    if (typeof val === "string") {
      const v = val.trim();
      if (!v) {
        wx.removeStorageSync(OVERRIDE_KEY);
      } else {
        wx.setStorageSync(OVERRIDE_KEY, { version: v });
      }
      return;
    }
    if (typeof val === "object") {
      if (val.review !== undefined) {
        wx.setStorageSync(OVERRIDE_KEY, { review: !!val.review });
      } else if (val.version) {
        wx.setStorageSync(OVERRIDE_KEY, { version: String(val.version).trim() });
      } else {
        wx.removeStorageSync(OVERRIDE_KEY);
      }
    }
  } catch (e) {
    console.warn("[review] 保存本机覆盖失败", e);
  }
}

// 纯函数：给定远端配置和本机覆盖，算出是否审核态。
// 刻意写成无副作用，方便单测直接调。
function applyVersionRule(raw, override) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const ov = override && typeof override === "object" ? override : null;

  // 布尔覆盖优先级最高：它就是为了强制看两种状态而存在的
  if (ov && ov.review === true) return true;
  if (ov && ov.review === false) return false;

  const sim = ov && typeof ov.version === "string" && ov.version.trim() ? ov.version.trim() : null;
  const env = envName();

  // 本机模拟版本号时不走「开发工具放行」，直接按白名单匹配（这样才测得出审核态）
  if (!sim && env === "devtools") return false;

  // 兼容没有 reviewVersions 字段、只有 review 的老配置
  if (!Array.isArray(cfg.reviewVersions)) return Boolean(cfg.review);

  const list = cfg.reviewVersions.map(v => String(v).trim()).filter(Boolean);
  if (!list.length) return false;

  // 审核员跑的是开发版/体验版，拿到的版本号不可靠 → 白名单非空即审核态
  if (!sim && (env === "develop" || env === "trial")) return true;

  const v = sim || runtimeVersion();
  // 连版本号都拿不到，按审核态处理（宁可多藏，不要漏）
  return v ? list.indexOf(v) !== -1 : true;
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

// 同步读取判定结论。
//   - 有本机覆盖：旧结论不可信（覆盖可能刚改），按本地缓存的远端原文重算
//   - 没有覆盖：用上次算好的结论；从没算过就当完整态（保守，不影响正常用户）
function isReviewSync() {
  const ov = readOverride();
  if (ov) {
    let raw = {};
    try {
      const cached = wx.getStorageSync(CONFIG_KEY);
      if (cached && cached.data) raw = cached.data;
    } catch (e) {
      raw = {};
    }
    return applyVersionRule(raw, ov);
  }
  const r = readResolved();
  return r ? !!r.review : false;
}

// 拉远端配置。失败返回 null（调用方按完整态兜底）。
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

// 取远端配置（5 分钟内存/本地缓存）
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
  const override = readOverride();
  const raw = await getConfig(force, db);
  const review = applyVersionRule(raw || {}, override);
  writeResolved(review);
  return review;
}

// 面板用：把现场信息原样吐出来，不做任何判定
function getDebugInfo() {
  return {
    envVersion: envName(),
    version: runtimeVersion(),
    override: readOverride(),
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
  applyVersionRule,
  readOverride,
  setOverride,
  getDebugInfo,
  getConfig,
  isReview,
  isReviewSync,
  blockInReview,
};
