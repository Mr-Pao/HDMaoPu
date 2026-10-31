import { checkUpdateVersion, getDateWithDiffHours } from './utils/utils';
import { app_version, demo_mode, data_base_url } from "./config";
import eventBus from './utils/eventBus';
import { createMockMpServerless } from './utils/demo';
import { createJsonServerless } from './utils/datasource';

let mpServerless;
// 三种运行模式，优先级：demo_mode > 远程 JSON > demo 兜底
//   demoMode = 本地硬编码假数据（utils/demo.js），保命预览用
//   dataMode = COS 上的 data/<collection>.json，内存查询
let demoMode = false;
let dataMode = false;

if (demo_mode === true) {
  demoMode = true;
  console.log('[Mode] demo_mode = true，使用本地假数据');
  mpServerless = createMockMpServerless();
} else if (data_base_url) {
  dataMode = true;
  console.log('[Mode] 使用 COS 静态数据源：' + data_base_url);
  mpServerless = createJsonServerless({ baseUrl: data_base_url });
} else {
  // data_base_url 没配时退回 demo，不要让页面白屏
  demoMode = true;
  console.warn('[Mode] data_base_url 未配置，退回 demo 模式（本地假数据）');
  mpServerless = createMockMpServerless();
}

const launchStartTime = Date.now();

App({
  // globalData 先给初始值（含 version），页面 onShow 等早于 onLaunch 完成的读取不会拿到 undefined
  globalData: {
    version: app_version,
    eventBus: eventBus,
    demoMode: demoMode,
    dataMode: dataMode,
    isReady: false,
    tabDataPreloaded: false
  },

  async onLaunch() {
    this.launchStartTime = launchStartTime;

    await Promise.all([
      this.initSDK(),
      this.checkCacheValidity()
    ]);

    this.globalData = {
      version: app_version,
      eventBus: eventBus,
      demoMode: demoMode,
      dataMode: dataMode,
      isReady: false,
      tabDataPreloaded: false
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
    // datasource 没有异步初始化步骤，保留这个钩子让 onLaunch 流程不变
    return;
  },

  async initCos() {
    // EMAS 下线后没有云函数签发临时密钥，COS 客户端不再初始化；
    // 照片走公有读直链（见 utils/common.js 里 signCosUrl 的 dataMode 分支）
    this.cos = null;
  },

  async checkCacheValidity() {
    const clearDay = wx.getStorageSync('clear-all-cache');
    if (!clearDay || new Date(clearDay) < new Date()) {
      try {
        // data/ 的 JSON 缓存和本地覆盖层必须留着：
        // 否则每 48 小时清一次，断网启动就只剩空列表
        const keep = this._snapshotDataSourceCache();
        wx.clearStorageSync();
        this._restoreDataSourceCache(keep);
      } catch (e) {
        console.warn('Failed to clear storage:', e);
      }
      wx.setStorageSync('clear-all-cache', getDateWithDiffHours(48));
    }
  },

  _snapshotDataSourceCache() {
    const keep = {};
    try {
      const keys = wx.getStorageInfoSync().keys || [];
      keys.forEach(key => {
        if (key.indexOf('ds_cache_') === 0 || key.indexOf('ds_local_') === 0 || key === 'fake_openid') {
          keep[key] = wx.getStorageSync(key);
        }
      });
    } catch (e) {
      console.warn('读取缓存键失败:', e.message);
    }
    return keep;
  },

  _restoreDataSourceCache(keep) {
    try {
      Object.keys(keep).forEach(key => wx.setStorageSync(key, keep[key]));
    } catch (e) {
      console.warn('恢复数据源缓存失败:', e.message);
    }
  },

  mpServerless: mpServerless,
  cos: null,
  launchStartTime: launchStartTime
});
