import { convertRatingList, genDefaultRating } from "../../../../utils/rating";
import api from "../../../../utils/cloudApi";
import { putInbox } from "../../../../utils/writeback";
import { markPending } from "../../../../utils/syncTip";
import { text as text_cfg } from "../../../../config";

const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    catRatings: genDefaultRating(),
    myRatingId: undefined,
    myRatings: genDefaultRating(),
  },

  jsData: {
    submitting: false,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  async onLoad(options) {
    // current-user 可能为空（无档案体系），?.item 兜底成 {} 避免 TypeError
    this.setData({
      cat_id: options.cat_id,
      user: wx.getStorageSync('current-user')?.item || {}
    });
    await Promise.all([
      this.reloadMyRatings(),
      this.reloadCatRating()
    ]);
  },
  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  async onShow() {
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  },

  // 重新加载自己的评分
  async reloadMyRatings() {
    // 获取榜单和标签定义
    if (!(this.data.user && this.data.user.openid)) {
      console.log(this.data);
      return
    }
    const { result: myRatingsItems } = await app.mpServerless.db.collection('rating').findOne({ _openid: this.data.user.openid, cat_id: this.data.cat_id })

    console.log(myRatingsItems);

    if (!myRatingsItems) {
      // 还没有评分
      return;
    }

    let myRatings = convertRatingList(myRatingsItems);

    console.log(myRatings);
    this.setData({
      myRatings,
      myRatingId: myRatingsItems._id,
    })
  },

  // 重新加载猫猫信息
  async reloadCatRating() {
    let { cat_id } = this.data;
    let { result: cat } = await app.mpServerless.db.collection('cat').findOne({ _id: cat_id })

    console.log(cat);

    if (!cat.rating) {
      this.setData({
        cat
      });
      return;
    }

    // 维度分用 dimAvg；scores 是「综合分 = N 的得票数」，不是分数。
    let { dimAvg } = cat.rating;
    let catRatings = convertRatingList(dimAvg || {});

    this.setData({
      cat,
      catRatings
    });
  },

  changRating(e) {
    let { i, j } = e.currentTarget.dataset;
    // console.log(i, j);
    this.setData({
      [`myRatings[${i}].score`]: j + 1,
    });
  },

  async submitRating(e) {
    let { submitting } = this.jsData;
    if (submitting) {
      return;
    }
    this.jsData.submitting = true;
    wx.showLoading({
      title: '提交中...',
    });

    let { myRatingId, myRatings, cat_id } = this.data;

    let item = {
      cat_id
    };
    for (const r of myRatings) {
      if (!r.score) {
        wx.hideLoading();
        this.jsData.submitting = false;
        wx.showToast({
          title: '评分不能为0',
          icon: 'none'
        })
        return false;
      }
      item[r.key] = r.score;
    }

    if (!myRatingId) {
      var res = await api.curdOp({
        operation: "add",
        collection: "rating",
        data: item
      });
    } else {
      var res = await api.curdOp({
        operation: "update",
        collection: "rating",
        data: item,
        item_id: myRatingId
      });
    }

    console.log(res);

    // 同步到 COS inbox，由 Action 聚合回写 data/cat.json 的 rating。
    // score 是综合分（五维取整平均），决定 scores/avgScore；
    // dims 是五维原始分，决定 dimAvg。两者都传，聚合端才知道「各项评分」该显示什么。
    const dims = {};
    for (const r of myRatings) {
      dims[r.key] = r.score;
    }
    const avg = myRatings.reduce((sum, r) => sum + r.score, 0) / myRatings.length;
    const score = Math.min(5, Math.max(1, Math.round(avg)));
    // 提交后要等 Actions 聚合才生效，提示里说明延迟
    const ok = await putInbox('rating', { cat_id, score, dims });
    await Promise.all([
      this.reloadMyRatings(),
      this.reloadCatRating()
    ]);

    wx.hideLoading();

    if (ok) {
      markPending("rating", { cat_id, label: "评分" });
      wx.showToast({
        title: '已提交，稍后自动汇总',
        icon: 'none',
        duration: 2000,
      });
    } else {
      wx.showToast({
        title: text_cfg.sync.offline_tip,
        icon: 'none',
        duration: 2500,
      });
    }
    this.jsData.submitting = false;
  }
})