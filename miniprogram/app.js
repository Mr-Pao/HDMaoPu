import { checkUpdateVersion, getDateWithDiffHours } from './utils/utils';
import { app_version } from "./config";
import MPServerless from '@alicloud/mpserverless-sdk';
import { ensureCos } from './utils/common';
import { app_id, space_id, space_secret, space_endpoint } from './config'
import eventBus from './utils/eventBus';

const mpServerless = new MPServerless({
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
      tabDataPreloaded: false
    };

    this.initCos().then(() => {
      this.globalData.isReady = true;
      console.log(`[PERF] App launched in ${Date.now() - launchStartTime}ms`);
      
      // ????????????????? tab ????????
      this.preloadTabData();
    }).catch(() => {
      this.globalData.isReady = true;
      this.preloadTabData();
    });

    checkUpdateVersion();
  },

  async preloadTabData() {
    if (this.globalData.tabDataPreloaded) {
      return;
    }
    
    try {
      console.log('[PERF] ???????? tab ????');
      const startTime = Date.now();
      
      const app = this;
      
      // ????? info ????????
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
          console.warn('????? info ???????:', e);
        }
      };

      // ????? news ????????
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
          console.warn('????? news ???????:', e);
        }
      };

      // ????? leaderboard ????????
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
          console.warn('????? leaderboard ???????:', e);
        }
      };

      // ?????????????????
      await Promise.all([
        preloadInfoData(),
        preloadNewsData(),
        preloadLeaderboardData()
      ]);
      
      this.globalData.tabDataPreloaded = true;
      console.log(`[PERF] tab ???????????????? ${Date.now() - startTime}ms`);
    } catch (e) {
      console.error('????? tab ??????:', e);
    }
  },

  async initSDK() {
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