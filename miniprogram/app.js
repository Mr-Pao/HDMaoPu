import { checkUpdateVersion, getDateWithDiffHours } from './utils/utils';
import { app_version } from "./config";
import { ensureCos } from './utils/common';
import { app_id, space_id, space_secret, space_endpoint } from './config'
import eventBus from './utils/eventBus';
import { createMockMpServerless } from './utils/demo';

let mpServerless;
let demoMode = false;

// 这里必须用 require 而不是 import：SDK 缺失时能在运行时降级，
// 换成 import 会在编译期直接报错，降级逻辑就失效了。
try {
  var MPServerless = require('@alicloud/mpserverless-sdk');
  mpServerless = new MPServerless({
    uploadFile: wx.uploadFile,
    request: wx.request,
    getAuthCode: wx.login,
    getFileInfo: wx.getFileInfo,
    getImageInfo: wx.getImageInfo,
  }, {
    appId: app_id,
    spaceId: space_id,
    clientSecret: space_secret,
    endpoint: space_endpoint,
  });
} catch (e) {
  console.warn('[EMAS] SDK 加载失败，进入离线 Demo 模式:', e.message);
  mpServerless = createMockMpServerless();
  demoMode = true;
}

const launchStartTime = Date.now();

App({
  async onLaunch() {
    this.launchStartTime = launchStartTime;

    await Promise.all([
      this.initSDK(),
      this.checkCacheValidity()
    ]);

    this.globalData = {
      version: app_version,
      eventBus: eventBus,
      isReady: false,
      tabDataPreloaded: false,
      demoMode: demoMode
    };

    this.initCos().then(() => {
      this.globalData.isReady = true;
      console.log(`[PERF] App launched in ${Date.now() - launchStartTime}ms`);
      // 应用就绪后预加载 tab 数据
      this.preloadTabData();
    }).catch((e) => {
      console.warn('[COS] 初始化失败:', e && e.message);
      this.globalData.isReady = true;
      this.preloadTabData();
    });

    checkUpdateVersion();
  },

  async preloadTabData() {
    if (this.globalData.tabDataPreloaded || demoMode) {
      return;
    }

    try {
      console.log('[PERF] 开始预加载 tab 数据');
      const startTime = Date.now();

      const app = this;

      // 预加载 info 页统计数据
      const preloadInfoData = async () => {
        try {
          const [
            { result: numAllCats },
            { result: numAllPhotos },
            { result: numAllComments },
            { result: numSterilized },
            { result: numAdoptQf },
            { result: numCurrentCats }
          ] = await Promise.all([
            app.mpServerless.db.collection('cat').count({}),
            app.mpServerless.db.collection('photo').count({ verified: true }),
            app.mpServerless.db.collection('comment').count({ deleted: { $ne: true }, needVerify: { $ne: true } }),
            app.mpServerless.db.collection('cat').count({ sterilized: true }),
            app.mpServerless.db.collection('cat').count({ adopt: 1 }),
            app.mpServerless.db.collection('cat').count({ adopt: { $ne: 1 }, to_star: { $ne: true }, missing: { $ne: true } })
          ]);

          wx.setStorageSync('infoPagePreload', {
            numAllCats,
            numAllPhotos,
            numAllComments,
            numSterilized,
            numAdoptQf,
            numCurrentCats,
            timestamp: Date.now()
          });
        } catch (e) {
          console.warn('预加载 info 页数据失败:', e);
        }
      };

      // 预加载 news 页数据
      const preloadNewsData = async () => {
        try {
          const { result: newsList } = await app.mpServerless.db.collection('news').find({
            show: true
          }, {
            sort: { time: -1 },
            limit: 10
          });

          wx.setStorageSync('newsPagePreload', {
            newsList,
            timestamp: Date.now()
          });
        } catch (e) {
          console.warn('预加载 news 页数据失败:', e);
        }
      };

      // 预加载排行榜数据
      const preloadLeaderboardData = async () => {
        try {
          const { result: cats } = await app.mpServerless.db.collection('cat').find({
            adopt: { $ne: 1 },
            to_star: { $ne: true },
            missing: { $ne: true }
          }, {
            sort: { popularity: -1 },
            limit: 20
          });

          wx.setStorageSync('leaderboardPagePreload', {
            cats,
            timestamp: Date.now()
          });
        } catch (e) {
          console.warn('预加载排行榜数据失败:', e);
        }
      };

      // 三份数据并行拉取，互不阻塞
      await Promise.all([
        preloadInfoData(),
        preloadNewsData(),
        preloadLeaderboardData()
      ]);

      this.globalData.tabDataPreloaded = true;
      console.log(`[PERF] tab 数据预加载完成，耗时 ${Date.now() - startTime}ms`);
    } catch (e) {
      console.error('预加载 tab 数据失败:', e);
    }
  },

  async initSDK() {
    if (demoMode) {
      return;
    }
    return mpServerless.init();
  },

  async initCos() {
    this.cos = await ensureCos();
  },

  async checkCacheValidity() {
    const clearDay = wx.getStorageSync('clear-all-cache');
    if (!clearDay || new Date(clearDay) < new Date()) {
      try {
        wx.clearStorageSync();
      } catch (e) {
        console.warn('Failed to clear storage:', e);
      }
      wx.setStorageSync('clear-all-cache', getDateWithDiffHours(48));
    }
  },

  mpServerless: mpServerless,
  cos: null,
  launchStartTime: launchStartTime
});
