// 管理后台 · 友情链接
//
// 历史：这个页面曾经是「三个独立入口共用一页」（?tab=cat|photo|link）。
// v4.0.65 按「一个对象一个入口」重组后：
//   - ?tab=cat（猫资料编辑）与「猫猫管理」重复，已删 —— 猫资料只在 catManage 改
//   - ?tab=photo（照片审核）已并入 catManage 的照片卡 —— 下架/精选/转移都在那里
//   - 本页只剩友情链接，不再有 tab 概念
//
// 口令模型：全站只有「关于页连击标题 5 次」那一次输入，这里直接取已存口令
//（utils/passcode.js 的 ensureToken），不再弹输入框。
//
// 数据流：
//   增删改先只改本地数组 → 点「保存」整批 putInbox('manage', { action:'saveFriendLinks', token, apps })
//   → COS inbox/manage/ → GitHub Actions 聚合 → data/setting.json 里 _id='friendLink' 的 apps

import { putInbox } from "../../../utils/writeback";
import { text as text_cfg } from "../../../config";
import config from "../../../config";
import { getCurrentUserOpenid } from "../../../utils/common";
import { compressImage } from "../../../utils/utils";
import { backAfterSubmit } from "../../../utils/syncTip";

const passcode = require("../../../utils/passcode");

const app = getApp();

const PAGE_TITLE = "友情链接";

