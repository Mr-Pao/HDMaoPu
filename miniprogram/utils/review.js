// 远程展示开关（审核模式）—— 与 SpaceLaunch 完全同一套逻辑
//
// COS 上 data/app-config.json 里只有一个字段：
//   { "reviewVersions": [] }
//
// 实测口径（2026-10-25，微信开放社区官方确认 + 用户真机验证）：
//   审核员跑的是 develop 环境（开发版口径），version 字段为空——
//   不是 release！所以白名单匹配对审核员永远不命中，
//   真正起作用的是「白名单非空 + 拿不到版本号 → 审核态」这条兜底。
//   reviewVersions 实际语义 = 审核期总开关：非空 = 审核中，空 = 正常期。
//
// 提审流程（全程只改这一处）：
//   提审前 → { "reviewVersions": ["4.0.73"] }（版本号随意，关键是不能为空）
//   过审发布后 → { "reviewVersions": [] }
//
// 环境分派：
//   - devtools（开发者工具）→ 永远完整态，本机开发不受开关影响
//   - develop 真机（= 审核员）/ trial（体验版，version 也为空）→ 白名单非空即审核态
//   - release（正式版用户）→ 有版本号：按白名单匹配；白名单为空 → 完整态
//
// 真机/开发者工具想看审核态：用本机覆盖暗门 setOverride('4.0.73')。
//
// 设计约束（照搬 SpaceLaunch）：
// - 请求失败一律按完整态兜底，绝不影响正常使用
// - 审核环境是全新安装（无本地缓存），首次打开必然拉一次远程，所以开关一定生效
// - COS 直连域名无 CDN 缓存层，控制台改完即生效
//
// 注意：本文件用 require 而不是 import —— tests/review.test.js 直接 require 它做单测。

const config = require("../config");

const CONFIG_KEY = "appReviewConfig"; // { ts, data } 远端原文缓存
// 判定结论（布尔）单独落一份，给 custom-tab-bar 与 showTab 这类同步读者用
const RESOLVED_KEY = "appReviewResolved";
const OVERRIDE_KEY = CONFIG_KEY + "Override"; // 本机覆盖（开发者暗门）
const TTL = 5 * 60 * 1000;

// 会话内存缓存：tabBar、首页、详情页多处调用共享一次请求
let mem = null;
let inflight = null;

/**
 * 当前运行环境。envVersion：
 *   devtools = 开发者工具；develop = 真机开发版（审核员就是这个）；
 *   trial = 体验版（version 同样为空）；release = 正式版（version 有值）。
 * API 不存在（基础库 < 2.2.2）→ 返回 devtools 口径放行。
 */
function envName() {
  try {
    return (wx.getAccountInfoSync().miniProgram || {}).envVersion || "unknown";
  } catch (e) {
    return "devtools";
  }
}

/**
 * 当前运行的小程序版本号（线上 versionName，如 "4.0.72"）。
 * 开发版/体验版返回空串，正式版返回线上版本号。
 */
function runtimeVersion() {
  try {
    const info = wx.getAccountInfoSync();
    return String((info && info.miniProgram && info.miniProgram.version) || "").trim();
  } catch (e) {
    return "";
  }
}

// 包内版本号（config.js 的 app_version），仅用于暗门面板展示，不参与判定
function packagedVersion() {
  return String((config && config.app_version) || "").trim();
}

/**
 * 按远程配置算出这台设备该不该进审核态（纯函数，单测直接调）。
 *
 * 判定顺序：
 *   1. 开发者工具且没指定模拟版本号 → 永远完整态（保护本机开发）
 *   2. 配了 reviewVersions 且当前版本在其中 → 审核态
 *   3. 配了 reviewVersions 但拿不到版本号 → 审核态
 *      （审核员是 develop 环境，version 恒为空 —— 就是这条兜底拦住审核员）
 *   4. 其它（白名单为空）→ 完整态
 *
 * simulated：暗门里填的模拟版本号。给了它就跳过环境判断，
 * 用这个假版本号代替真实版本号 —— 开发者工具也能看到审核员视角。
 */
