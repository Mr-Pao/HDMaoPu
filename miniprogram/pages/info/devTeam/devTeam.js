import {
  text as text_cfg
} from "../../../config";

const share_text = text_cfg.app_name + ' - ' + text_cfg.info.share_tip;

Page({
  /**
   * 页面的初始数据
   */
  data: {
    text_cfg: text_cfg,
    github_link: "https://github.com/sysucats/zhongdamaopu"
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: function (options) {

  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady: function () {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: function () {

  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide: function () {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload: function () {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh: function () {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom: function () {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    return {
      title: share_text
    }
  },

  copyWechat: function () {
    wx.setClipboardData({
      data: "Pao_Leo",
    });
  },

  copyOpenSourceLink: function () {
    wx.setClipboardData({
      data: this.data.github_link,
    });
  }
})