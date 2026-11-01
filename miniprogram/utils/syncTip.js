// 提交后「延迟生效」的本地提示
//
// 小程序没有服务器：写操作通过 putInbox() PUT 到 COS 的 inbox/，由 GitHub Actions
// 每 5 分钟聚合回 data/*.json，再由 sync-data.yml 推回 COS。所以用户提交后
// 只有当前页有乐观更新，重新进页面 / 其他用户最长要等 5~15 分钟才看得到，
// 照片和留言还要人工审核。
//
// 这里只在本机记一条「我刚提交了什么」，用于：
//   1) 提交后的统一提示文案（config.text.sync）
//   2) 详情页顶部「等待同步」提示条
//
//   storage: pending_sync = [{ kind, cat_id, label, ts }, ...]
//   同 kind + cat_id 只留最新一条；上限 20 条；2 小时过期。
//
// 约定：所有函数同步执行，任何异常都吞掉，绝不 throw，也绝不影响提交主流程。

import config from "../config";

const STORAGE_KEY = "pending_sync";
const MAX_ITEMS = 20;
const TTL = 2 * 60 * 60 * 1000; // 2 小时

// 读原始数组，脏数据就地过滤
function readRaw() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter(it => it && typeof it === "object" && it.kind);
  } catch (e) {
    console.warn("[syncTip] 读 storage 失败", (e && e.message) || e);
    return [];
  }
}

function writeRaw(list) {
  try {
    wx.setStorageSync(STORAGE_KEY, list);
  } catch (e) {
    console.warn("[syncTip] 写 storage 失败", (e && e.message) || e);
  }
}

/**
 * 记一条待同步
 * @param {string} kind like / comment / photo / rating ...
 * @param {object} payload { cat_id, label }
 */
function markPending(kind, payload) {
  try {
    const data = payload || {};
    const item = {
      kind: String(kind || ""),
      cat_id: data.cat_id || "",
      label: data.label || "",
      ts: Date.now(),
    };
    if (!item.kind) {
      return;
    }
    let list = readRaw();
    const idx = list.findIndex(it => it.kind === item.kind && it.cat_id === item.cat_id);
    if (idx >= 0) {
      list[idx] = item;
    } else {
      list.push(item);
    }
    if (list.length > MAX_ITEMS) {
      list = list.slice(list.length - MAX_ITEMS);
    }
    writeRaw(list);
  } catch (e) {
    console.warn("[syncTip] markPending 异常", (e && e.message) || e);
  }
}

/**
 * 读待同步列表（顺手清理过期条目）
 * @param {string} [cat_id] 传了就只看这只猫
 * @returns {Array}
 */
function getPending(cat_id) {
  try {
    const now = Date.now();
    const all = readRaw();
    const fresh = all.filter(it => now - (Number(it.ts) || 0) <= TTL);
    if (fresh.length !== all.length) {
      writeRaw(fresh);
    }
    if (!cat_id) {
      return fresh;
    }
    return fresh.filter(it => it.cat_id === cat_id);
  } catch (e) {
    console.warn("[syncTip] getPending 异常", (e && e.message) || e);
    return [];
  }
}

/**
 * 待同步条数
 * @param {string} [cat_id]
 * @returns {number}
 */
function getPendingCount(cat_id) {
  return getPending(cat_id).length;
}

// 清空（目前只在调试时用）
function clearPending() {
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (e) {
    console.warn("[syncTip] clearPending 异常", (e && e.message) || e);
  }
}

/**
 * 统一的「已提交」弹窗
 * @param {string} content 正文
 * @param {string} [title] 默认「已提交」
 */
function submittedModal(content, title) {
  try {
    wx.showModal({
      title: title || config.text.sync.submitted_title,
      content: content,
      showCancel: false,
      confirmText: "知道了",
    });
  } catch (e) {
    console.warn("[syncTip] submittedModal 异常", (e && e.message) || e);
  }
}

/**
 * 详情页提示条文案
 * @param {number} n 待同步条数
 * @returns {string}
 */
function pendingText(n) {
  try {
    return String(config.text.sync.pending_tip).replace("{n}", String(n));
  } catch (e) {
    return "";
  }
}

module.exports = {
  markPending,
  getPending,
  getPendingCount,
  clearPending,
  submittedModal,
  pendingText,
};
