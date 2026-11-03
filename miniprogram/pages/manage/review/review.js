// 审核队列：管理员入口，处理 inbox 待审内容（本页无锁屏，口令只在本机存一次）
//
// 数据流：
//   用户提交评论 → COS inbox/comment/ → Action 每小时聚合 → data/review_queue.json
//   这里读 review_queue 里 status=pending 的项，点通过/拒绝 → 写 inbox/decision/
//   下一次聚合时落库（通过）或只标状态（拒绝）
//
// 注意：口令不内置在小程序包里。v4.0.33 起本页已无锁屏口令门，
// 右上角「口令」按钮输一次，永久存手机本地 storage（与管理后台共用），客户端只做非空校验。
// 真正的把关在 GitHub Actions 端，口令不对的 decision 会被直接丢弃，
// 所以即使有人逆向出这个页面也改不了审核结果。

import { putInbox } from "../../../utils/writeback";

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

Page({
  data: {
    loading: false,
    items: [],
    error: "",
  },

  jsData: {
    raw: [],
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
        app.mpServerless.db.collection("review_queue").get(),
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
        .filter(it => it && it.status === "pending")
        .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

      this.jsData.raw = pending;
      this.setData({
        items: pending.map(it => ({
          _id: it._id,
          kind: it.kind,
          kindLabel: KIND_LABEL[it.kind] || it.kind,
          catName: catNames[it.data && it.data.cat_id] || (it.data && it.data.cat_id) || "未知猫猫",
          content: (it.data && it.data.content) || "",
          url: (it.data && it.data.url) || "",
          nickname: (it.data && it.data.nickname) || "匿名猫友",
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

    // 口令在关于页解锁时已存好，直接取；取不到会提示重新解锁
    const token = passcode.ensureToken();
    if (!token) return;

    wx.showLoading({ title: "提交中", mask: true });
    const ok = await putInbox("decision", {
      item_id: id,
      action: action === "approve" ? "approve" : "reject",
      token,
    });
    wx.hideLoading();

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
