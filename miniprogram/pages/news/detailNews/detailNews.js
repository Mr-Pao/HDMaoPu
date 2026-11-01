import {
  shareTo,
  getCurrentPath,
  formatDate
} from "../../../utils/utils";
import { signCosUrl } from "../../../utils/common";

const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    news_id: 0,
    news: 0,
    updateRequest: false,
    err: false,
    photos_path: [],
    cover_path: "",
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    this.setData({
      news_id: options.news_id
    })
    await this.loadNews();
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    const pagesStack = getCurrentPages();
    const path = getCurrentPath(pagesStack);
    const share_text = `${this.data.news.title}`;
    console.log("[onShareAppMessage] -", shareTo(share_text, path))
    return shareTo(share_text, path);
  },

  async loadNews() {
    const that = this;
    var { result } = await app.mpServerless.db.collection('news').findOne({
      _id: this.data.news_id
    })
    console.log("[loadNews] - NewsDetail:", result);
    if (!result) {
      that.setData({
        err: true,
      })
      return;
    }

    var news = result;
    news.ddate = formatDate(new Date(news.date), "yyyy年MM月dd日 hh:mm:ss");
    if (news.dateLastModify) {
      news.ddateLastModify = formatDate(new Date(news.dateLastModify), "yyyy年MM月dd日 hh:mm:ss");
    }
    // 签名 coverPath
    if (news.coverPath) {
      news.coverPath = await signCosUrl(news.coverPath);
    }

    // 签名 photosPath
    const signedPhotosPath = await Promise.all(news.photosPath.map(val => signCosUrl(val)));

    that.setData({
      news: news,
      photos_path: signedPhotosPath,
      cover_path: news.coverPath,
    });
  },

  previewImg: function (event) {
    const that = this;
    console.log("[previewImg] -", event);
    wx.previewImage({
      current: that.data.photos_path[event.currentTarget.dataset.index],
      urls: that.data.photos_path
    })
  },
})