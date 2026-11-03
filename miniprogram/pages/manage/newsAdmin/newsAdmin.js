// 管理后台 → 猫抓板公告（列表 / 新建 / 修改 / 删除）
//
// 为什么单独一页：
//   公告的增删改以前挂在「公告详情」页底部两个按钮上（detailNews 的 showManager），
//   普通用户读公告的页面里也要判一次管理员权限。现在管理动作全部收进管理后台，
//   detailNews 退化成纯展示页，不需要任何权限判断。
//
// 写入链路（与其它管理页一致）：
//   本页 → putInbox('manage', { action:'manageNews', op, token, ... })
//   → COS inbox/manage/ → Actions process-inbox.js 的 manageNews() → data/news.json
//   → sync-data.yml 推 COS。
//   注意：以前这里用的是 api.curdOp，它只写本地覆盖层、根本不上传远端，
//   所以「改完别人看不到、换设备就没了」——这是本次一并修掉的 bug。

import { putInbox } from "../../../utils/writeback";
import { text as text_cfg } from "../../../config";

const passcode = require("../../../utils/passcode");

const app = getApp();

// 摘要多长够用：列表卡片只显示两行
const EXCERPT_LEN = 60;

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = n => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

Page({
  data: {
    loading: true,
    items: [],
  },

  onLoad() {
    this.loadList();
  },

  // 下拉刷新（newsAdmin.json 里开了 enablePullDownRefresh）
  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh());
  },

  // ---------- 列表 ----------

  async loadList() {
    this.setData({ loading: true });
    try {
      const { result } = await app.mpServerless.db.collection("news").find({}, { sort: { date: -1 } });
      const items = (result || []).map(n => ({
        _id: n._id,
        title: n.title || "（无标题）",
        class: n.class || "",
        dateText: formatDate(n.date),
        excerpt: String(n.mainContent || "").replace(/\s+/g, " ").slice(0, EXCERPT_LEN),
      }));
      this.setData({ items, loading: false });
    } catch (e) {
      console.warn("[newsAdmin] 公告列表加载失败", e);
      this.setData({ loading: false, items: [] });
      wx.showToast({ title: "公告列表加载失败", icon: "none" });
    }
  },

  // 点标题去普通详情页预览（只读）
  preview(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: "/pages/news/detailNews/detailNews?news_id=" + id });
  },

  // ---------- 新建 / 修改 ----------

  createNews() {
    wx.navigateTo({ url: "/pages/news/createNews/createNews" });
  },

  modifyNews(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: "/pages/news/modifyNews/modifyNews?news_id=" + id });
  },

  // ---------- 删除 ----------

  async removeNews(e) {
    const { id, title } = e.currentTarget.dataset;
    if (!id) return;
    // 口令在关于页解锁时已存好，直接取；取不到会提示重新解锁
    const token = passcode.ensureToken();
    if (!token) return;

    const res = await new Promise(resolve => {
      wx.showModal({
        title: "删除公告",
        content: `确定删除「${title || "这条公告"}」吗？删除后不可恢复。`,
        confirmText: "删除",
        confirmColor: "#D93025",
        success: r => resolve(!!(r && r.confirm)),
      });
    });
    if (!res) return;

    // putInbox 永远不 reject，失败只返回 false —— 所以必须检查返回值，
    // 不能像旧代码那样 await 完就当成功了。
    const ok = await putInbox("manage", {
      action: "manageNews",
      op: "remove",
      token,
      news_id: id,
    });

    if (!ok) {
      wx.showModal({
        title: "没提交成功",
        content: text_cfg.sync.offline_tip,
        showCancel: false,
        confirmText: "知道了",
      });
      return;
    }

    wx.showModal({
      title: "已提交删除",
      content: "后台几分钟内汇总生效，稍后刷新列表就看不到了。",
      showCancel: false,
      confirmText: "知道了",
    });
    // 本地列表不会立刻变（要等 Actions 聚合 + COS 同步），延迟重拉只是为了观感
    setTimeout(() => this.loadList(), 1200);
  },
});
