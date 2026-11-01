import { showTab } from "../../utils/page";
import { signCosUrl } from "../../utils/common";

const app = getApp();
const { applyNav } = require('../../utils/nav');

// 8 行：宽窄交替（0,2,4,6 宽行；1,3,5,7 窄行）
const ROWS = 8;
// 每行取多少张（复制一份后节点数翻倍：PER_ROW*2）
const PER_ROW = 12;
// 宽行 / 窄行时长（秒），错开速度才像各自漂流而不是一整块在平移
const WIDE_DUR = [52, 62, 56, 58];
const TALL_DUR = [44, 48, 40, 46];
// 首屏最多拉多少张照片用于铺墙
const FETCH_LIMIT = 60;

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

Page({
  jsData: {
    pool: [],
  },
  data: {
    loading: true,
    rows: [],
    total: 0,
    statusBarHeight: 20,
    navBarHeight: 44,
  },
  onShow: function () {
    applyNav(this);
    showTab(this);
  },
  onShareAppMessage: function () {
    const first = (this.jsData.pool[0] || {});
    return {
      title: this.data.total ? '火大猫谱 · 猫咪图库 ' + this.data.total + ' 张' : '火大猫谱 · 猫咪图库',
      path: '/pages/gallery/gallery',
      ...(first.thumb ? { imageUrl: first.thumb } : {})
    };
  },
  onShareTimeline: function () {
    return this.onShareAppMessage();
  },
  onLoad: function () {
    this.load();
  },
  onPullDownRefresh: function () {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  load: async function () {
    this.setData({ loading: true });

    let photos = [];
    try {
      const { result } = await app.mpServerless.db.collection('photo').find(
        { verified: true },
        { sort: { mdate: -1 }, limit: FETCH_LIMIT }
      );
      photos = result || [];
    } catch (e) {
      console.warn('[gallery] 照片加载失败', e);
    }

    if (!photos.length) {
      this.setData({ loading: false, rows: [], total: 0 });
      return;
    }

    // 总数单独 count，墙只铺首屏用量
    let total = photos.length;
    try {
      const { result } = await app.mpServerless.db.collection('photo').count({ verified: true });
      if (typeof result === 'number') total = result;
    } catch (e) {
      // 计数失败不影响出图
    }

    // 头像/图片直链：COS 公开读，signCosUrl 直接透传
    const pool = [];
    for (const p of photos) {
      const thumb = await signCosUrl(p.photo_compressed || p.photo_id);
      if (!thumb) continue;
      pool.push({
        thumb,
        full: await signCosUrl(p.photo_id) || thumb,
        name: (p.cat && p.cat.name) || '',
      });
    }

    this.jsData.pool = pool;
    this.buildRows(shuffle(pool));
    this.setData({ loading: false, total });
  },

  // 把图池铺成 8 行：每行取 PER_ROW 张再复制一份，靠 translateX(-50%) 无缝循环
  buildRows: function (pool) {
    if (!pool || !pool.length) {
      this.setData({ rows: [] });
      return;
    }
    const rows = [];
    for (let r = 0; r < ROWS; r++) {
      const base = [];
      for (let i = 0; i < PER_ROW; i++) {
        base.push(pool[(r * PER_ROW + i) % pool.length]);
      }
      const doubled = base
        .map((x, i) => ({ thumb: x.thumb, full: x.full, name: x.name, key: 'a' + r + '-' + i }))
        .concat(base.map((x, i) => ({ thumb: x.thumb, full: x.full, name: x.name, key: 'b' + r + '-' + i })));
      const isWide = r % 2 === 0;
      const idx = Math.floor(r / 2);
      rows.push({
        items: doubled,
        isWide,
        duration: isWide ? WIDE_DUR[idx] : TALL_DUR[idx],
      });
    }
    this.setData({ rows });
  },

  // 换一批：重新洗牌铺墙，每次看到的墙都不一样
  reshuffle: function () {
    const pool = this.jsData.pool || [];
    if (pool.length < 2) {
      wx.showToast({ title: '照片还不够，等等再来', icon: 'none' });
      return;
    }
    this.buildRows(shuffle(pool));
  },

  preview: function (e) {
    const { url } = e.currentTarget.dataset;
    if (!url) return;
    const urls = (this.jsData.pool || []).map(x => x.full).filter(Boolean);
    wx.previewImage({
      urls: urls.length ? urls : [url],
      current: url,
    });
  },
});
