import {
  shuffle,
  regReplace,
  sleep,
  getCurrentPath
} from "../../utils/utils";
import {
  getAvatar,
  getVisitedDate
} from "../../utils/cat";
import {
  getCatCommentCount,
  getCatCommentCountMulti
} from "../../utils/comment";
import { getUserInfo } from "../../utils/user";
import cache from "../../utils/cache";
import config from "../../config";
import { loadFilter, getGlobalSettings, showTab } from "../../utils/page";
import { checkCanShowNews } from "../../utils/user";
import { signCosUrl } from "../../utils/common";
import passcode from "../../utils/passcode";
import { isReview, getConfig, readOverride, setOverride } from "../../utils/review";

// 连击「火大猫谱」标题 5 次 → 版本切换面板
const TAP_TO_UNLOCK = 5;
const TAP_WINDOW = 800;

const default_png = undefined;
const share_text = config.text.app_name + ' - ' + config.text.genealogy.share_tip;
const app = getApp();

/**
 * v4.0.48 首页猫卡「特点」摘要。
 * - characteristics 历史数据是数组，管理后台改完可能是字符串，两种都吃
 * - 数据里是长句描述（详情页展示全文），列表卡只显示 characteristics，超长由 CSS 省略
 */
function traitText(v) {
  if (Array.isArray(v)) {
    return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join('，');
  }
  return String(v == null ? '' : v).trim();
}

function catTraits(cat) {
  return {
    trait_text: traitText(cat && cat.characteristics),
  };
}

