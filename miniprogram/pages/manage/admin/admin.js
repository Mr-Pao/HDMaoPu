// 管理后台（三个独立入口，共用本页，靠 ?tab= 区分）：
//   猫资料编辑 ?tab=cat / 照片审核 ?tab=photo / 友情链接 ?tab=link
//   入口都在「关于 → 管理后台」的菜单列表里，页面内没有 tab 切换。
//
// 口令模型（v4.0.33 起不再有锁屏口令门）：
//   - 本页没有锁屏，进来直接能用；右上角「口令」按钮输一次，永久存本机 storage。
//   - 小程序包里不内置口令（config.review_passcode 已删除），口令绝不写进小程序包。
//   - 真正的校验在 GitHub Actions 聚合端（process-inbox.js 的 tokenOk），
//     口令不对的 manage 提交会被自动丢弃，页面不会有任何报错——所以提交前必须确认本机已存口令。
//
// 数据流（与 review 页共用 storage 口令）：
//   表单/开关 → putInbox('manage', { action, token, ... }) → COS inbox/manage/
//   → Actions 每小时聚合 → data/cat.json / data/photo.json

import { putInbox } from "../../../utils/writeback";
import { text as text_cfg } from "../../../config";

const passcode = require("../../../utils/passcode");

const app = getApp();

// 与聚合端 MANAGE_CAT_PATCH_FIELDS 保持一致的字段口径
const GENDER_OPTIONS = ["公", "母", "未知"];
const ADOPT_OPTIONS = text_cfg.cat_status_adopt; // ["未领养", "已领养", "寻找领养中"]

// 「关于 → 管理后台」里的三个菜单项各自带 ?tab= 打开本页，
// 所以页面内不再有 tab 切换，进来看到的就是那一块。
const TAB_META = {
  cat: "猫资料编辑",
  photo: "照片审核",
  link: "友情链接",
};

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = n => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

