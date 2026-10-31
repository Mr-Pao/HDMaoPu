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
    github_link: "https://github.com/sysucats/zhongdamaopu",
    update_log: [
      {
        version: "v3.1.0",
        content: [
          "整合EMAS函数，节省部署费用",
          "提升性能"
        ],
        time: "2026/6/27"
      },{
        version: "v3.0.0",
        content: [
          "迁移到EMAS",
          "新增喵ID海报生成功能",
          "新增关注猫猫功能",
          "新增管理员数据看板",
          "更新个人主页",
          "修复部分BUG"
        ],
        time: "2025/10/6"
      },{
      version: "v2.2.2",
      content: [
        "修复评分bug"
      ],
      time: "2024/5/23"
    },{
      version: "v2.2.1",
      content: [
        "修复猫猫部分UI问题",
        "修复重复评分bug"
      ],
      time: "2024/5/22"
    },{
      version: "v2.2.0",
      content: [
        "新增猫猫评分",
        "修改关于页统计数和文档链接",
        "优化首页白屏提示",
        "优化徽章榜单的统计效率",
        "优化图像处理功能"
      ],
      time: "2024/5/22"
    }, {
      version: "v2.1.1",
      content: [
        "修复点赞榜单"
      ],
      time: "2023/7/25"
    }, {
      version: "v2.1.0",
      content: [
        "徽章系统上线啦~",
        "新增徽章兑换码系统&徽章赠送记录",
        "修改精选Tab为榜单",
        "修改留言板为便利贴墙",
        "修复科普页图片等问题",
        "修复关于页数字不显示的问题",
        "修复首页空白问题",
      ],
      time: "2023/7/24"
    }, {
      version: "v2.0.2",
      content: [
        "首页添加Tips"
      ],
      time: "2023/7/20"
    }, {
      version: "v2.0.1",
      content: [
        "主题色调改为绿色",
      ],
      time: "2023/7/14"
    }, {
      version: "v2.0.0",
      content: [
        "小程序重新部署上线啦"
      ],
      time: "2023/7/13"
    }]
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