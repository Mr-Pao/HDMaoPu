import {
  deepcopy
} from "../../../utils/utils";
import {
  getUser
} from "../../../utils/user";
import {
  getAvatar
} from "../../../utils/cat";
import { putInbox } from "../../../utils/writeback";
const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  jsData: {
    updatingFollowCats: false,
  },
  data: {
    followCount: 0,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  async onLoad() {
    await this.loadUser();
    await this.loadFollowCats();
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {

  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },


  async loadUser() {
    var user = await getUser({
      nocache: true,
    });
    user = deepcopy(user);
    if (!user.userInfo) {
      user.userInfo = {};
    }
    this.setData({
      user,
    });
  },


  async loadFollowCats() {
    // 关注列表改为本地 storage 维护（detailCat 关注/取关时同步写入）
    const followCatIds = wx.getStorageSync('followedCatIds') || [];

    console.log(followCatIds);

    if (!followCatIds.length) {
      this.setData({
        followCats: [],
        followCount: 0,
      });
      return;
    }

    // 加载猫猫的信息
    const { result: followCats } = await app.mpServerless.db.collection('cat').find({ _id: { $in: followCatIds } })
    console.log(followCats);

    for (let i = 0; i < followCats.length; i++) {
      var p = followCats[i];
      p.unfollowed = false;
      p.avatar = await getAvatar(p._id, p.photo_count_best)
    }
    this.setData({
      followCats,
      followCount: followCats.length,
    });
  },

  async doFollowCat(e) {
    if (this.jsData.updatingFollowCats) {
      return;
    }

    this.jsData.updatingFollowCats = true;

    let { unfollowed, catid, index } = e.currentTarget.dataset;

    // 本地维护关注列表
    let followedIds = wx.getStorageSync('followedCatIds') || [];
    let res = true;
    if (unfollowed) {
      if (!followedIds.includes(catid)) {
        followedIds.push(catid);
      }
    } else {
      if (!followedIds.includes(catid)) {
        // 本地列表里没有的猫，视为取关失败（异常状态）
        res = false;
      } else {
        followedIds = followedIds.filter(id => id !== catid);
      }
    }
    if (res) {
      wx.setStorageSync('followedCatIds', followedIds);
      // 同步到 COS inbox，由 Action 聚合关注数（与 detailCat 的关注行为保持一致）
      putInbox('follow', {
        cat_id: catid,
        follow: !!unfollowed,
      });
    }

    let { followCount } = this.data;
    if (res) {
      followCount += unfollowed ? 1 : -1;
    }

    this.setData({
      [`followCats[${index}].unfollowed`]: res ? !unfollowed : unfollowed,
      followCount
    });

    wx.showToast({
      title: `${unfollowed ? "关注" : "取关"}${res ? "成功" : "失败"}`,
      icon: res ? "success" : "error"
    });
    this.jsData.updatingFollowCats = false;
  }
})