Page({
  data: {
    hasToken: false, // 本机是否已存管理口令（只控制右上角提示条显隐）

    tab: "cat", // cat | photo | link，由 onLoad 的 ?tab= 决定
    pageTitle: TAB_META.cat,

    // 猫列表（picker 用）
    catNames: [],
    catIndex: -1,

    // Tab1 表单
    form: {
      name: "",
      nickname: "",
      gender: "",
      campus: "",
      area: "",
      colour: "",
      birthday: "",
      characteristics: "",
      habit: "",
      tutorial: "",
      sterilized: false,
      adopt: 0,
      adoptTime: "",
      missing: false,
      to_star: false,
    },
    genderOptions: GENDER_OPTIONS,
    adoptOptions: ADOPT_OPTIONS,
    saving: false,

    // Tab2 照片
    photoCatIndex: -1,
    photos: [],
    photoLoading: false,

    // Tab3 友情链接
    links: [],
    linkLoading: false,
    linkSaving: false,
    linkDirty: false,
    draft: { appid: "", name: "", logo: "" },
  },

  jsData: {
    cats: [],
    currentCatId: "",
  },

  onLoad(options) {
    // 「关于 → 管理后台」的三个菜单项分别带 ?tab=cat|photo|link 进来
    const tab = TAB_META[(options && options.tab) || ""] ? options.tab : "cat";
    this.setData({ tab, pageTitle: TAB_META[tab], hasToken: passcode.hasToken() });
    wx.setNavigationBarTitle({ title: TAB_META[tab] });

    // 本页没有口令门，进来直接加载当前 tab
    this.loadCurrentTab();
  },

  onShow() {
    // 用户可能在其他页/其他入口刚存过口令，每次回来同步一次
    const hasToken = passcode.hasToken();
    if (hasToken !== this.data.hasToken) this.setData({ hasToken });
  },

  // 按当前 tab 做一次首次加载
  loadCurrentTab() {
    if (this.data.tab === "link") {
      this.loadLinks();
    } else {
      this.loadCats();
    }
  },

  // ---------- 口令 ----------

  // 右上角「口令」按钮：输一次永久存本机（提交时随请求上传，真校验在 Actions 端）
  editToken() {
    passcode.promptToken({
      onSaved: () => {
        const hasToken = passcode.hasToken();
        this.setData({ hasToken });
        wx.showToast({ title: hasToken ? "口令已保存" : "已清除口令", icon: "none" });
      },
    });
  },

  // 提交前检查：没有口令就不让提交（否则后台会静默丢弃）
  // 返回 true 表示可以继续，false 表示已拦下
  ensureToken(token) {
    if (token) return true;
    wx.showModal({
      title: "还没设置管理口令",
      content: "提交需要管理口令，否则后台会直接丢弃。现在设置吗？",
      confirmText: "去设置",
      success: r => {
        if (r.confirm) this.editToken();
      },
    });
    return false;
  },

  // ---------- 公共 ----------

  async loadCats() {
    try {
      const res = await app.mpServerless.db.collection("cat").get();
      const cats = ((res && res.result && res.result.data) || []).filter(c => c && c._id);
      this.jsData.cats = cats;
      this.setData({
        catNames: cats.map(c => c.name || c.nickname || c._id),
      });
    } catch (e) {
      console.warn("[admin] 猫列表加载失败", e);
      wx.showToast({ title: "猫列表加载失败", icon: "none" });
    }
  },

  getToken() {
    return passcode.getToken();
  },

  submitToast() {
    wx.showToast({
      title: "已提交，后台几分钟内自动汇总生效（可在 GitHub Actions 手动运行 process-inbox 立即聚合）",
      icon: "none",
      duration: 3500,
    });
  },

  // ---------- Tab1 猫资料编辑 ----------

  onCatPick(e) {
    const idx = Number(e.detail.value);
    this.setData({ catIndex: idx });
    const cat = this.jsData.cats[idx];
    if (!cat) return;
    this.jsData.currentCatId = cat._id;
    this.setData({
      form: {
        name: cat.name || "",
        nickname: cat.nickname || "",
        gender: cat.gender || "未知",
        campus: cat.campus || "",
        area: cat.area || "",
        colour: cat.colour || "",
        birthday: cat.birthday || "",
        characteristics: cat.characteristics || "",
        habit: cat.habit || "",
        tutorial: cat.tutorial || "",
        sterilized: cat.sterilized === true,
        adopt: Number(cat.adopt) || 0,
        adoptTime: formatDate(cat.adopt_time),
        missing: cat.missing === true,
        to_star: cat.to_star === true,
      },
    });
  },

  onFieldInput(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ ["form." + field]: e.detail.value });
  },

  onGenderPick(e) {
    this.setData({ "form.gender": GENDER_OPTIONS[Number(e.detail.value)] });
  },

  onAdoptPick(e) {
    this.setData({ "form.adopt": Number(e.detail.value) });
  },

  onBirthdayPick(e) {
    this.setData({ "form.birthday": e.detail.value });
  },

  onAdoptTimePick(e) {
    this.setData({ "form.adoptTime": e.detail.value });
  },

  onSwitch(e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;
    this.setData({ ["form." + field]: e.detail.value });
  },

  async saveCat() {
    const { form } = this.data;
    if (!this.jsData.currentCatId) {
      wx.showToast({ title: "请先选择猫猫", icon: "none" });
      return;
    }
    if (this.data.saving) return;

    // 提交前先确认本机有口令，否则后台会静默丢弃
    const token = this.getToken();
    if (!this.ensureToken(token)) return;

    this.setData({ saving: true });

    const patch = {};
    if (form.name !== undefined && form.name !== null) patch.name = String(form.name).trim();
    patch.nickname = String(form.nickname || "").trim();
    patch.gender = form.gender || "未知";
    patch.campus = String(form.campus || "").trim();
    patch.area = String(form.area || "").trim();
    patch.colour = String(form.colour || "").trim();
    patch.birthday = String(form.birthday || "").trim();
    patch.characteristics = String(form.characteristics || "").trim();
    patch.habit = String(form.habit || "").trim();
    patch.tutorial = String(form.tutorial || "").trim();
    patch.sterilized = form.sterilized === true;
    patch.adopt = Number(form.adopt) || 0;
    patch.adopt_time = form.adoptTime || "";
    patch.missing = form.missing === true;
    patch.to_star = form.to_star === true;

    const ok = await putInbox("manage", {
      action: "updateCat",
      token,
      cat_id: this.jsData.currentCatId,
      patch,
    });
    this.setData({ saving: false });

    if (!ok) {
      wx.showToast({ title: "提交失败，请检查网络", icon: "none" });
      return;
    }
    this.submitToast();
  },

  // ---------- Tab2 照片审核 ----------

  onPhotoCatPick(e) {
    const idx = Number(e.detail.value);
    this.setData({ photoCatIndex: idx });
    this.loadPhotos(idx);
  },

  async loadPhotos(idx) {
    const cat = this.jsData.cats[idx];
    if (!cat) return;
    this.setData({ photoLoading: true, photos: [] });
    try {
      // 注意：这里不过滤 hidden，管理端要能看到已下架的照片才能恢复
      const res = await app.mpServerless.db.collection("photo").find({ cat_id: cat._id });
      const list = ((res && res.result) || []).filter(p => p && p._id);
      this.setData({
        photos: list.map(p => ({
          _id: p._id,
          url: p.photo_compressed || p.photo_watermark || p.photo_id || "",
          hidden: p.hidden === true,
        })),
        photoLoading: false,
      });
    } catch (e) {
      console.warn("[admin] 照片加载失败", e);
      this.setData({ photoLoading: false });
      wx.showToast({ title: "照片加载失败", icon: "none" });
    }
  },

  async togglePhoto(e) {
    const id = e.currentTarget.dataset.id;
    const hidden = e.currentTarget.dataset.hidden === true;
    if (!id) return;

    const token = this.getToken();
    if (!this.ensureToken(token)) return;

    wx.showLoading({ title: "提交中", mask: true });
    const ok = await putInbox("manage", {
      action: "managePhoto",
      token,
      photo_id: id,
      hidden: !hidden,
    });
    wx.hideLoading();

    if (!ok) {
      wx.showToast({ title: "提交失败，请检查网络", icon: "none" });
      return;
    }

    // 本地先翻转状态，实际生效要等下一次聚合
    const photos = this.data.photos.map(p => (p._id === id ? Object.assign({}, p, { hidden: !hidden }) : p));
    this.setData({ photos });
    this.submitToast();
  },

  // ---------- Tab3 友情链接 ----------
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
        links: apps.map(a => ({ appid: a.appid, name: a.name || "", logo: a.logo || "" })),
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

  addLink() {
    const appid = String(this.data.draft.appid || "").trim();
    const name = String(this.data.draft.name || "").trim();
    const logo = String(this.data.draft.logo || "").trim();

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
      links: this.data.links.concat([{ appid, name, logo }]),
      draft: { appid: "", name: "", logo: "" },
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

    const token = this.getToken();
    if (!this.ensureToken(token)) return;

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
    this.setData({ linkDirty: false });
    this.submitToast();
  },
});
