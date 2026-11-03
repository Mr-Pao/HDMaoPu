// miniprogram/pages/info/info.js
import { text as text_cfg } from "../../config";
import { showTab } from "../../utils/page";

const share_text = text_cfg.app_name + ' - ' + text_cfg.info.share_tip;

const logo_img = "/pages/public/images/app_logo.png";

import { signCosUrl } from "../../utils/common";
import passcode from "../../utils/passcode";

const app = getApp();

const { applyNav } = require('../../utils/nav');

// 连击「关于」标题多少次才弹管理口令
const TAP_TO_UNLOCK = 5;
// 两次点击间隔超过这个毫秒数就重新计数（「连击」而不是「累计」）
const TAP_WINDOW = 800;

Page({
  // 非渲染数据（不进 setData，避免无谓的视图层通信）
  jsData: {
    linkFetchedAt: 0,
    tapCount: 0,
    tapAt: 0,
  },

  data: {
    logo_img,
    friendApps: [],
    friendLinkImgLoaded:false,
    text_cfg: text_cfg,

    nums: {},  // 菜单栏的各个数量
    // 菜单栏是否显示的条件
    showCond: {
      tools: true,
      dev: false,
      manager: false,
    },
    // 菜单列表
    menuList: [
      {
        title: "管理后台",
        show: "manager",
        items: [
          {
            name: "操作手册",
            path: "guide",
            icon: "icon-description",
            dot: true
          },
          {
            name: "审核队列",
            path: "/pages/manage/review/review",
            icon: "icon-check-square-o"
          },
          {
            name: "猫资料编辑",
            path: "/pages/manage/admin/admin?tab=cat",
            icon: "icon-edit"
          },
          {
            name: "照片审核",
            path: "/pages/manage/admin/admin?tab=photo",
            icon: "icon-photo-o"
          },
          {
            name: "友情链接",
            path: "/pages/manage/admin/admin?tab=link",
            icon: "icon-cluster-o"
          },
          {
            name: "反馈处理",
            path: "/pages/manage/checkFeedbacks/checkFeedbacks",
            num: "numFeedbacks",
            icon: "icon-envelop-o"
          },
          {
            name: "猫抓板公告",
            path: "/pages/manage/newsAdmin/newsAdmin",
            icon: "icon-edit"
          },
          {
            name: "位置/区域/花色",
            path: "/pages/manage/filters/filters",
            icon: "icon-location-o"
          },
          {
            name: "猫猫管理",
            path: "/pages/manage/catManage/catManage",
            icon: "icon-manager-o"
          }
        ]
      }
    ],

  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    // 开发模式
    const sysInfo = wx.getSystemInfoSync();
    this.setData({
      "showCond.dev": sysInfo.platform === "devtools"
    });
  },

  // 友情链接：后台（管理后台 → 友情链接）可增删，这里每次进页面拉一次，
  // 5 分钟内复用，避免返回本页时看到旧列表。
  async loadFriendLinks() {
    const now = Date.now();
    if (now - (this.jsData.linkFetchedAt || 0) < 5 * 60 * 1000) return;
    this.jsData.linkFetchedAt = now;

    try {
      const { result: friendLinkRes } = await app.mpServerless.db.collection('setting').findOne({ _id: 'friendLink' });

      // 找不到配置（或没有 apps 字段）时兜底为空数组，避免解包报错
      let { apps } = friendLinkRes || {};
      apps = apps || [];
      for (let i = 0; i < apps.length; i++) {
        apps[i].logo = await signCosUrl(apps[i].logo);
        // 后台可新增不填 logo 的链接，这里备好占位字（WXML 里不好对字符串取首字）
        apps[i].initial = String(apps[i].name || "?").slice(0, 1);
      }
      this.setData({ friendApps: apps });
    } catch (e) {
      console.warn('[INFO] 友情链接加载失败', e);
    }
  },

  // 用 onShow 不用 onLoad，为了在返回这个页面时也能重新加载
  onShow: async function () {
    applyNav(this);
    // 切换自定义tab
    showTab(this);
    // 友情链接可能在管理后台被增删，回到本页时按 5 分钟节流重新拉一次
    this.loadFriendLinks();

    // 已解锁过管理后台的，进页面直接把菜单放出来（不用再连击）
    this.setData({ "showCond.manager": this.isUnlocked() });

    // 获取version
    this.setData({
      version: getApp().globalData.version
    });

    // 首次加载或超过5分钟才刷新数据
    const lastRefresh = wx.getStorageSync('infoPageLastRefresh') || 0;
    const now = Date.now();
    
    if (now - lastRefresh < 5 * 60 * 1000 && this.data.numAllCats) {
      // 5分钟内已刷新过，使用缓存数据
      return;
    }

    let numAllCats, numAllPhotos, numAllComments, numSterilized, numAdoptQf, numCurrentCats;

    // 尝试使用预加载数据
    const preloadedData = wx.getStorageSync('infoPagePreload');
    if (preloadedData && preloadedData.timestamp && now - preloadedData.timestamp < 5 * 60 * 1000) {
      numAllCats = preloadedData.numAllCats;
      numAllPhotos = preloadedData.numAllPhotos;
      numAllComments = preloadedData.numAllComments;
      numSterilized = preloadedData.numSterilized;
      numAdoptQf = preloadedData.numAdoptQf;
      numCurrentCats = preloadedData.numCurrentCats;
    } else {
      // 获取普通用户也能看的数据
      // 所有猫猫数量
      const allCatQf = {};
      // 所有照片数量
      const allPhotoQf = { verified: true };
      // 所有便利贴数量
      const allCommentQf = { deleted: { $ne: true }, needVerify: { $ne: true } };
      // 所有领养
      const adoptQf = { adopt: 1 };
      // 所有绝育量
      const sterilizedQf = { sterilized: true };
      // 去除已领养、失踪、去喵星的猫猫
      const currentCatsQf = {
        adopt: { $ne: 1 },
        to_star: { $ne: true },
        missing: { $ne: true }
      };

      // 并行执行数据库查询
      const [
        { result: nc },
        { result: np },
        { result: ncmt },
        { result: ns },
        { result: na },
        { result: ncc }
      ] = await Promise.all([
        app.mpServerless.db.collection('cat').count(allCatQf),
        app.mpServerless.db.collection('photo').count(allPhotoQf),
        app.mpServerless.db.collection('comment').count(allCommentQf),
        app.mpServerless.db.collection('cat').count(sterilizedQf),
        app.mpServerless.db.collection('cat').count(adoptQf),
        app.mpServerless.db.collection('cat').count(currentCatsQf)
      ]);
      
      numAllCats = nc;
      numAllPhotos = np;
      numAllComments = ncmt;
      numSterilized = ns;
      numAdoptQf = na;
      numCurrentCats = ncc;
    }

    // 更新刷新时间
    wx.setStorageSync('infoPageLastRefresh', now);

    // 计算绝育率
    const adoptRate = (numAdoptQf / numAllCats * 100).toFixed(1);
    const sterilizationRate = (numSterilized / numAllCats * 100).toFixed(1);

    this.setData({
      numAllCats: numAllCats,
      numAllPhotos: numAllPhotos,
      numAllComments: numAllComments,
      sterilizationRate: sterilizationRate + '%',
      adoptRate: adoptRate + '%',
      currentCatsCount: numCurrentCats,
    });

    if (!this.isUnlocked()) {
      return;
    }

    // 待处理照片 / 反馈
    const { result: numChkPhotos } = await app.mpServerless.db.collection('photo').count({ verified: false });
    const { result: numFeedbacks } = await app.mpServerless.db.collection('feedback').count({ dealed: false });
    this.setData({
      "nums.numChkPhotos": numChkPhotos,
      "nums.numFeedbacks": numFeedbacks,
      "showCond.manager": true,
    });
  },

  // ---------- 管理后台入口：连击「关于」标题 5 次 → 口令 → 解锁 ----------
  //
  // 口令存在 data/gate.json 的 code 字段，改完 push cos 自动同步 COS，无需发版。
  // data/ 是公开 CDN，口令等于公开——它只是「别让普通用户误入」的 UX 门，
  // 真正的写入权限仍在 Actions 端 REVIEW_PASSCODE。

  isUnlocked() {
    // 统一走 utils/passcode：关于页和管理后台必须看同一个标记，
    // 否则会出现「已解锁管理后台，但提交时说没设置口令」的矛盾。
    return passcode.isUnlocked();
  },

  setUnlocked(v) {
    passcode.setUnlocked(v);
    if (!v) {
      // 退出解锁时一并清掉提交用的口令，避免留下一个用不了的 token
      passcode.setToken("");
    }
  },

  // 远端读口令。不缓存：改完 data/gate.json 下次连击就生效，不用重启小程序
  async loadGateCode() {
    try {
      const { result } = await app.mpServerless.db.collection('gate').findOne({ _id: 'gate' });
      return String((result && result.code) || '').trim();
    } catch (e) {
      console.warn('[INFO] 口令配置读取失败', e);
      return '';
    }
  },

  // 连击计数：间隔超 TAP_WINDOW 就重新从 1 数
  onTitleTap() {
    const now = Date.now();
    if (now - (this.jsData.tapAt || 0) > TAP_WINDOW) {
      this.jsData.tapCount = 0;
    }
    this.jsData.tapAt = now;
    this.jsData.tapCount = (this.jsData.tapCount || 0) + 1;

    if (this.jsData.tapCount < TAP_TO_UNLOCK) return;

    this.jsData.tapCount = 0;
    // 已解锁且本机还有口令就别再骚扰；只解锁没口令（旧版本状态）要补一次
    if (this.isUnlocked() && passcode.hasToken()) {
      this.setData({ "showCond.manager": true });
      return;
    }
    this.askAdminPasscode();
  },

  async askAdminPasscode() {
    const code = await this.loadGateCode();
    if (!code) {
      wx.showModal({
        title: '管理入口未启用',
        content: '远端还没有配置管理口令（data/gate.json 的 code 为空）。',
        showCancel: false,
      });
      return;
    }

    // 走自绘弹层：原生 input，键盘右下角「完成」= 确认（不是换行）。
    // 用 promptToken 而不是 wx.showModal，口令校验由 validate 回调负责，
    // 错了停在弹层里显示红字，不关掉重新弹。
    passcode.promptToken({
      title: '管理口令',
      placeholder: '输入管理口令',
      confirmText: '进入',
      validate: input => (input === code ? '' : '口令不对'),
      onSaved: input => {
        this.setUnlocked(true);
        // 连击时输的就是管理口令，顺手存下来：管理后台提交要用同一个值，
        // 不存的话进去还会再弹一次「还没设置管理口令」。
        passcode.setToken(input);
        this.setData({ "showCond.manager": true });
        wx.showToast({ title: '已进入管理后台', icon: 'none' });
        // 解锁后补拉一次待处理数量
        this.refreshManagerNums && this.refreshManagerNums();
      },
    });
  },

  // 解锁后补算管理角标（onShow 的早退分支不会再跑一遍）
  async refreshManagerNums() {
    try {
      const { result: numChkPhotos } = await app.mpServerless.db.collection('photo').count({ verified: false });
      const { result: numFeedbacks } = await app.mpServerless.db.collection('feedback').count({ dealed: false });
      this.setData({
        "nums.numChkPhotos": numChkPhotos,
        "nums.numFeedbacks": numFeedbacks,
        "showCond.manager": true,
      });
    } catch (e) {
      console.warn('[INFO] 管理角标刷新失败', e);
    }
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    return {
      title: share_text
    }
  },

  onShareTimeline:function () {
    return {
      title: share_text,
    }
  },

  clickbtn(e) {
    const to = e.currentTarget.dataset.to;
    if (!to) {
      return false;
    }
    // 失效写功能的菜单项：拦截跳转，只给提示
    if (e.currentTarget.dataset.disabled) {
      wx.showToast({
        title: '此功能需服务端支持，暂未开放',
        icon: 'none'
      });
      return false;
    }
    const actionMap = {
      guide: () => this.guide(e),
      // 可扩展
    };
    const action = actionMap[to];
    if (action) {
      return action();
    }
    wx.navigateTo({
      url: to,
    });
  },

  clickFriendLink(e) {
    const appid = e.currentTarget.dataset.appid;
    wx.navigateToMiniProgram({
      appId: appid
    })
  },

  async showLogo(e) {
    wx.previewImage({
      urls: [await signCosUrl(logo_img)],
      fail: function (e) {
        console.error(e)
      }
    }) 
  },

  // 打开管理员手册tx文档
  guide(e) {
    wx.showModal({
      title: '操作文档请查看github仓库文档链接',
      content: 'laf版文档链接也在仓库md文件中',
      showCancel: true,
    })
  },
});