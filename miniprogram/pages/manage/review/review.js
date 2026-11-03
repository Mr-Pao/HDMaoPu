// 审核队列：管理员入口，处理 inbox 待审内容（本页无锁屏，口令在关于页解锁时存本机）
//
// 数据流：
//   用户提交 → COS inbox/ → Actions 聚合 → data/review_queue.json（含 openid，不上 CDN）
//                                        └→ data/pending.json（同一份数据的脱敏快照，公开）
//   本页读 data/pending.json，点通过/驳回 → 写 inbox/decision/ → 下一次聚合落库
//
// 为什么不能直接读 review_queue：scripts/upload-data.js 的 UPLOAD_DENYLIST 把它挡在 CDN 外
// （文件里带用户 openid）。pending.json 由 scripts/process-inbox.js 的 writePendingSnapshot()
// 生成，只保留 pending 项且剥掉 openid。
//
// 待审图本身在 pending/ 前缀下是匿名可读的（桶是公有读），所以 <image src> 直接可用。

import { putInbox } from "../../../utils/writeback";
import { data_base_url } from "../../../config";

const passcode = require("../../../utils/passcode");

const app = getApp();

const KIND_LABEL = {
  comment: "评论",
  photo: "照片",
};

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = n => (n < 10 ? "0" + n : "" + n);
  return `${d.getMonth() + 1}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 待审图的预览地址由服务端在聚合时签好（见 scripts/process-inbox.js 的
// writePendingSnapshot）。桶策略 Deny 了 pending/* 的匿名 GET，直接拼公开 URL 会 403 白图。
// 这里只做兜底：快照里没带 preview_url 才退回拼公开地址。
function photoUrlOf(previewUrl, photoKey) {
  if (previewUrl && /^https?:\/\//i.test(previewUrl)) return previewUrl;
  const key = String(photoKey || "").replace(/^\/+/, "");
  if (!key) return "";
  if (/^https?:\/\//i.test(key)) return key;
  const base = String(data_base_url || "").replace(/\/+$/, "");
  return base ? `${base}/${key}` : "";
}

Page({
  data: {
    loading: false,
    items: [],
    error: "",
  },

  jsData: {
    catNames: {},
  },

  onLoad() {
    this.loadQueue();
  },

  onPullDownRefresh() {
    this.loadQueue().then(() => wx.stopPullDownRefresh());
  },

  async loadQueue() {
    this.setData({ loading: true, error: "" });
    try {
      const [queueRes, catRes] = await Promise.all([
        app.mpServerless.db.collection("pending").get(),
        app.mpServerless.db.collection("cat").get(),
      ]);

      const catNames = {};
      const cats = (catRes && catRes.result && catRes.result.data) || [];
      cats.forEach(c => {
        if (c && c._id) catNames[c._id] = c.name || c.nickname || c._id;
      });
      this.jsData.catNames = catNames;

      const list = (queueRes && queueRes.result && queueRes.result.data) || [];
      const pending = list
        .filter(it => it && it._id)
        .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

      this.setData({
        items: pending.map(it => ({
          _id: it._id,
          kind: it.kind,
          kindLabel: KIND_LABEL[it.kind] || it.kind,
          catName: catNames[it.data && it.data.cat_id] || (it.data && it.data.cat_id) || "未知猫猫",
          content: (it.data && it.data.content) || "",
          url: it.kind === "photo" ? photoUrlOf(it.preview_url, it.data && it.data.photo_key) : "",
          nickname: (it.data && it.data.nickname) || "匿名猫友",
          photographer: (it.data && it.data.photographer) || "",
          shootingDate: (it.data && it.data.shooting_date) || "",
          timeText: formatTime(it.create_time || it.ts),
        })),
        loading: false,
      });
    } catch (e) {
      console.warn("[review] 加载失败", e);
      this.setData({
        loading: false,
        error: "加载失败，请下拉重试",
      });
    }
  },

  async decide(e) {
    const { id, action } = e.currentTarget.dataset;
    if (!id || !action) return;
    if (this.deciding) return;
    this.deciding = id;

    // 口令在关于页解锁时已存好，直接取；取不到会提示重新解锁
    const token = passcode.ensureToken();
    if (!token) {
      this.deciding = "";
      return;
    }

    wx.showLoading({ title: "提交中", mask: true });
    const ok = await putInbox("decision", {
      item_id: id,
      action: action === "approve" ? "approve" : "reject",
      token,
    });
    wx.hideLoading();
    this.deciding = "";

    if (!ok) {
      wx.showToast({ title: "提交失败，请检查网络", icon: "none" });
      return;
    }

    // 本地先移出列表，实际生效要等下一次聚合（后台几分钟内自动汇总）
    this.setData({
      items: this.data.items.filter(it => it._id !== id),
    });
    wx.showToast({
      title: action === "approve"
        ? "已通过，后台几分钟内汇总生效"
        : "已拒绝，后台几分钟内汇总生效",
      icon: "none",
      duration: 2500,
    });
  },
});