Page({
  data: {
    pageTitle: PAGE_TITLE,

    links: [],
    linkLoading: false,
    linkSaving: false,
    linkDirty: false,
    // draft.logo 存的是要提交的字符串：要么是 pending/xxx.jpg（刚选的图，等聚合上传），
    // 要么是完整 https URL（存量数据 / 手工填）。draft.logoPreview 只是本地预览用的临时路径。
    draft: { appid: "", name: "", logo: "", logoPreview: "" },
    logoUploading: false,
  },

  onLoad() {
    wx.setNavigationBarTitle({ title: PAGE_TITLE });
    this.loadLinks();
  },

  // ---------- 友情链接 ----------
  //
  // 增删只改本地数组，点「保存」才整批提交：
  //   putInbox('manage', { action:'saveFriendLinks', token, apps })
  // 聚合端 manageSaveFriendLinks 校验后整体覆盖 setting 里 _id='friendLink' 的 apps。
  // 整批提交的好处：增、删、排序一次到位，不会出现半截状态。

  async loadLinks() {
    if (this.data.linkLoading) return;
    // 有未保存的改动时不重新拉取，避免把用户刚编辑的列表冲掉
    if (this.data.linkDirty) return;
    this.setData({ linkLoading: true });
    try {
      const { result } = await app.mpServerless.db.collection("setting").findOne({ _id: "friendLink" });
      const apps = ((result && result.apps) || []).filter(a => a && a.appid);
      this.setData({
        links: apps.map(a => ({ appid: a.appid, name: a.name || "", logo: a.logo || "", logoPreview: "" })),
        linkLoading: false,
        linkDirty: false,
      });
    } catch (e) {
      console.warn("[admin] 友情链接加载失败", e);
      this.setData({ linkLoading: false });
      wx.showToast({ title: "友情链接加载失败", icon: "none" });
    }
  },

  onDraftInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ ["draft." + field]: e.detail.value });
  },

  // ---------- 友情链接 Logo 选图上传 ----------
  //
  // 客户端不存 COS 密钥，所以这里和「上传喵照」走同一条匿名直传链路：
  //   选图 → 压缩 → PUT 到 pending/<openid>-<ts>.<ext>（桶策略允许匿名写，≤512KB）
  //   → 只把 key 记进 draft.logo → 点「保存」时随 apps 一起进 inbox/manage/
  //   → 聚合端 manageSaveFriendLinks 把 pending/ 的对象复制到 photos/friendlink/
  //     （public-read）再把 logo 换成完整 URL（原始 pending 对象审核后删除）。
  //
  // 选完图本地就能预览（tempFilePath 是本地临时路径，wx:if="{{item.logo}}" 也能显示），
  // 但只有保存成功才会真正上线；提交失败时 logo 仍是 pending/ 开头的 key，页面显示不出
  // 图片也不影响数据。
  async pickLinkLogo() {
    if (this.data.logoUploading) return;

    let file;
    try {
      const chosen = await wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sizeType: ["compressed"],
        sourceType: ["album", "camera"],
      });
      file = (chosen && chosen.tempFiles && chosen.tempFiles[0]) || null;
    } catch (e) {
      // 用户取消选图不算错误
      return;
    }
    if (!file) return;

    const tempPath = file.tempFilePath || file.path;
    if (!tempPath) return;

    this.setData({ logoUploading: true });
    wx.showLoading({ title: "上传中…", mask: true });

    try {
      // 和 addPhoto 一致：大于 512KB 先压缩（桶策略对 pending/* 有 512KB 的单对象上限）
      let uploadPath = tempPath;
      let size = Number(file.size || 0);
      if (size > 512 * 1024) {
        uploadPath = await compressImage(tempPath, 30);
        try {
          const info = await wx.getFileSystemManager().getFileInfo({ filePath: uploadPath });
          size = Number((info && info.data && info.data.size) || 0);
        } catch (e) {
          size = 0;
        }
      }

      const dot = String(uploadPath).lastIndexOf(".");
      let ext = dot >= 0 ? String(uploadPath).substr(dot + 1) : "jpg";
      ext = (ext || "jpg").toLowerCase();
      if (ext === "jpeg") ext = "jpg";

      const openid = (await getCurrentUserOpenid()) || "anon";
      const key = `pending/${openid}-${Date.now()}.${ext}`;
      const baseUrl = String(config.data_base_url || "").replace(/\/+$/, "");
      if (!baseUrl) throw new Error("缺少 data_base_url");

      const arrayBuffer = await new Promise((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath: uploadPath,
          success: res => resolve(res.data),
          fail: reject,
        });
      });

      await new Promise((resolve, reject) => {
        wx.request({
          url: `${baseUrl}/${key}`,
          method: "PUT",
          data: arrayBuffer,
          header: {
            "Content-Type":
              ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg",
          },
          success: res => {
            if (res && res.statusCode >= 200 && res.statusCode < 300) resolve(res);
            else reject(new Error("PUT 返回 " + (res && res.statusCode)));
          },
          fail: reject,
        });
      });

      wx.hideLoading();
      this.setData({
        "draft.logo": key,
        "draft.logoPreview": tempPath,
        logoUploading: false,
      });
      wx.showToast({ title: "已选好，点下面添加", icon: "none" });
    } catch (e) {
      wx.hideLoading();
      this.setData({ logoUploading: false });
      console.warn("[admin] 友链 logo 上传失败", e);
      wx.showModal({
        title: "上传失败",
        content: text_cfg.sync.offline_tip,
        showCancel: false,
        confirmText: "知道了",
      });
    }
  },

  clearLinkLogo() {
    this.setData({ "draft.logo": "", "draft.logoPreview": "" });
  },

  addLink() {
    const appid = String(this.data.draft.appid || "").trim();
    const name = String(this.data.draft.name || "").trim();
    const logo = String(this.data.draft.logo || "").trim();
    // 刚选的图只有本地临时路径，先记下来让列表能预览；保存后会被服务端换成 COS URL
    const logoPreview = logo ? String(this.data.draft.logoPreview || "") : "";

    if (!/^wx[0-9a-zA-Z]{16}$/.test(appid)) {
      wx.showToast({ title: "AppID 格式不对（wx 开头 18 位）", icon: "none" });
      return;
    }
    if (!name) {
      wx.showToast({ title: "请填写名称", icon: "none" });
      return;
    }
    if (name.length > 20) {
      wx.showToast({ title: "名称最多 20 字", icon: "none" });
      return;
    }
    if (this.data.links.some(l => l.appid === appid)) {
      wx.showToast({ title: "这个 AppID 已经在列表里了", icon: "none" });
      return;
    }
    if (this.data.links.length >= 20) {
      wx.showToast({ title: "最多 20 个", icon: "none" });
      return;
    }

    this.setData({
      links: this.data.links.concat([{ appid, name, logo, logoPreview }]),
      draft: { appid: "", name: "", logo: "", logoPreview: "" },
      linkDirty: true,
    });
  },

  deleteLink(e) {
    const appid = e.currentTarget.dataset.appid;
    if (!appid) return;
    wx.showModal({
      title: "删除友情链接",
      content: "确定移除这一项？保存后生效。",
      success: res => {
        if (!res.confirm) return;
        this.setData({
          links: this.data.links.filter(l => l.appid !== appid),
          linkDirty: true,
        });
      },
    });
  },

  moveLink(e) {
    const appid = e.currentTarget.dataset.appid;
    const dir = e.currentTarget.dataset.dir;
    const links = this.data.links.slice();
    const i = links.findIndex(l => l.appid === appid);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= links.length) return;
    const tmp = links[i];
    links[i] = links[j];
    links[j] = tmp;
    this.setData({ links, linkDirty: true });
  },

  async saveLinks() {
    if (this.data.linkSaving) return;

    const token = passcode.ensureToken();
    if (!token) return;

    this.setData({ linkSaving: true });

    const apps = this.data.links.map(l => ({
      appid: l.appid,
      name: l.name,
      logo: l.logo || "",
    }));

    const ok = await putInbox("manage", {
      action: "saveFriendLinks",
      token,
      apps,
    });
    this.setData({ linkSaving: false });

    if (!ok) {
      wx.showToast({ title: "提交失败，请检查网络", icon: "none" });
      return;
    }

    // 提交成功后，把本地列表里还没承诺的 pending key 就地换成聚合端最终会写出的公开地址。
    // 不换的话用户再点一次保存还会带上那个 pending key——而聚合端复制完就把 pending 原件删了，
    // 于是每次都在找一个不存在的源对象，永久报「未能查询源对象的状态」。
    // logoPreview（本机临时图）保留，所以列表缩略图在当前会话里照常显示。
    const baseUrl = String(config.data_base_url || "").replace(/\/+$/, "");
    if (baseUrl) {
      const links = this.data.links.map(l => {
        const logo = String(l.logo || "");
        if (!logo.startsWith("pending/")) return l;
        const ext = (logo.split(".").pop() || "jpg").toLowerCase().replace("jpeg", "jpg");
        return Object.assign({}, l, { logo: `${baseUrl}/photos/friendlink/${l.appid}.${ext}` });
      });
      this.setData({ links, linkDirty: false });
    } else {
      this.setData({ linkDirty: false });
    }
    // 友情链接是这一页唯一的收尾动作，保存完就返回，避免重复整批提交
    backAfterSubmit("友情链接已提交，后台几分钟内汇总生效", { delay: 1400 });
  },
});
