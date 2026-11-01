import { showTab } from "../../utils/page";
import { signCosUrl } from "../../utils/common";

const app = getApp();
const { applyNav } = require('../../utils/nav');

// 8 行，按 4 行一个循环做三档行高：hero / tall / wide / tall
const ROWS = 8;
// 每行取多少张（复制一份后节点数翻倍）
// PER_ROW 直接决定常驻 <image> 节点数：8 行 × (PER_ROW×2) 张。
// 从 12 降到 8，墙的节点数从 192 降到 128（-33%），低端机掉帧明显缓解；
// 因为拼了一份副本做无缝循环，PER_ROW 只影响“循环前展示多少张不同照片”，
// 不影响铺满屏幕，观感几乎不变。
const PER_ROW = 8;
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

// 把猫档案压成浮层要展示的几行字，wxml 里就不用写一堆判断
function buildBrief(cat, cat_id) {
  if (!cat) {
    return { name: '', cat_id: cat_id || '', where: '', colour: '', gender: '', score: '0.0', tags: [], photos: 0 };
  }
  const tags = [];
  if (cat.adopt === 1) tags.push('已领养');
  if (cat.adopt === 2) tags.push('寻找领养中');
  if (cat.to_star) tags.push('去往喵星');
  else if (cat.missing) tags.push('已失踪');
  else if (cat.sterilized) tags.push('已绝育');
  else tags.push('待绝育');
  return {
    name: cat.name || '',
    cat_id: cat_id || cat._id || '',
    where: cat.area ? cat.campus + ' ' + cat.area : (cat.campus || ''),
    colour: cat.colour || '',
    gender: cat.gender || '',
    score: (cat.rating && cat.rating.avgScoreDisp) || '0.0',
    tags,
    photos: cat.photo_count_total || 0,
  };
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
    viewer: { show: false, url: '', cat_id: '', brief: null },
  },
  onShow: function () {
    applyNav(this);
    showTab(this);
    // 从别页返回时兜底：浮层可能把 tabBar 收掉了
    if (this.getTabBar && this.getTabBar() && this.getTabBar().data.showTabBar === false) {
      this.getTabBar().setData({ showTabBar: true });
    }
    if (this.data.viewer.show) {
      this.setData({ viewer: { show: false, url: '', cat_id: '', brief: null } });
    }
  },
  onHide: function () {
    if (this.data.viewer.show) this.closeViewer();
  },
  onUnload: function () {
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setData({ showTabBar: true });
    }
  },
  onShareAppMessage: function () {
    const first = (this.jsData.pool[0] || {});
    return {
      title: this.data.total ? '火大猫谱 · 猫图 ' + this.data.total + ' 张' : '火大猫谱 · 猫图',
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
        { verified: true, hidden: { $ne: true } },
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

    // 猫档案：照片本身不带 cat 对象，按 cat_id 现查一次建索引
    const catMap = {};
    try {
      const { result } = await app.mpServerless.db.collection('cat').find(
        { deleted: 0 },
        { limit: 500 }
      );
      (result || []).forEach(c => { catMap[c._id] = c; });
    } catch (e) {
      console.warn('[gallery] 猫档案加载失败', e);
    }

    let total = photos.length;
    try {
      const { result } = await app.mpServerless.db.collection('photo').count({ verified: true, hidden: { $ne: true } });
      if (typeof result === 'number') total = result;
    } catch (e) {
      // 计数失败不影响出图
    }

    // COS 公开读，signCosUrl 直接透传
    const pool = [];
    const briefMap = {};
    for (const p of photos) {
      const thumb = await signCosUrl(p.photo_compressed || p.photo_id);
      if (!thumb) continue;
      const cat = catMap[p.cat_id] || null;
      if (cat && !briefMap[p.cat_id]) {
        briefMap[p.cat_id] = buildBrief(cat, p.cat_id);
      }
      pool.push({
        thumb,
        full: (await signCosUrl(p.photo_id)) || thumb,
        cat_id: p.cat_id || '',
      });
    }

    this.jsData.pool = pool;
    this.jsData.briefMap = briefMap;
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
        .map((x, i) => ({ thumb: x.thumb, full: x.full, cat_id: x.cat_id, key: 'a' + r + '-' + i }))
        .concat(base.map((x, i) => ({ thumb: x.thumb, full: x.full, cat_id: x.cat_id, key: 'b' + r + '-' + i })));
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
    const { url, catid } = e.currentTarget.dataset;
    if (!url) return;
    const brief = (this.jsData.briefMap || {})[catid] || buildBrief(null, catid);
    // 看大图时把 tabBar 收掉，不跟内容抢底部
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setData({ showTabBar: false });
    }
    this.setData({
      viewer: {
        show: true,
        url,
        cat_id: catid || '',
        brief,
      },
    });
  },

  closeViewer: function () {
    if (this.getTabBar && this.getTabBar()) {
      this.getTabBar().setData({ showTabBar: true });
    }
    this.setData({ viewer: { show: false, url: '', cat_id: '', brief: null } });
  },

  toCatDetail: function () {
    const cat_id = this.data.viewer.cat_id;
    if (!cat_id) return;
    this.closeViewer();
    wx.navigateTo({ url: '/pages/genealogy/detailCat/detailCat?cat_id=' + cat_id });
  },

  noop: function () { },
});