Page({
  data: {
    cats: [],
    filters: [],
    filters_legal: true,
    filters_input: '',
    // v4.0.50 搜索框焦点开关（只用于主动失焦，不改搜索行为）
    search_focus: false,
    filters_show_shadow: false,
    filters_empty: true,
    heights: { filters: 140, statusBarHeight: 20, navBarHeight: 44 },
    catsMax: 0,
    loading: false,
    loadnomore: false,
    adopt_desc: config.cat_status_adopt,
    adopt_count: 0,
    new_count: 0,
    total_count: 0,
    hero_mode: '',
    ad_show: {},
    ad: {},
    newsList: [],
    newsImage: "",
    text_cfg: config.text,
    dataReady: false,
    // 识猫入口显隐（MeowID 配好项目 ID + API Key 才显示）
    showRecognize: false,
    // 新增：下拉刷新状态
    refreshing: false,
    // 审核态：只留首页（藏数据卡/识猫/看板入口，tabBar 由组件自己隐）
    reviewMode: false,
    // 版本切换面板（连击标题 5 次打开）：版本号 + 管理口令
    debug_show: false,
    debug_input: '',
    debug_pass: ''
  },

  jsData: {
    catsStep: 12,
    loadingLock: 0,
    pageLoadingLock: false,
    // 新增：待处理的scene参数
    pendingScene: null,
    // 连击计数
    tapCount: 0,
    tapAt: 0
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    if (!this.jsData) {
      this.jsData = {
        catsStep: 12,
        loadingLock: 0,
        pageLoadingLock: false,
        pendingScene: null,
        tapCount: 0,
        tapAt: 0
      };
    }
    if (this.jsData.tapCount === undefined) this.jsData.tapCount = 0;
    if (this.jsData.tapAt === undefined) this.jsData.tapAt = 0;
    
    if (options.scene) {
      const scene = decodeURIComponent(options.scene);
      if (scene.startsWith('toC=')) {
        this.jsData.pendingScene = scene;
      }
    }

    var fcampus = options.fcampus;
    if (!fcampus) {
      fcampus = this.getFCampusCache();
    }
    
    if (options.toPath) {
      wx.navigateTo({
        url: decodeURIComponent(options.toPath),
      });
      return;
    }

    let settings = null;
    for (let retry = 0; retry < 3; retry++) {
      try {
        settings = await getGlobalSettings('genealogy', {});
        break;
      } catch {
        if (retry < 2) await sleep(500);
      }
    }

    if (!settings) {
      wx.showModal({
        title: '网络小故障',
        content: '请重新进入小程序',
        showCancel: false,
        success() {
          const path = getCurrentPath(getCurrentPages());
          wx.restartMiniProgram({ path });
        }
      })
      return;
    }
    
    this.jsData.catsStep = settings['catsStep'] || 12;

    // 审核态判定（远端 app-config + 本机覆盖）。失败一律按完整态，绝不影响使用
    let reviewMode = false;
    try {
      reviewMode = await isReview();
    } catch (e) {
      reviewMode = false;
    }
    this.setData({ reviewMode: reviewMode });

    this.setData({
      main_lower_threshold: settings['main_lower_threshold'] || 50,
      adStep: settings['adStep'] || 0
    });

    this.newsModal = this.selectComponent("#newsModal");

    await Promise.all([
      this.loadRecognize(),
      this.loadFilters(fcampus),
      this.loadNews(),
      this.loadTips(),
      getGlobalSettings('ads')
    ]).then(results => {
      const ads = results[3] || {};
      this.setData({
        ad: { banner: ads.genealogy_banner }
      });
    });

    // 绑定事件监听，使用稳定的引用
    this.photoProcessedHandler = this.handlePhotoProcessed.bind(this);
    app.globalData.eventBus.$on('photoProcessed', this.photoProcessedHandler);
    this.setData({ dataReady: true });
    
    if (this.jsData.pendingScene) {
      this.handlePendingScene();
    }
  },

  loadTips: async function() {
    try {
      const tipsList = await app.mpServerless.db.collection('tips').find();
      this.setData({
        tipsList: this.shuffleArray(tipsList.result || [])
      });
    } catch (e) {
      console.error('loadTips error:', e);
    }
  },

  shuffleArray: function(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },
  
  // 新增：处理待处理的scene参数
  async handlePendingScene() {
    const scene = this.jsData.pendingScene;
    if (scene.startsWith('toC=')) {
      const cat_No = scene.substr(4);
      // 使用正确的字段名 'no' 而不是 '_no'
      const { result: cat_res } = await app.mpServerless.db.collection('cat').find({ no: cat_No }, { projection: { _id: 1 } });
      
      if (!cat_res.length) {
        wx.showToast({
          title: '未找到对应猫咪',
          icon: 'none'
        });
        return;
      }
      const _id = cat_res[0]._id;
      this.clickCatCard(_id, true);
    }
    this.jsData.pendingScene = null;
  },

  onUnload: function () {
    // 使用绑定的引用进行清理，确保正确解除监听
    if (this.photoProcessedHandler) {
      app.globalData.eventBus.$off('photoProcessed', this.photoProcessedHandler);
      this.photoProcessedHandler = null;
    }
  },

  handlePhotoProcessed: function (data) {
    if (data.catId) {
      this.refreshCatData(data.catId);
    } else {
      this.reloadCats();
    }
  },

  refreshCatData: async function (catId) {
    const index = this.data.cats.findIndex(cat => cat._id === catId);
    if (index === -1) return;
    
    const { result: [updatedCat] } = await app.mpServerless.db.collection('cat').find({ 
      _id: catId 
    });
    
    if (updatedCat) {
      const traits = catTraits(updatedCat);
      updatedCat.trait_text = traits.trait_text;
      this.setData({ [`cats[${index}]`]: updatedCat });
      this.loadCatPhoto(updatedCat, index);
    }
  },

  loadCatPhoto: async function (cat, index) {
    const photo = await getAvatar(cat._id, cat.photo_count_best);
    if (!photo) return;
    
    if (!photo.userInfo) {
      photo.userInfo = (await getUserInfo(photo._openid)).userInfo;
    }
    
    const commentCount = await getCatCommentCount(cat._id);
    
    this.setData({
      [`cats[${index}].photo`]: photo,
      [`cats[${index}].comment_count`]: commentCount
    });
  },

  onShow: function () {
    showTab(this);
    // v4.0.50 修「返回首页自动弹键盘」：tab 页只 onHide 不销毁，
    // 上次留在搜索框的原生焦点会被微信带回来，这里主动收一次。
    this.blurSearch();
  },

  onHide: function () {
    this.blurSearch();
  },

  // 收起首页搜索框的键盘与焦点（焦点属性是确定性失焦，定时器只做兜底）
  blurSearch: function () {
    if (this.data.search_focus) {
      this.setData({ search_focus: false });
    }
    const hide = () => {
      if (typeof wx.hideKeyboard === 'function') {
        wx.hideKeyboard({ fail() { } });
      }
    };
    hide();
    // 个别机型 onShow 时焦点还没恢复，稍后再收一次
    setTimeout(hide, 80);
  },

  loadRecognize: async function () {
    // 审核态不给识猫入口（会消耗额度，也不希望被审核员当成功能点去试）
    if (this.data.reviewMode) {
      this.setData({ showRecognize: false });
      return;
    }
    const env = __wxConfig.envVersion === 'release' || __wxConfig.envVersion === 'develop' ? 'recognize' : 'recognize_test';
    const settings = await getGlobalSettings(env) || {};
    // MeowID：项目 ID 和 API Key 都填了才显示识猫入口
    this.setData({
      showRecognize: !!(settings.projectId && settings.apiKey)
    });
  },

  // 三行胶囊过滤器：位置 / 花色 / 状态
  // 每行 = { key, name, all_active, options: [{name, cond, active, count}] }
  loadFilters: async function (fcampus) {
    const res = await loadFilter();
    if (!res) {
      wx.showModal({
        title: '出错了...',
        content: '请到关于页，清理缓存后重启试试~',
        showCancel: false,
      });
      return false;
    }

    const filters = [
      {
        key: 'campus',
        name: '位置',
        all_active: true,
        options: (res.campuses || []).map(name => ({ name, cond: { campus: name } }))
      },
      {
        key: 'colour',
        name: '花色',
        all_active: true,
        options: (res.colour || []).map(name => ({ name, cond: { colour: name } }))
      },
      {
        key: 'state',
        name: '状态',
        all_active: true,
        options: [
          { name: '已领养', cond: { adopt: 1 } },
          { name: '寻找领养中', cond: { adopt: 2 } },
          { name: '待绝育', cond: { sterilized: false } },
          { name: '已绝育', cond: { sterilized: true } },
          { name: '未失踪', cond: { missing: false } },
          { name: '已失踪', cond: { missing: true } },
          { name: '去往喵星', cond: { to_star: true } }
        ]
      }
    ];

    // 分享链接里带回的位置选择（"1" 表示该位置被选中）
    const loc = filters[0].options;
    if (fcampus && fcampus.length === loc.length) {
      loc.forEach((opt, i) => { opt.active = fcampus[i] === '1'; });
      filters[0].all_active = !loc.some(o => o.active);
    }

    this.setData({ filters });

    // 确保加载猫咪数据（数字统计在 reloadCats 之后进行，避免读到空 filters）
    await this.reloadCats();
    await this.updateCounts();
  },

  onReady: function () {
    this.getHeights();
  },

  onPullDownRefresh: async function () {
    if (this.data.refreshing) return;
    
    await this.setData({ refreshing: true });
    
    try {
      await this.reloadCats();
    } finally {
      await this.setData({ refreshing: false });
      wx.stopPullDownRefresh();
    }
  },

  onReachBottom: async function () {
    if (this.data.refreshing) return;
    await this.loadMoreCats();
  },

  onShareAppMessage: function () {
    const pagesStack = getCurrentPages();
    const path = getCurrentPath(pagesStack);
    const fcampus = this.getFCampusStr();
    const query = `${path}fcampus=${fcampus}`;
    return {
      title: share_text,
      path: query
    };
  },

  getFCampusStr: function () {
    return this.data.filters[0].options
      .map(opt => opt.active ? "1" : "0")
      .join("");
  },

  onShareTimeline: function () {
    return { title: share_text };
  },

  checkNeedLoad() {
    if (this.data.cats.length >= this.data.catsMax) {
      this.setData({ loadnomore: true });
      this.jsData.pageLoadingLock = false;
      return false;
    }
    return true;
  },

  async reloadCats() {
    this.jsData.loadingLock++;
    const nowLoadingLock = this.jsData.loadingLock;
    
    const query = await this.fGet();
    const { result: cat_count } = await app.mpServerless.db.collection('cat').count(query);
    
    if (this.jsData.loadingLock !== nowLoadingLock) return false;
    
    this.setData({
      cats: [],
      catsMax: cat_count,
      loadnomore: false,
      filters_empty: Object.keys(query).length === 0,
    });
    
    await Promise.all([
      this.loadMoreCats(),
      this.countTotalCats(),
      this.countWaitingAdopt(),
      this.countNewCats(),
      this.setFCampusCache()
    ]);
    
    this.unlockBtn();
  },

  async loadMoreCats() {
    const nowLoadingLock = this.jsData.loadingLock;
    if (!this.checkNeedLoad() || this.data.loading) return false;
    
    await this.setData({ loading: true });
    
    const cats = this.data.cats;
    const step = this.jsData.catsStep;
    const query = await this.fGet();
    
    let { result: new_cats } = await app.mpServerless.db.collection('cat').find(query, { 
      sort: { mphoto: -1, like_count: -1 }, 
      skip: cats.length, 
      limit: step 
    });
    
    new_cats = shuffle(new_cats);
    
    if (this.jsData.loadingLock !== nowLoadingLock) return false;
    
    const today = new Date();
    new_cats.forEach(d => {
      d.photo = default_png;
      d.characteristics_string = [(d.colour || '') + ''].concat(d.characteristics || []).join('，');
      // v4.0.48 列表卡展示 characteristics 摘要
      const traits = catTraits(d);
      d.trait_text = traits.trait_text;
      
      if (d.mphoto) {
        const modified_date = new Date(d.mphoto);
        const delta_days = (today - modified_date) / (1000 * 3600 * 24);
        d.mphoto_new = delta_days < 7;
        
        const visit_date = getVisitedDate(d._id);
        if (visit_date >= modified_date) {
          d.mphoto_new = false;
        }
      } else {
        d.mphoto_new = false;
      }
    });
    
    const updatedCats = [...cats, ...new_cats];
    await this.setData({
      cats: updatedCats,
      loading: false,
      loadnomore: updatedCats.length === this.data.catsMax
    });
    
    await this.loadCatsPhoto();
  },

  async loadCatsPhoto() {
    const nowLoadingLock = this.jsData.loadingLock;
    const cats = this.data.cats;
    
    const cat2photos = {};
    const cat2commentCount = {};
    
    // 并发限流：首页 21 只猫若一次性 Promise.all 拉头像，瞬时并发请求
    // 会打爆请求数（每只猫约 2 次 db 查询）。这里用固定大小的 worker 池
    // 把瞬时并发限制在 ≤5，结果顺序与入参一致，展示结果不变。
    const CONCURRENCY = 5;
    let cursor = 0;
    const worker = async () => {
      while (cursor < cats.length) {
        const i = cursor++;
        const cat = cats[i];
        if (cat.photo === default_png) {
          const photo = await getAvatar(cat._id, cat.photo_count_best);
          if (photo) {
            if (!photo.userInfo) {
              try {
                const userInfoRes = await getUserInfo(photo._openid);
                photo.userInfo = userInfoRes.userInfo;
              } catch (e) {
                console.error("获取用户信息失败:", e);
              }
            }
            cat2photos[cat._id] = photo;
            cat2commentCount[cat._id] = await getCatCommentCount(cat._id);
          }
        }
      }
    };
    const pool = [];
    for (let k = 0; k < Math.min(CONCURRENCY, cats.length); k++) {
      pool.push(worker());
    }
    await Promise.all(pool);
    

    if (this.jsData.loadingLock !== nowLoadingLock) return false;
    
    const updatedCats = cats.map(c => {
      if (cat2photos[c._id]) {
        return {
          _id: c._id,
          ...c,
          photo: cat2photos[c._id],
          comment_count: cat2commentCount[c._id]
        };
      }
      return {
        _id: c._id,
        ...c
      };
    });
    
    this.setData({ cats: updatedCats });
  },

  bindImageLoaded(e) {
    const idx = e.currentTarget.dataset.index;
    this.setData({ [`cats[${idx}].imageLoaded`]: true });
  },

  clickRecognize(e) {
    wx.navigateTo({ url: '/pages/packageA/pages/recognize/recognize' });
  },

  clickCatCard(e, isCatId) {
    const cat_id = isCatId ? e : e.currentTarget.dataset.cat_id;
    
    if (!cat_id) {
      console.error("cat_id is undefined");
      return;
    }
    
    const index = this.data.cats.findIndex(cat => cat._id == cat_id);
    if (index !== -1) {
      this.setData({ [`cats[${index}].mphoto_new`]: false });
    }
    
    wx.navigateTo({
      url: `/pages/genealogy/detailCat/detailCat?cat_id=${cat_id}`,
    });
  },

  getHeights() {
    wx.getSystemInfo({
      success: res => {
        const rpx2px = res.windowWidth / 750;
        const app = getApp();
        const g = (app && app.globalData) || {};
        const statusBarHeight = g.statusBarHeight || res.statusBarHeight || 20;
        // 自定义导航：状态栏 + 标题行 + 搜索行 + 上下留白
        // 224rpx 对应 v5.3 实际内容高度：nav-row(标题 19+52rpx 行高 + 26rpx 上下留白 ≈ 119rpx) + search-row(80rpx 输入框 + 20rpx 下留白 = 100rpx)。
        // 历史值 170rpx 装不下（差约 50rpx），搜索行会溢出 #search 盒子、压住下面的数据卡和筛选抽屉。
        const filters = statusBarHeight + 224 * rpx2px;
        this.setData({
          "heights.filters": filters,
          "heights.statusBarHeight": statusBarHeight,
          "heights.navBarHeight": g.navBarHeight || 44,
          "heights.screenHeight": res.screenHeight,
          "heights.windowHeight": res.windowHeight,
        });
      }
    });
  },

  // 筛选抽屉开关
  fToggle: function () {
    this.setData({ filters_show: !this.data.filters_show });
  },

  fHide: function () {
    this.setData({ filters_show: false });
  },

  voidMove: function () { },

  // 首页 → 数据看板（审核态不给入口：那是管理向页面）
  toDashboard: function () {
    if (this.data.reviewMode) {
      wx.showToast({ title: '当前不可用', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: "/pages/manage/dashboard/dashboard",
    });
  },

  // ===== 暗门：连击标题 5 次 → 版本切换面板 =====
  // 面板本身不弹口令；要从面板进管理后台才需要口令。
  onTitleTap: function () {
    const now = Date.now();
    if (now - this.jsData.tapAt > TAP_WINDOW) {
      this.jsData.tapCount = 0;
    }
    this.jsData.tapAt = now;
    this.jsData.tapCount = (this.jsData.tapCount || 0) + 1;
    if (this.jsData.tapCount < TAP_TO_UNLOCK) {
      return;
    }
    this.jsData.tapCount = 0;
    this.openDebugPanel();
  },

  // 读 data/gate.json 的 code（故意不缓存，改完下次连击即生效）
  async loadGateCode() {
    try {
      const { result } = await app.mpServerless.db.collection('gate').findOne({ _id: 'gate' });
      return (result && result.code) || '';
    } catch (e) {
      return '';
    }
  },

  // 面板：版本号 + 管理口令（照搬 SpaceLaunch：版本号在外，口令用于进管理后台）
  openDebugPanel() {
    const ov = readOverride();
    this.setData({
      debug_show: true,
      debug_input: ov && ov.version ? ov.version : '',
      debug_pass: '',
    });
  },

  closeDebugPanel() {
    this.setData({ debug_show: false });
  },

  onDebugInput(e) {
    this.setData({ debug_input: e.detail.value });
  },

  onDebugPass(e) {
    this.setData({ debug_pass: e.detail.value });
  },

  // 第一行「模拟」：只写本机模拟版本号，不需要口令
  applySimVersion() {
    const v = String(this.data.debug_input || '').trim();
    if (!v) {
      wx.showToast({ title: '请填版本号，如 4.0.72', icon: 'none' });
      return;
    }
    setOverride(v);
    this.reloadForDebug();
  },

  // 第二行「确定」：校验管理口令，通过后解锁并写入模拟版本号（空则清除覆盖）
  async confirmDebug() {
    const code = await this.loadGateCode();
    if (!code) {
      wx.showToast({ title: '管理入口未启用', icon: 'none' });
      return;
    }
    const pass = String(this.data.debug_pass || '').trim();
    if (!pass) {
      wx.showToast({ title: '请输入管理口令', icon: 'none' });
      return;
    }
    if (pass !== code) {
      wx.showToast({ title: '口令不对', icon: 'none' });
      return;
    }
    passcode.setUnlocked(true);
    passcode.setToken(pass);
    const v = String(this.data.debug_input || '').trim();
    setOverride(v || null);
    wx.showToast({ title: '已解锁', icon: 'none' });
    this.reloadForDebug();
  },

  // 清除本机覆盖，回到按真实版本号 / 运行环境判定
  clearOverride() {
    setOverride(null);
    this.reloadForDebug();
  },

  // 重新拉一次远端配置并重载页面（改完 COS 后立刻看到效果，不用等 5 分钟 TTL）
  reloadForDebug() {
    wx.showLoading({ title: '重新拉取配置', mask: true });
    getConfig({ force: true })
      .then(() => {
        wx.hideLoading();
        wx.reLaunch({
          url: '/pages/genealogy/genealogy',
          fail() {
            wx.showToast({ title: '刷新失败，请重试', icon: 'none' });
          },
        });
      })
      .catch(() => {
        wx.hideLoading();
        this.closeDebugPanel();
      });
  },

  fCheckLegal: function (filters) {
    for (const row of filters) {
      if (row.all_active) continue;
      if (!row.options.some(o => o.active)) return false;
    }
    return true;
  },

  // 单行的查询条件；onlyIndex 指定时只看该选项（用于算每颗胶囊的数字）
  _rowConditions: function (row, onlyIndex) {
    // 算单颗胶囊的数字时，即便这一行正处在「全部」，也必须只按该选项自身条件过滤，
    // 否则每颗胶囊都会数出「全部猫」的总数（v4.0.82 修的 bug：全是 21）
    if (onlyIndex !== undefined) {
      const only = row.options[onlyIndex];
      if (!only) return [];
      if (row.key === 'state') return [only.cond];
      return [{ [row.key]: { $in: [only.name] } }];
    }
    if (row.all_active) return [];
    const picked = row.options.filter((o, i) => o.active);
    if (!picked.length) return [];
    // 状态行每颗胶囊自带完整条件，多选时语义互斥（已绝育 vs 待绝育），取并集
    if (row.key === 'state') {
      const conds = picked.map(o => o.cond);
      return conds.length === 1 ? conds : [{ $or: conds }];
    }
    return [{ [row.key]: { $in: picked.map(o => o.name) } }];
  },

  _conditionsOf: function (filters, skipRowIndex, onlyIndex) {
    const conditions = [];
    filters.forEach((row, i) => {
      if (i === skipRowIndex) return;
      conditions.push(...this._rowConditions(row, i === skipRowIndex ? onlyIndex : undefined));
    });
    if (skipRowIndex !== undefined) {
      conditions.push(...this._rowConditions(filters[skipRowIndex], onlyIndex));
    }
    if (!conditions.length) return {};
    return conditions.length === 1 ? conditions[0] : { $and: conditions };
  },

  async fGet() {
    const filters = this.data.filters;
    const conditions = [];

    filters.forEach(row => {
      conditions.push(...this._rowConditions(row));
    });

    // 处理搜索输入
    const filters_input = regReplace(this.data.filters_input);
    if (filters_input) {
      const searchTerms = filters_input.trim().split(' ');
      const regexPattern = searchTerms.map(term => `.*${term}.*`).join('|');

      conditions.push({
        $or: [
          { name: { $regex: regexPattern } },
          { nickname: { $regex: regexPattern } }
        ]
      });
    }

    // 首页「本月新增」快捷筛选
    if (this.data.hero_mode === 'new') {
      conditions.push({ create_time: { $gte: this.getMonthStartISO() } });
    }

    this.setData({ filters_active: conditions.length > 0 });
    if (!conditions.length) return {};
    return conditions.length === 1 ? conditions[0] : { $and: conditions };
  },

  // 每颗胶囊后面的数量：其余行条件 + 该选项自身条件
  async updateCounts() {
    const filters = this.data.filters;
    const col = app.mpServerless.db.collection('cat');

    const rows = await Promise.all(filters.map(async (row, rowIdx) => {
      const options = await Promise.all(row.options.map(async (opt, optIdx) => {
        const { result } = await col.count(this._conditionsOf(filters, rowIdx, optIdx));
        return Object.assign({}, opt, { count: result });
      }));
      return Object.assign({}, row, { options });
    }));

    this.setData({ filters: rows });
  },

  // 应用筛选：算数字 + 重载列表
  async applyFilters(filters, hero_mode) {
    this.setData({
      filters,
      hero_mode: hero_mode !== undefined ? hero_mode : this.data.hero_mode,
      filters_legal: this.fCheckLegal(filters)
    });
    await this.updateCounts();
    await this.reloadCats();
  },

  // 点某行的「全部」
  async fRowAll(e) {
    if (this.jsData.pageLoadingLock) return false;
    const rowIdx = Number(e.currentTarget.dataset.row);
    const filters = this.data.filters.map((row, i) => (
      i === rowIdx
        ? Object.assign({}, row, { all_active: true, options: row.options.map(o => Object.assign({}, o, { active: false })) })
        : row
    ));
    this.lockBtn();
    await this.applyFilters(filters, this._nextHeroMode(filters));
    this.unlockBtn();
  },

  // 点某个选项（可多选）
  async fRowOpt(e) {
    if (this.jsData.pageLoadingLock) return false;
    const rowIdx = Number(e.currentTarget.dataset.row);
    const optIdx = Number(e.currentTarget.dataset.opt);
    const filters = this.data.filters.map((row, i) => {
      if (i !== rowIdx) return row;
      const options = row.options.map((o, j) => (j === optIdx ? Object.assign({}, o, { active: !o.active }) : o));
      return Object.assign({}, row, { all_active: !options.some(o => o.active), options });
    });
    this.lockBtn();
    await this.applyFilters(filters, this._nextHeroMode(filters));
    this.unlockBtn();
  },

  // 行内重置
  async fRowReset() {
    if (this.jsData.pageLoadingLock) return false;
    const filters = this.data.filters.map(row => Object.assign({}, row, {
      all_active: true,
      options: row.options.map(o => Object.assign({}, o, { active: false }))
    }));
    this.lockBtn();
    await this.applyFilters(filters, '');
    this.unlockBtn();
  },

  // 手动筛选后三格数字不再高亮：全部行都回到「全部」时才恢复第一格
  _nextHeroMode(filters) {
    return (filters || this.data.filters).every(r => r.all_active) ? '' : 'custom';
  },

  fSearchInput: function(e) {
    this.setData({ filters_input: e.detail.value });
  },
  
  fSearch: function() {
    this.reloadCats();
  },
  
  fSearchClear: async function() {
    await this.setData({ filters_input: "" });
    this.fSearch();
  },
  
  fScroll: function(e) {
    const scrollTop = e.detail.scrollTop;
    const showShadow = scrollTop >= 50;
    if (this.data.filters_show_shadow !== showShadow) {
      this.setData({ filters_show_shadow: showShadow });
    }
  },

  // 广告相关
  changeState(ad_id, show) {
    const ad_show = { ...this.data.ad_show, [ad_id]: show };
    this.setData({ ad_show });
  },

  adLoad(e) {
    this.changeState(e.currentTarget.dataset.ad_id, true);
  },
  
  adError(e) {
    this.changeState(e.currentTarget.dataset.ad_id, false);
  },
  
  adClose(e) {
    this.changeState(e.currentTarget.dataset.ad_id, false);
  },

  async countWaitingAdopt() {
    const target = config.cat_status_adopt_target;
    const value = config.cat_status_adopt.indexOf(target);
    const { result: adopt_count } = await app.mpServerless.db.collection('cat').count({ adopt: value });
    this.setData({ adopt_count });
  },

  // 本月 1 日 00:00（本地时区）对应的 UTC ISO 字符串
  getMonthStartISO() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  },

  async countTotalCats() {
    const { result: total_count } = await app.mpServerless.db.collection('cat').count({});
    this.setData({ total_count });
  },

  async countNewCats() {
    const { result: new_count } = await app.mpServerless.db.collection('cat').count({
      create_time: { $gte: this.getMonthStartISO() }
    });
    this.setData({ new_count });
  },

  // 点首页三格数字：在册=全部 / 待领养=adopt 目标状态 / 本月新增=create_time 当月
  async heroFilter(e) {
    if (this.jsData.pageLoadingLock) return false;
    const type = e.currentTarget.dataset.type;
    this.lockBtn();

    // 先复位所有筛选条件
    const filters = this.data.filters.map(row => Object.assign({}, row, {
      all_active: true,
      options: row.options.map(o => Object.assign({}, o, { active: false }))
    }));

    let hero_mode = '';
    if (type === 'adopt') {
      hero_mode = 'adopt';
      const stateRow = filters.find(f => f.key === 'state');
      if (stateRow) {
        const idx = stateRow.options.findIndex(o => o.name === config.cat_status_adopt_target);
        if (idx !== -1) {
          stateRow.options[idx].active = true;
          stateRow.all_active = false;
        }
      }
    } else if (type === 'new') {
      hero_mode = 'new';
    }

    await this.applyFilters(filters, hero_mode);
    this.unlockBtn();
  },

  async loadNews() {
    if (!await checkCanShowNews()) return;
    
    const { result: newsList } = await app.mpServerless.db.collection('news').find({ 
      setNewsModal: true 
    }, { sort: { date: -1 } });
    
    this.setData({ newsList });
    if (!newsList.length) return;
    
    let newsImage = "";
    if (newsList[0].coverPath) {
      newsImage = await signCosUrl(newsList[0].coverPath);
    } else if (newsList[0].photosPath?.length) {
      newsImage = await signCosUrl(newsList[0].photosPath[0]);
    }
    
    this.setData({ newsImage });
    
    if (!this.checkNewsVisited()) {
      this.newsModal.showNewsModal();
    }
  },

  _cancelEvent() {
    this.newsModal.hideNewsModal();
    this.setNewsVisited();
  },
  
  _confirmEvent() {
    this.newsModal.hideNewsModal();
    this.setNewsVisited();
    wx.navigateTo({
      url: `/pages/news/detailNews/detailNews?news_id=${this.data.newsList[0]._id}`,
    });
  },
  
  checkNewsVisited() {
    const news_id = this.data.newsList[0]?._id;
    return news_id ? cache.getCacheItem(`visit-news-${news_id}`) : false;
  },
  
  setNewsVisited() {
    const news_id = this.data.newsList[0]?._id;
    if (news_id) {
      cache.setCacheItem(`visit-news-${news_id}`, true, cache.cacheTime.genealogyNews);
    }
  },

  lockBtn() {
    this.jsData.pageLoadingLock = true;
  },
  
  unlockBtn() {
    this.jsData.pageLoadingLock = false;
  },

  setFCampusCache: function() {
    const fc = this.getFCampusStr();
    cache.setCacheItem("genealogy-fcampus", fc, cache.cacheTime.genealogyFCampus);
  },

  getFCampusCache: function() {
    return cache.getCacheItem("genealogy-fcampus");
  }
})