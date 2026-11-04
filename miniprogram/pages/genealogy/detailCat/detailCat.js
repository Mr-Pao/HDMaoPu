import config from "../../../config";
import {
  shareTo,
  getCurrentPath,
  formatDate,
  deepcopy
} from "../../../utils/utils";
import {
  checkCanUpload,
  checkCanComment,
  getUser
} from "../../../utils/user";
import {
  getCatCommentCount
} from "../../../utils/comment";
import {
  setVisitedDate,
  getAvatar,
  getCatItem
} from "../../../utils/cat";
import {
  getGlobalSettings
} from "../../../utils/page";
import { convertRatingList, genDefaultRating } from "../../../utils/rating";
import { signCosUrl, signPhotoUrls } from "../../../utils/common";
import api from "../../../utils/cloudApi";
import { putInbox } from "../../../utils/writeback";
import { getPendingCount, pendingText } from "../../../utils/syncTip";
import { isReview, isReviewSync } from "../../../utils/review";

const app = getApp();

// 获取照片的排序功能
const photoOrder = [{
  key: 'shooting_date',
  order: 'desc',
  name: '最近拍摄'
},
{
  key: 'shooting_date',
  order: 'asc',
  name: '最早拍摄'
},
{
  key: 'mdate',
  order: 'desc',
  name: '最近收录'
},
{
  key: 'mdate',
  order: 'asc',
  name: '最早收录'
},
]

const { applyNav } = require('../../../utils/nav');