function applyVersionRule(raw, simulated) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const out = Object.assign({}, cfg);
  const sim = typeof simulated === "string" && simulated ? simulated : null;

  if (!sim && envName() === "devtools") {
    out.review = false;
    return out;
  }

  // 旧格式兼容：配置里没有 reviewVersions 字段时才看布尔 review
  if (!Array.isArray(cfg.reviewVersions)) {
    out.review = Boolean(cfg.review);
    return out;
  }

  const list = cfg.reviewVersions.map(String);
  if (!list.length) {
    out.review = false;
    return out;
  }

  // 拿不到版本号：正式版必有版本号，拿不到的只可能是审核环境，保审核
  const v = sim || runtimeVersion();
  out.review = v ? list.indexOf(v) !== -1 : true;
  return out;
}

// 拉一次远端配置。失败返回 null。
// db 可以不传：不传时从 getApp().mpServerless.db 取；
// app.js 的 onLaunch 里 getApp() 可能还是 undefined，那里会把 db 显式传进来。
function request(db) {
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

function readLocal() {
  try {
    const v = wx.getStorageSync(CONFIG_KEY);
    if (v && v.ts && v.data && Date.now() - v.ts < TTL) return v.data;
  } catch (e) {
    // Storage 不可用时只当没有缓存
  }
  return null;
}

function writeLocal(data) {
  try {
    wx.setStorageSync(CONFIG_KEY, { ts: Date.now(), data });
  } catch (e) {
    // 写不进去就算了，下次再拉远程
  }
}

/**
 * 本机覆盖（开发者暗门用）：写在 storage 里的强制值，优先级高于远程开关
 * —— 只影响本机，审核员的设备拿不到。
 *   { version: '4.0.73' }  模拟运行在正式版 4.0.73，走真实白名单判定
 *   { review: true }       不讲道理地强制审核态（旧用法，保留）
 */
function readOverride() {
  try {
    const o = wx.getStorageSync(OVERRIDE_KEY);
    if (!o || typeof o !== "object") return null;
    if (typeof o.version === "string" && o.version) return o;
    if (typeof o.review === "boolean") return o;
  } catch (e) {
    // 没有覆盖
  }
  return null;
}

/**
 * 写本机覆盖。
 *   setOverride('4.0.73')  模拟版本号
 *   setOverride(true)      强制审核态
 *   setOverride(false)     强制完整态
 *   setOverride(null)      清除，回到环境默认
 */
function setOverride(val) {
  try {
    if (val === null || val === undefined || val === "") {
      wx.removeStorageSync(OVERRIDE_KEY);
    } else if (typeof val === "string") {
      wx.setStorageSync(OVERRIDE_KEY, { version: val.trim() });
    } else if (typeof val === "object") {
      if (typeof val.version === "string" && val.version) {
        wx.setStorageSync(OVERRIDE_KEY, { version: val.version.trim() });
      } else if (typeof val.review === "boolean") {
        wx.setStorageSync(OVERRIDE_KEY, { review: val.review });
      } else {
        wx.removeStorageSync(OVERRIDE_KEY);
      }
    } else {
      wx.setStorageSync(OVERRIDE_KEY, { review: Boolean(val) });
    }
  } catch (e) {
    // 写不进去就当没设置
  }
}

/**
 * 拉一次开关，网络抖动时重试一次 ——
 * 审核场景拉不到开关会退回完整内容，宁可多等一秒。
 */
async function fetchOnce(db) {
  const first = await request(db);
  if (first) return first;
  return request(db);
}

/**
 * 取原始配置（含 reviewVersions），判定每次现算 ——
 * 同一份缓存要能被「真实版本号」和「模拟版本号」两种口径分别解释，
 * 所以缓存只存原文，绝不在写入时就把 review 算死。
 */
async function loadRaw(db) {
  if (mem && Date.now() - mem.ts < TTL) return mem.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const local = readLocal();
    if (local) {
      mem = { data: local, ts: Date.now() };
      return local;
    }
    const remote = await fetchOnce(db);
    const data = remote || {};
    mem = { data, ts: Date.now() };
    // 远程拉取成功才落缓存；失败结果不缓存，下次进页面再试
    if (remote) writeLocal(data);
    return data;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

// 绕过一切缓存拉一次远程，并刷新本地缓存 —— 给暗门面板看「远程现在到底是什么」
async function refreshRemote(db) {
  const remote = await fetchOnce(db);
  if (remote) {
    mem = { data: remote, ts: Date.now() };
    writeLocal(remote);
  }
  return remote;
}

// 把判定结论写一份给 tabBar / showTab 这类同步读者
function writeResolved(review) {
  try {
    wx.setStorageSync(RESOLVED_KEY, { review: !!review, ts: Date.now() });
  } catch (e) {
    // 写不进去就靠页面 onShow 兜底
  }
}

function readResolved() {
  try {
    const r = wx.getStorageSync(RESOLVED_KEY);
    if (r && typeof r === "object") return r;
  } catch (e) {
    // 没算过
  }
  return null;
}

// 同步读取判定结论：从没算过就当完整态（保守，不影响正常用户）
function isReviewSync() {
  const r = readResolved();
  return r ? !!r.review : false;
}

// 解析开关（优先级：本机覆盖 > 非正式版完整态 > 内存/本地缓存 > 远程）
function resolveConfig(db) {
  const ov = readOverride();

  // 本机覆盖：模拟某个版本号 → 走正式版口径
  if (ov && ov.version) {
    return loadRaw(db).then(raw => applyVersionRule(raw, ov.version));
  }
  // 本机覆盖：强制审核态 / 强制完整态
  if (ov && typeof ov.review === "boolean") {
    return Promise.resolve({ review: ov.review });
  }
  // 开发者工具：永远完整态
  if (envName() === "devtools") return Promise.resolve({ review: false });

  return loadRaw(db).then(raw => applyVersionRule(raw));
}

// 取展示开关，永远 resolve 一个对象（任何失败都兜底 review:false）
async function getConfig(opts) {
  const force = !!(opts && opts.force);
  const db = (opts && opts.db) || null;
  if (force) {
    await refreshRemote(db);
  }
  const c = await resolveConfig(db);
  writeResolved(c && c.review);
  return c;
}

// 异步判定（页面用）
async function isReview(opts) {
  const c = await getConfig(opts);
  return !!(c && c.review);
}

/**
 * 开发者面板用：一次性给出现场信息，不做任何判定。
 * 面板要能回答三件事 —— 现在是什么环境、真实版本号多少、远程白名单是什么。
 */
function getDebugInfo() {
  let envVersion = "unknown";
  let version = "";
  try {
    const info = wx.getAccountInfoSync();
    envVersion = (info && info.miniProgram && info.miniProgram.envVersion) || "unknown";
    version = String((info && info.miniProgram && info.miniProgram.version) || "").trim();
  } catch (e) {
    // 拿不到就留空
  }
  const ov = readOverride();
  return {
    envVersion,
    version,
    packagedVersion: packagedVersion(),
    override: ov ? (ov.version ? { version: ov.version } : { review: ov.review }) : null,
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
  wx.showToast({ title: tip || "当前不可用", icon: "none" });
  setTimeout(() => {
    wx.navigateBack({ fail() {} });
  }, 1200);
  return true;
}

module.exports = {
  envName,
  runtimeVersion,
  packagedVersion,
  applyVersionRule,
  readOverride,
  setOverride,
  refreshRemote,
  getDebugInfo,
  getConfig,
  isReview,
  isReviewSync,
  blockInReview,
};
