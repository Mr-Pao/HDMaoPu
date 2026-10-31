// 管理后台：猫资料编辑 + 照片下架/恢复
//
// 口令模型：
//   - 小程序包里不再内置口令（config.review_passcode 已删除）。
//   - 用户手动输入口令，只存在手机本地 storage，客户端不做对错校验（非空即放行）。
//   - 真正的校验在 GitHub Actions 聚合端（process-inbox.js 的 tokenOk），
//     口令不对的 manage 提交会被自动丢弃。
//
// 数据流（与 review 页共用 storage 口令）：
//   表单/开关 → putInbox('manage', { action, token, ... }) → COS inbox/manage/
//   → Actions 每小时聚合 → data/cat.json / data/photo.json

import { putInbox } from "../../../utils/writeback";
import { text as text_cfg } from "../../../config";

const app = getApp();

const PASSCODE_KEY = "manage_passcode";
const PASSCODE_TS_KEY = "manage_passcode_ts";
const PASSCODE_TTL = 24 * 60 * 60 * 1000; // 24 小时免输入

// 与聚合端 MANAGE_CAT_PATCH_FIELDS 保持一致的字段口径
const GENDER_OPTIONS = ["公", "母", "未知"];
const ADOPT_OPTIONS = text_cfg.cat_status_adopt; // ["未领养", "已领养", "寻找领养中"]

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = n => (n < 10 ? "0" + n : "" + n);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

Page({
  data: {
    unlocked: false,
    passcode: "",

    tab: "cat", // cat | photo

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
  },

  jsData: {
    cats: [],
    currentCatId: "",
  },

  onLoad() {
    if (this.hasValidPasscode()) {
      this.setData({ unlocked: true });
      this.loadCats();
    }
  },

  // ---------- 口令门 ----------

  hasValidPasscode() {
    const ts = Number(wx.getStorageSync(PASSCODE_TS_KEY) || 0);
    return !!wx.getStorageSync(PASSCODE_KEY) && ts && Date.now() - ts < PASSCODE_TTL;
  },

  onPasscodeInput(e) {
    this.setData({ passcode: e.detail.value });
  },

  unlock() {
    const input = String(this.data.passcode || "").trim();
    if (!input) {
      wx.showToast({ title: "请输入口令", icon: "none" });
      return;
    }
    // 不做对错校验：真校验在 Actions 端，错口令的提交会被自动丢弃
    wx.setStorageSync(PASSCODE_KEY, input);
    wx.setStorageSync(PASSCODE_TS_KEY, Date.now());
    this.setData({ unlocked: true, passcode: "" });
    this.loadCats();
  },

  lock() {
    wx.removeStorageSync(PASSCODE_KEY);
    wx.removeStorageSync(PASSCODE_TS_KEY);
    this.setData({ unlocked: false, photos: [], photoCatIndex: -1, catIndex: -1 });
  },

  // ---------- 公共 ----------

  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab && tab !== this.data.tab) this.setData({ tab });
  },

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
    return String(wx.getStorageSync(PASSCODE_KEY) || "");
  },

  submitToast() {
    wx.showToast({
      title: "已提交，最长约1小时生效（可在 GitHub Actions 手动运行 process-inbox 立即聚合）",
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
      token: this.getToken(),
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

    wx.showLoading({ title: "提交中", mask: true });
    const ok = await putInbox("manage", {
      action: "managePhoto",
      token: this.getToken(),
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
});