Page({

  /**
   * 页面的初始数据
   */
  data: {
    cat: {},
    album: [], // 所有照片
    bottomText: config.text.detail_cat.bottom_text_loading,
    showHoverHeader: false, // 显示浮动的相册标题
    hideBgBlock: false, // 隐藏背景黄块
    canvas: {}, // 画布的宽高
    canUpload: false, // 是否可以上传照片
    // 审核态：详情页所有 UGC 入口（上传/便利贴/评分/纠错/申请领养）一律隐藏
    reviewMode: false,
    showGallery: false,
    galleryPhotos: [],
    currentImg: 0, // 预览组件当前预览的图片
    photoOrderSelectorRange: photoOrder,
    photoOrderSelectorKey: "name",
    photoOrderSelected: 0,

    // 领养状态
    adopt_desc: config.cat_status_adopt,
    text_cfg: config.text,

    // 是否展开评分详情
    showDetailRating: false,

    // 疫苗记录相关
    showVaccineHistory: false,
    vaccineHistory: [],

    // 谱系树相关
    showGenealogyTree: false,
    parentCats: [],
    childCats: [],

    // 本机是否已给这只猫点过赞（热度下线后接替原「关注」位）
    likedCat: false,

    // 本机待同步记录（提交后要等 Actions 聚合，期间在页面顶部提示）
    pendingCount: 0,
    pendingText: "",
    syncTipHidden: false,
  },

  jsData: {
    // 页面设置，从global读取
    page_settings: {},
    photoMax: 0,
    albumMax: 0,
    loadingAlbum: false,
    whichGallery: "", // 预览时记录展示的gallery是精选还是相册
    infoHeight: 0, // 单位是px
    heights: {}, // 系统的各种heights
    cat_id: "",
    album_raw: []
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    this.jsData.cat_id = options.cat_id;

    // 记录访问时间，消除"有新相片"
    // TODO：用cache
    setVisitedDate(this.jsData.cat_id);
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady: async function () {
    // 审核态：详情页所有 UGC 入口（上传喵照/便利贴/评分/纠错/申请领养）都不给
    // 先读同步结论，避免入口闪一下；再等远端判定校正
    if (isReviewSync()) {
      this.setData({ reviewMode: true });
    }

    // 获取一下屏幕高度
    wx.getSystemInfo({
      success: res => {
        this.jsData.heights = {
          "screenHeight": res.screenHeight,
          "windowHeight": res.windowHeight,
          "rpx2px": res.windowWidth / 750,
          "pixelRatio": res.pixelRatio
        }
      }
    });

    // 开始加载页面
    this.jsData.page_settings = await getGlobalSettings('detailCat');
    // 加载猫猫，是否开启上传、便利贴留言功能
    var [_, canUpload, canComment] = await Promise.all([
      this.loadCat(),
      checkCanUpload(),
      checkCanComment(),
    ]);
    // 远端开关校正（失败保持现状，绝不影响正常使用）
    let reviewMode = this.data.reviewMode;
    try {
      reviewMode = await isReview();
    } catch (e) {
      reviewMode = this.data.reviewMode;
    }

    this.setData({
      reviewMode: reviewMode,
      // 审核态一律不给上传入口；正常态按后端配置 + 全局开关
      canUpload: !reviewMode && !!canUpload && config.photo_upload_enabled === true,
      canComment: !reviewMode && canComment
    });
  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {
    applyNav(this);

    // 提交的内容要等后台聚合，期间留在本机记录里 → 页面顶部给一条可关闭的提示
    try {
      const n = getPendingCount(this.jsData.cat_id);
      this.setData({
        pendingCount: n,
        pendingText: pendingText(n)
      });
    } catch (e) {
      console.warn("[detailCat] 待同步记录读取失败", e);
    }
    if (this.data.showDetailRating) {
      this.drawRatingRadar();
    }
  },

  // 只隐藏提示条，不清本机记录（下次提交还会再算）
  dismissSyncTip() {
    this.setData({ syncTipHidden: true });
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide: function () {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload: function () { },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh: function () {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom: function () { },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    const pagesStack = getCurrentPages();
    const path = getCurrentPath(pagesStack);
    const share_text = `${this.data.cat.name} - ${config.text.app_name}`;
    return shareTo(share_text, path);
  },
  onShareTimeline: function () {
    return this.onShareAppMessage();
  },

  swiperLast(e) {
    const current = e.detail.current;
    if (current === ((this.data.cat.photo || []).length - 1)) {
      this.loadMorePhotos(this.data.cat._id);
    }
  },

  // 自绘导航栏返回
  goBack() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/genealogy/genealogy' });
    }
  },

  async loadCat() {
    const { result: cat } = await app.mpServerless.db.collection('cat').findOne({
      _id: this.jsData.cat_id
    });
    if (!cat) {
      console.warn("[loadCat] 猫猫不存在", this.jsData.cat_id);
      wx.showToast({ title: "猫猫不存在或已离开", icon: "none" });
      setTimeout(() => {
        wx.navigateBack();
      }, 1500);
      return;
    }
    cat.photo = [];
    // v4.0.48 只有 characteristics 一个字段承载「性格及特点」，历史数组数据也兼容
    if (Array.isArray(cat.characteristics)) {
      cat.characteristics_string = cat.characteristics.filter(Boolean).join('，');
    } else {
      cat.characteristics_string = cat.characteristics || '';
    }
    cat.avatar = await getAvatar(cat._id, cat.photo_count_best);

    if (cat.rating) {
      // 「各项评分」读的是 dimAvg（每维平均分）。
      // 不能用 scores：scores.rN 是「综合分 = N 的得票数」，当成分数渲染会显示成
      // 「猫德 3.0」实际却有 3 人打了那个分，是两回事。
      // 没有 dimAvg 时给空数组，模板由 wx:for 自然不渲染，而不是显示一串错数字。
      cat.rating.catRatings = convertRatingList(cat.rating.dimAvg || {});
    }
    this.setData({
      cat: cat
    });

    await Promise.all([
      this.reloadPhotos(),
      this.loadCommentCount(),
      this.loadLikeState(),
      this.loadRelations(),
      this.getLatestVaccine(cat._id),
    ]);

    var query = wx.createSelectorQuery();
    query.select('#info-box').boundingClientRect();
    query.exec((res) => {
      if (!res[0]) {
        return;
      }
      this.jsData.infoHeight = res[0].height;
    })
  },

  // 更新关系列表
  async loadRelations() {
    var cat = this.data.cat;
    var relations = this.data.cat.relations;
    if (!cat._id || !relations) {
      return false;
    }

    for (var relation of relations) {
      relation.cat = await getCatItem(relation.cat_id)
      relation.cat.avatar = await getAvatar(relation.cat_id, relation.cat.photo_count_best);
    }


    const parentCats = [];
    const childCats = [];
    for (var relation of relations) {
      const label = relation.alias || relation.type || '';
      if (/父|母|爸|妈/.test(label)) {
        parentCats.push(Object.assign({}, relation.cat, { relation: label }));
      } else if (/子|女|崽/.test(label)) {
        childCats.push(Object.assign({}, relation.cat, { relation: label }));
      }
    }

    this.setData({
      "cat.relations": relations,
      parentCats: parentCats,
      childCats: childCats,
    });
  },

  async reloadPhotos() {
    // 这些是精选照片
    const qf = {
      cat_id: this.jsData.cat_id,
      verified: true,
      best: true,
      hidden: { $ne: true } // 管理后台下架的照片不展示
    };
    this.jsData.photoMax = (await app.mpServerless.db.collection('photo').count(qf)).result;
    await Promise.all([
      this.loadMorePhotos(),
      this.reloadAlbum(),
    ]);
  },

  async loadCommentCount() {
    this.setData({
      "cat.comment_count": await getCatCommentCount(this.jsData.cat_id)
    });
  },

  // 点赞状态只认本地 storage（静态数据源下拿不到「谁赞过」的云端数据），
  // 计数直接用 cat.like_count，由 Actions 聚合照片/猫点赞后写回。
  loadLikeState() {
    const likedIds = wx.getStorageSync('likedCatIds') || [];
    this.setData({
      likedCat: !!(likedIds && likedIds.includes(this.jsData.cat_id))
    });
  },

  async reloadAlbum() {
    // 下面是相册的
    const qf_album = {
      cat_id: this.jsData.cat_id,
      verified: true,
      hidden: { $ne: true } // 管理后台下架的照片不展示
    };
    this.jsData.albumMax = (await app.mpServerless.db.collection('photo').count(qf_album)).result;
    this.jsData.album_raw = [];
    await this.loadMoreAlbum();
    this.setData({
      albumMax: this.jsData.albumMax
    });
  },

  async loadMorePhotos() {
    // 在途锁：防止滑动 swiper 时重复触发并发加载
    if (this.jsData.loadingPhotos) {
      return false;
    }
    var cat = this.data.cat;
    // 给这个参数是防止异步
    if ((cat.photo || []).length >= this.jsData.photoMax) {
      return false;
    }
    this.jsData.loadingPhotos = true;
    try {
      const qf = {
        cat_id: this.jsData.cat_id,
        verified: true,
        best: true,
        hidden: { $ne: true } // 管理后台下架的照片不展示
      };
      const step = this.jsData.page_settings.photoStep;
      const now = (cat.photo || []).length;

      let { result: res } = await app.mpServerless.db.collection('photo').find(
        qf,
        { skip: now, limit: step }
      )
      const offset = (cat.photo || []).length;

      // 使用统一的批量签名函数
      res = await signPhotoUrls(res);

      for (let i = 0; i < res.length; ++i) {
        res[i].index = offset + i; // 把index加上，gallery预览要用到
      }
      cat.photo = (cat.photo || []).concat(res);
      this.setData({
        cat: cat
      });
    } finally {
      this.jsData.loadingPhotos = false;
    }
  },

  bindTapFeedback() {
    wx.navigateTo({
      url: '/pages/genealogy/feedbackDetail/feedbackDetail?cat_id=' + this.data.cat._id,
    });
  },

  bindAddPhoto() {
    if (!config.photo_upload_enabled) {
      wx.showToast({ title: '上传功能正在改造，暂未开放', icon: 'none', duration: 2000 });
      return;
    }
    wx.navigateTo({
      url: '/pages/genealogy/addPhoto/addPhoto?cat_id=' + this.data.cat._id,
    });
  },

  bindRating() {
    wx.navigateTo({
      url: '/pages/genealogy/detailCat/ratingDetail/ratingDetail?cat_id=' + this.data.cat._id,
    });
  },

  // 五维评分雷达图（canvas 2d）：把 cat.rating.catRatings 画成五边形，空评时画空圈
  drawRatingRadar() {
    try {
      const cats = (this.data.cat && this.data.cat.rating && this.data.cat.rating.catRatings) || [];
      if (!cats.length) return;
      const query = wx.createSelectorQuery();
      query.select('#rating-radar').fields({ node: true, size: true }).exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        let dpr = 2;
        try {
          dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || wx.getSystemInfoSync().pixelRatio || 2;
        } catch (e) {}
        const w = res[0].width;
        const h = res[0].height;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        const cx = w / 2;
        const cy = h / 2 + 6;
        const radius = Math.min(w, h) / 2 - 30;
        const n = cats.length;
        const angle = (i) => -Math.PI / 2 + i * 2 * Math.PI / n;
        const max = 5;

        // 同心网格
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(12,95,3,0.12)';
        for (let ring = 1; ring <= 4; ring++) {
          const r = radius * ring / 4;
          ctx.beginPath();
          for (let i = 0; i <= n; i++) {
            const a = angle(i % n);
            const x = cx + r * Math.cos(a);
            const y = cy + r * Math.sin(a);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }

        // 轴线 + 维度标签
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < n; i++) {
          const a = angle(i);
          const x = cx + radius * Math.cos(a);
          const y = cy + radius * Math.sin(a);
          ctx.strokeStyle = 'rgba(12,95,3,0.12)';
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(x, y);
          ctx.stroke();
          const lx = cx + (radius + 16) * Math.cos(a);
          const ly = cy + (radius + 16) * Math.sin(a);
          ctx.fillStyle = '#55605A';
          ctx.fillText(cats[i].name, lx, ly);
        }

        // 数据多边形
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const idx = i % n;
          const a = angle(idx);
          const val = Math.max(0, Math.min(max, cats[idx].score || 0));
          const r = radius * val / max;
          const x = cx + r * Math.cos(a);
          const y = cy + r * Math.sin(a);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(20,128,31,0.18)';
        ctx.fill();
        ctx.strokeStyle = '#14801F';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 数据点
        for (let i = 0; i < n; i++) {
          const a = angle(i);
          const val = Math.max(0, Math.min(max, cats[i].score || 0));
          const r = radius * val / max;
          const x = cx + r * Math.cos(a);
          const y = cy + r * Math.sin(a);
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, 2 * Math.PI);
          ctx.fillStyle = '#0C5F03';
          ctx.fill();
        }
      });
    } catch (e) {
      console.warn('[detailCat] 雷达图绘制失败', e);
    }
  },

  async bindTapPhoto(e) {
    wx.showLoading({
      title: '正在加载...',
      mask: true,
    })
    this.currentImg = e.currentTarget.dataset.index;
    // 预览到最后preload张照片时预加载
    const preload = this.jsData.page_settings.galleryPreload;
    this.jsData.whichGallery = e.currentTarget.dataset.kind;
    if (this.jsData.whichGallery == 'best') {
      if (this.data.cat.photo.length - this.currentImg <= preload) await this.loadMorePhotos(); //preload
      var photos = this.data.cat.photo;
    } else if (this.jsData.whichGallery == 'album') {
      if (this.jsData.album_raw.length - this.currentImg <= preload) await this.loadMoreAlbum(); // preload
      var photos = this.jsData.album_raw;
    }

    this.setData({
      showGallery: true,
      galleryPhotos: photos,
      currentImg: this.currentImg,
    });
    wx.hideLoading();
  },

  async bindGalleryChange(e) {
    const index = e.detail.current;
    this.currentImg = index; // 这里得记一下，保存的时候需要
    // preload逻辑
    const preload = this.jsData.page_settings.galleryPreload;
    const photo_count = this.data.galleryPhotos.length;
    if (this.jsData.whichGallery == 'best' && photo_count - index <= preload && photo_count < this.jsData.photoMax) {
      await this.loadMorePhotos(); //preload

      var photos = this.data.cat.photo;
    } else if (this.jsData.whichGallery == 'album' && photo_count - index <= preload && photo_count < this.jsData.albumMax) { //album
      await this.loadMoreAlbum(); // preload
      var photos = this.jsData.album_raw;
    } else {
      return;
    }

    this.setData({
      galleryPhotos: photos,
    });
  },

  bindImageLoaded(e) {
    // wx.hideLoading();
  },

  // 下面开始加载相册咯
  // 相册和上面的photo不同的地方在于，有没有best=true这个条件
  // 而且相册的东西还要再处理一下，分开拍摄年月
  async loadMoreAlbum() {
    if (this.jsData.loadingAlbum) {
      return false;
    }

    if (this.jsData.album_raw.length >= this.jsData.albumMax) {
      this.setData({
        bottomText: config.text.detail_cat.bottom_text_end
      })
      return false;
    }
    const qf = {
      cat_id: this.jsData.cat_id,
      verified: true,
      hidden: { $ne: true } // 管理后台下架的照片不展示
    };
    const step = this.jsData.page_settings.albumStep;
    const now = this.jsData.album_raw.length;


    this.jsData.loadingAlbum = true;
    const orderItem = photoOrder[this.data.photoOrderSelected];

    let res;
    if (orderItem.name == "最早收录") {
      res = (await app.mpServerless.db.collection('photo').find(qf, { skip: now, limit: step })).result;
    } else {
      res = (await app.mpServerless.db.collection('photo').find(qf, { sort: { shooting_date: -1 }, skip: now, limit: step })).result;
    }

    // 使用统一的批量签名函数
    res = await signPhotoUrls(res);
    
    const offset = this.jsData.album_raw.length;
    for (let i = 0; i < res.length; ++i) {
      res[i].index = offset + i; // 把index加上，gallery预览要用到
    }
    this.jsData.album_raw = this.jsData.album_raw.concat(res);
    this.updateAlbum();
  },

  async updateAlbum() {
    // 为了页面显示，要把这个结构处理一下
    // 先按日期分类，分为拍摄日期、上传日期
    var orderIdx = this.data.photoOrderSelected;
    var orderKey = photoOrder[orderIdx].key;
    var group = {};
    for (const pic of this.jsData.album_raw) {
      var date;
      if (orderKey == 'shooting_date') {
        date = pic.shooting_date;
      } else if (orderKey == 'mdate') {
        date = formatDate(pic.mdate, 'yyyy-MM');
      }
      if (!date) {
        continue;
      }
      if (!(date in group)) {
        group[date] = [];
      }
      group[date].push(pic);
    }
    // 下面整理一下，变成页面能展示的
    var result = [];
    var keys = Object.keys(group);
    var order = photoOrder[orderIdx].order == 'asc' ? 1 : -1;
    keys.sort((a, b) => order * a.localeCompare(b));
    for (const key of keys) {
      const shooting_date = key.split('-');
      var birth = this.data.cat.birthday;
      var age = [-1, -1];
      if (birth && orderKey == 'shooting_date') {
        birth = birth.split('-');
        var month = parseInt(shooting_date[1]) - parseInt(birth[1]);
        var year = parseInt(shooting_date[0]) - parseInt(birth[0]);
        if (month < 0) {
          month += 12;
          year -= 1;
        }
        age[0] = year;
        age[1] = month;
      }
      result.push({
        date: shooting_date,
        photos: group[key],
        age: age
      });
    }
    this.jsData.loadingAlbum = false;
    this.setData({
      album: result
    });
  },

  bindphotoOrderChange(e) {
    var selected = e.detail.value;
    this.setData({
      photoOrderSelected: selected
    }, function () {
      this.reloadAlbum();
    })
  },

  // 处理主容器滑动时的行为
  bindContainerScroll(e) {
    const rpx2px = this.jsData.heights.rpx2px;
    // 先保证这两个数字拿到了，再开始逻辑
    if (rpx2px && this.jsData.infoHeight) {
      const showHoverHeader = this.data.showHoverHeader;
      // 这个是rpx为单位的
      const to_top = e.detail.scrollTop / rpx2px;
      // 判断是否要显示/隐藏悬浮标题（精选图的高度+信息栏的高度）
      const hover_thred = 470 + (this.jsData.infoHeight / rpx2px);
      if ((to_top > hover_thred && showHoverHeader == false) || (to_top < hover_thred && showHoverHeader == true)) {
        this.setData({
          showHoverHeader: !showHoverHeader
        });
      }

      const hideBgBlock = this.data.hideBgBlock;
      // 判断是否要隐藏背景颜色块的高度
      const hide_bg_thred = 150;
      if ((to_top > hide_bg_thred && hideBgBlock == false) || (to_top < hide_bg_thred && hideBgBlock == true)) {
        this.setData({
          hideBgBlock: !hideBgBlock
        });
      }
    }
  },

  toComment() {
    const url = `/pages/genealogy/commentBoard/commentBoard?cat_id=${this.jsData.cat_id}`
    wx.navigateTo({
      url: url,
    })
  },

  async likeCountChanged(e) {
    const current = e.detail.current;
    const like_count = e.detail.like_count;
    if (this.jsData.whichGallery == "best") {
      const bestList = this.data.cat.photo || [];
      const before = bestList[current];
      const oldCount = (before && before.like_count) || 0;
      // 同步到 COS inbox，由 Action 聚合。旧值还没被 setData 覆盖，可以据此判断点赞还是取消
      if (before && before._id) {
        await putInbox('like', {
          photo_id: before._id,
          cat_id: this.jsData.cat_id,
          like: like_count > oldCount,
        });
      }
      this.setData({
        [`cat.photo[${current}].like_count`]: like_count,
      });
    } else if (this.jsData.whichGallery == "album") {
      const before = this.jsData.album_raw[current];
      const oldCount = (before && before.like_count) || 0;
      if (before && before._id) {
        await putInbox('like', {
          photo_id: before._id,
          cat_id: this.jsData.cat_id,
          like: like_count > oldCount,
        });
      }
      this.jsData.album_raw[current].like_count = like_count;
      this.updateAlbum();
    }
  },

  toRelationCat(e) {
    var cat_id = e.currentTarget.dataset.cat_id;
    const url = `/pages/genealogy/detailCat/detailCat?cat_id=${cat_id}`;
    wx.navigateTo({
      url: url,
    });
  },

  async loadUser() {
    var user = await getUser({
      nocache: true,
    });
    user = deepcopy(user);
    if (!user.userInfo) {
      user.userInfo = {};
    }
    // 处理点赞（本地 storage 是唯一可信来源）
    const likedIds0 = wx.getStorageSync('likedCatIds') || [];
    const likedCat = !!(likedIds0 && likedIds0.includes(this.data.cat._id));
    this.setData({
      user,
      likedCat
    });
  },

  bindDetailRating(e) {
    let { showDetailRating } = this.data;
    showDetailRating = !showDetailRating;
    this.setData({
      showDetailRating
    });
    if (showDetailRating) {
      this.drawRatingRadar();
    }
  },

  // 从详情页进入领养申请。app.json 里已经注册了 applyAdoption，
  // 之前没有入口，所以页面存在但永远打不开。
  bindApplyAdoption() {
    const catId = this.data.cat && this.data.cat._id;
    if (!catId) {
      wx.showToast({ title: '缺少猫咪信息', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/adoption/applyAdoption/applyAdoption?cat_id=' + catId,
    });
  },

  // 猫咪点赞：本地切换 + 乐观更新计数 + 写 inbox（Actions 聚合到 cat.like_count）
  async likeCat() {
    const catId = this.data.cat && this.data.cat._id;
    if (!catId) return;

    const likedIds = wx.getStorageSync('likedCatIds') || [];
    const wasLiked = likedIds.includes(catId);
    const nextLiked = !wasLiked;
    const nextIds = wasLiked ? likedIds.filter(id => id !== catId) : likedIds.concat(catId);
    // 同步写本地，是防连点的唯一可信来源，必须在 await 之前完成
    wx.setStorageSync('likedCatIds', nextIds);

    const cur = Number(this.data.cat.like_count) || 0;
    // 先入队，await 保证顺序后再做本地乐观更新（切换关注态、加减计数）
    await putInbox('like', { cat_id: catId, like: nextLiked });

    this.setData({
      likedCat: nextLiked,
      'cat.like_count': Math.max(0, cur + (nextLiked ? 1 : -1)),
    });
  },

  // 获取最新疫苗记录
  async getLatestVaccine(cat_id) {
    try {
      const result = await api.vaccineOp({
        operation: 'list',
        cat_id: cat_id
      });

      if (result?.result === true && Array.isArray(result.data) && result.data.length > 0) {
        // 处理所有疫苗记录的日期格式
        const vaccineHistory = result.data.map(vaccine => {
          // 判断疫苗是否过期
          const today = new Date();
          const expireDate = vaccine.expire_date ? new Date(vaccine.expire_date) : null;
          const is_expired = expireDate ? today > expireDate : false;
          return {
            ...vaccine,
            vaccine_date_formatted: vaccine.vaccine_date ? formatDate(vaccine.vaccine_date, "yyyy-MM-dd") : '',
            expire_date_formatted: vaccine.expire_date ? formatDate(vaccine.expire_date, "yyyy-MM-dd") : '',
            next_vaccine_date_formatted: vaccine.next_vaccine_date ? formatDate(vaccine.next_vaccine_date, "yyyy-MM-dd") : '',
            is_expired
          };
        });

        // 按日期排序
        vaccineHistory.sort((a, b) => {
          const dateA = a.vaccine_date ? new Date(a.vaccine_date).getTime() : 0;
          const dateB = b.vaccine_date ? new Date(b.vaccine_date).getTime() : 0;
          return dateB - dateA;
        });

        // 保存所有疫苗记录
        this.setData({
          vaccineHistory
        });

        // 设置最新的疫苗记录
        if (vaccineHistory[0] && vaccineHistory[0].vaccine_date) {
          this.setData({
            'cat.lastVaccine': vaccineHistory[0]
          });
        }
      }
    } catch (error) {
      console.error('获取疫苗记录失败:', error);
    }
  },

  // 显示疫苗记录历史
  toVaccineDetail() {
    this.setData({
      showVaccineHistory: true
    });
  },

  // 隐藏疫苗记录历史
  hideVaccineHistory() {
    this.setData({
      showVaccineHistory: false
    });
  },

  // 展开/收起谱系树
  toggleGenealogyTree() {
    this.setData({
      showGenealogyTree: !this.data.showGenealogyTree
    });
  },

  // 点击谱系树节点，跳转对应猫猫详情
  onGenealogyTap(e) {
    const catId = e.detail.catId;
    if (!catId) {
      return;
    }
    wx.navigateTo({
      url: `/pages/genealogy/detailCat/detailCat?cat_id=${catId}`,
    });
  },
})