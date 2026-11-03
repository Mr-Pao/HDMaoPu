// miniprogram/pages/info/info.js
import { text as text_cfg } from "../../config";
import { showTab } from "../../utils/page";

const share_text = text_cfg.app_name + ' - ' + text_cfg.info.share_tip;

const logo_img = "/pages/public/images/app_logo.png";

import { signCosUrl } from "../../utils/common";
import passcode from "../../utils/passcode";

const app = getApp();

const { applyNav } = require('../../utils/nav');

Page({
  // 非渲染数据（不进 setData，避免无谓的视图层通信）
  jsData: {
    linkFetchedAt: 0,
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
    // v4.0.65 按「一个对象一个入口」重组：删掉「审核队列」（review_queue.json 永不上 CDN，
    // 小程序端恒为空态，真正的审核在 GitHub Issue 里评论 /ok）、「猫资料编辑」（与猫猫管理重复）、
    // 「照片审核」（已并入猫猫管理的照片卡）。
    // v4.0.66 再去掉「操作手册」：它原本只弹一个「文档见 GitHub 仓库」的 modal，没有实际功能。
    // v4.0.67 加回「审核队列」：聚合端现在会把待审项导出成脱敏快照 data/pending.json
    // （剥掉 openid）上 CDN，小程序端终于读得到了。
    menuList: [
      {
        title: "管理后台",
        show: "manager",
        items: [
          {
            name: "审核队列",
            path: "/pages/manage/review/review",
            num: "numPending",
            icon: "icon-todo-list-o"
          },
          {
            name: "猫猫管理",
            path: "/pages/manage/catManage/catManage",
            num: "numChkPhotos",
            icon: "icon-manager-o"
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
            name: "友情链接",
            path: "/pages/manage/admin/admin",
            icon: "icon-cluster-o"
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

    // 待处理照片 / 反馈 / 待审核项（pending 快照）
    const { result: numChkPhotos } = await app.mpServerless.db.collection('photo').count({ verified: false });
    const { result: numFeedbacks } = await app.mpServerless.db.collection('feedback').count({ dealed: false });
    const { result: numPending } = await app.mpServerless.db.collection('pending').count({});
    this.setData({
      "nums.numChkPhotos": numChkPhotos,
      "nums.numFeedbacks": numFeedbacks,
      "nums.numPending": numPending,
      "showCond.manager": true,
    });
  },

  // 管理入口已迁到首页（连击「火大猫谱」标题 5 次 → 口令 → 版本切换面板）。
  // 这里只保留「是否已解锁」的读取：管理菜单仍在本页，靠它显隐。
  isUnlocked() {
    return passcode.isUnlocked();
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
});