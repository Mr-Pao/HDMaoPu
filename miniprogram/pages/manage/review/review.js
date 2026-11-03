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
// ⚠️ 待审图不能直接用 pending/ 的地址：桶策略有一条 Deny 匿名 GetObject 覆盖
// inbox/*、pending/*、rejected/*（Sid deny-anon-read-private-prefixes），GET 会 403 白图。
// 聚合时会复制一份到 preview/pending/<basename> 并给对象级 public-read，
// 快照里的 preview_url 指向那里。注意 HEAD 请求不在 Deny 里，会返回 200 骗人——判可用性必须用 GET。

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

// 待审图预览地址的取法（三级兜底）：
//   1. 快照里的 preview_url（聚合时写好，永远最新）
//   2. 客户端按确定性规则推出来的 preview/pending/<basename>
//      —— 这一级是关键：datasource 是 SWR，本地缓存里可能还是服务端发 preview_url
//         之前的旧快照（只有 data.photo_key），那时若拼 pending/* 会 403 白图。
//         而 preview 副本的 key 是确定的（见 process-inbox.js 的 previewKeyOf），
//         所以不用等缓存刷新也能拼对。
//   3. 原始 photo_key（理论上到不了；桶策略 Deny 了 pending/* 的匿名 GET）
const PREVIEW_PREFIX = "preview/pending/";

function photoUrlOf(previewUrl, photoKey) {
  if (previewUrl && /^https?:\/\//i.test(previewUrl)) return previewUrl;

  const key = String(photoKey || "").replace(/^\/+/, "");
  if (!key) return "";
  if (/^https?:\/\//i.test(key)) return key;

  const base = String(data_base_url || "").replace(/\/+$/, "");
  if (!base) return "";

  const basename = key.split("/").pop();
  if (basename) return `${base}/${PREVIEW_PREFIX}${basename}`;
  return `${base}/${key}`;
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
