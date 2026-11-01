import { showTab } from "../../utils/page";
import { signCosUrl } from "../../utils/common";

const app = getApp();
const { applyNav } = require('../../utils/nav');

// 8 行，按 4 行一个循环做三档行高：hero / tall / wide / tall
const ROWS = 8;
// 每行取多少张（复制一份后节点数翻倍）
const PER_ROW = 12;
// 首屏最多拉多少张照片用于铺墙
const FETCH_LIMIT = 60;

// 行高与格宽三档：hero 行最高最宽，wide 次之，tall 最窄。
// 三档拉开才有节奏，四行等宽会像四根带子。
const LEVELS = [
  { level: 'hero', grow: 200, width: 420 },
  { level: 'tall', grow: 108, width: 236 },
  { level: 'wide', grow: 150, width: 336 },
  { level: 'tall', grow: 108, width: 236 },
];
// 每行漂流时长各不相同：同一速度会像一整块在平移，不像各自漂流
const DURS = [58, 42, 52, 46, 62, 40, 56, 44];

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

    let total = photos.length;
    try {
      const { result } = await app.mpServerless.db.collection('photo').count({ verified: true });
      if (typeof result === 'number') total = result;
    } catch (e) {
      // 计数失败不影响出图
    }

    // COS 公开读，signCosUrl 直接透传
    const pool = [];
    for (const p of photos) {
      const thumb = await signCosUrl(p.photo_compressed || p.photo_id);
      if (!thumb) continue;
      pool.push({
        thumb,
        full: (await signCosUrl(p.photo_id)) || thumb,
        name: (p.cat && p.cat.name) || '',
      });
    }

    this.jsData.pool = pool;
    this.buildRows(shuffle(pool));
    this.setData({ loading: false, total });
  },

  // 铺成 8 行：每行取 PER_ROW 张再复制一份，靠 translateX(-50%) 无缝循环
  buildRows: function (pool) {
    if (!pool || !pool.length) {
      this.setData({ rows: [] });
      return;
    }
    const rows = [];
    for (let r = 0; r < ROWS; r++) {
      const L = LEVELS[r % LEVELS.length];
      const base = [];
      for (let i = 0; i < PER_ROW; i++) {
        base.push(pool[(r * PER_ROW + i) % pool.length]);
      }
      // 副本：x + x，动画走 -50% 正好回到起点，看不出接缝
      const items = base
        .map((x, i) => ({ thumb: x.thumb, full: x.full, name: x.name, key: 'a' + r + '-' + i }))
        .concat(base.map((x, i) => ({ thumb: x.thumb, full: x.full, name: x.name, key: 'b' + r + '-' + i })));
      rows.push({
        id: r,
        level: L.level,
        grow: L.grow,
        width: L.width,
        duration: DURS[r % DURS.length],
        // 负延迟让每一行开局就处在不同位置，看起来不是同时起步
        delay: Math.round(((r * 7.3) % DURS[r % DURS.length]) * 10) / 10,
        items,
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
