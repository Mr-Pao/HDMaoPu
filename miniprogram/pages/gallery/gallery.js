import { getCatItemMulti } from "../../utils/cat";
import config from "../../config";
import { showTab } from "../../utils/page";
import { signCosUrl } from "../../utils/common";

const app = getApp();

const share_text = config.text.app_name + ' - ' + (config.text.gallery?.share_tip || '猫咪图库');

const { applyNav } = require('../../utils/nav');

Page({
  jsData: {
    columnsHeight: [0, 0],
    isLoading: false,
  },
  data: {
    columns: [[], []],
    tempPics: [],
    loadnomore: false,
    total: 0,
    statusBarHeight: 20,
    navBarHeight: 44,
    tabBarHeight: 80,
    heights: {},
  },
  onShow: function () {
    applyNav(this);
    showTab(this);
  },
  onShareAppMessage: function () {
    return { title: share_text };
  },
  onShareTimeline: function () {
    return this.onShareAppMessage();
  },
  loadPic: function (e) {
    const that = this;
    const tempPics = that.data.tempPics;
    const index = e.currentTarget.dataset.index;
    if (tempPics[index]) {
      tempPics[index].height = e.detail.height * 750 / e.detail.width;
      tempPics[index].isLoad = true;
    }
    that.setData({ tempPics }, function () { that.finLoadPic(); });
  },
  loadPicError: function (e) {
    const that = this;
    const tempPics = that.data.tempPics;
    const index = e.currentTarget.dataset.index;
    if (tempPics[index]) {
      tempPics[index].height = 750;
      tempPics[index].isLoad = true;
    }
    that.setData({ tempPics }, function () { that.finLoadPic(); });
  },
  finLoadPic: function () {
    const tempPics = this.data.tempPics;
    let fin = true;
    for (let i = 0; i < tempPics.length; i++) {
      if (!tempPics[i].isLoad) { fin = false; break; }
    }
    if (fin && this.jsData.isLoading) {
      this.jsData.isLoading = false;
      this.renderPage();
    }
  },
  renderPage: function () {
    const data = this.data;
    const columns = data.columns;
    const columnsHeight = this.jsData.columnsHeight;
    for (const pic of data.tempPics) {
      const index = columnsHeight[0] <= columnsHeight[1] ? 0 : 1;
      columns[index].push(pic);
      columnsHeight[index] += pic.height;
    }
    this.setData({
      columns,
      tempPics: [],
      loadnomore: true,
    });
    this.jsData.columnsHeight = columnsHeight;
  },
  loadData: async function () {
    if (this.jsData.isLoading) return;
    this.jsData.isLoading = true;
    this.setData({ loadnomore: false });

    const curCount = this.data.columns[0].length + this.data.columns[1].length;
    var { result: photos } = await app.mpServerless.db.collection('photo').find({
      verified: true,
    }, { sort: { mdate: -1 }, skip: curCount, limit: 10 });

    if (!photos || !photos.length) {
      this.jsData.isLoading = false;
      this.setData({ loadnomore: true });
      return;
    }

    const cat_res = await getCatItemMulti(photos.map(p => p.cat_id));
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      p.pic = await signCosUrl(p.photo_compressed || p.photo_id);
      p.pic_prev = await signCosUrl(p.photo_id);
      p.cat = cat_res[i];
    }

    this.setData({ tempPics: photos });
  },
  loadTotal: async function () {
    try {
      var { result } = await app.mpServerless.db.collection('photo').count({ verified: true });
      this.setData({ total: result });
    } catch (e) {
      console.warn('图库总数获取失败', e);
    }
  },
  onLoad: function () {
    this.loadTotal();
    this.loadData();
    this.getHeights();
  },
  onReachBottom: function () {
    this.loadData();
  },
  clickPhoto: function (e) {
    const { url } = e.currentTarget.dataset;
    wx.previewImage({ urls: [url] });
  },
  clickCatName: function (e) {
    const { cat_id } = e.currentTarget.dataset;
    wx.navigateTo({
      url: '/pages/genealogy/detailCat/detailCat?cat_id=' + cat_id,
    });
  },
  getHeights() {
    wx.getSystemInfo({
      success: res => {
        const rpx2px = res.windowWidth / 750;
        this.setData({
          "heights.statusBarHeight": res.statusBarHeight,
          "heights.navBarHeight": 44,
          "heights.windowHeight": res.windowHeight,
          "heights.rpx2px": rpx2px,
          "heights.listHeight": res.windowHeight - res.statusBarHeight - (44 + 60) * rpx2px,
        });
      }
    });
  },
});
