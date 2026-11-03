// 处理反馈
import { formatDate } from "../../../utils/utils";
import { sendReplyNotice } from "../../../utils/msg";
import { checkAuth, getUserInfo } from "../../../utils/user";
import api from "../../../utils/cloudApi";
import passcode from "../../../utils/passcode";
import { putInbox } from "../../../utils/writeback";

const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    feedback: undefined,
    maxlength: 300,
    length: 0,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    // ⚠️ 必须 await：checkAuth 是 async，漏了 await 会拿到 Promise（恒真），权限判断等于失效
    if (await checkAuth(this, 1)) {
      await this.reload(options);
    }
  },

  async reload(options) {
    wx.showLoading({
      title: '加载中...',
    });
    var { result } = await app.mpServerless.db.collection('feedback').findOne({
      _id: options.fb_id
    })
    if (!result.userInfo) {
      result.userInfo = (await getUserInfo(result.openid)).userInfo;
    }

    result.openDateStr = formatDate(result.openDate, "yyyy-MM-dd hh:mm:ss");
    this.setData({
      feedback: result
    });
    wx.hideLoading();
  },

  bindInput(e) {
    var inputData = e.detail.value;
    this.setData({
      length: inputData.length
    })
  },

  async bindReply(e) {
    var submitData = e.detail.value;
    // 防重复提交：确认弹窗到回写完成之间可能被连点，重复回复会触发两次订阅消息
    if (this.replying) return;
    if (!submitData.replyInfo) {
      wx.showToast({
        title: '请填写回复后再提交哦',
        icon: 'none'
      })
      return;
    }
    const res = await wx.showModal({
      title: '提示',
      content: '由于微信限制，每条反馈最多只能回复1次，确定回复吗？',
    });

    if (res.confirm) {
      this.replying = true;
      wx.showLoading({
        title: '正在提交...',
        mask: true
      });
      let res = await sendReplyNotice(this.data.feedback._openid, this.data.feedback._id);
      const that = this;
      if (res.apiResponse.errCode == 0) {
        // 记录一下回复的内容和时间（真实写入：走 COS inbox 聚合链路）
        // 口令在关于页解锁时已存进本机，直接取；取不到会提示重新解锁
        const token = passcode.ensureToken();
        if (!token) {
          wx.hideLoading();
          this.replying = false;
          return;
        }
        // 一次提交把状态和回复内容一起带上；原来后面还紧跟一次 bindCheck()
        // 又发了一遍 manageFeedback（只带 status），等于同一件事提交两次。
        const ok = await putInbox('manage', {
          action: 'manageFeedback',
          token: token,
          feedback_id: that.data.feedback._id,
          patch: {
            status: 'done',
            replyInfo: submitData.replyInfo,
            replyDate: api.getDate(),
          },
        });

        if (!ok) {
          wx.hideLoading();
          this.replying = false;
          wx.showToast({ title: '提交失败，请检查网络', icon: 'none' });
          return;
        }

        // 发送刷新事件
        app.globalData.eventBus.$emit('feedbackUpdated', {
          id: this.data.feedback._id,
          action: 'reply',
          replyInfo: submitData.replyInfo
        });

        wx.hideLoading();
        wx.showToast({
          title: '回复成功',
          icon: 'success',
          duration: 1000,
          success: () => {
            setTimeout(wx.navigateBack, 1000)
          }
        })
      } else if ((res.apiResponse.errCode == 43101)){
        wx.hideLoading();
        wx.showToast({
          title: '回复失败，这可能是因为对方没有订阅或次数耗尽',
          icon: 'none',
          duration: 1500,
          success: () => {
            setTimeout(wx.navigateBack, 1500)
          }
        });
      } else {
        wx.hideLoading();
        wx.showToast({
          title: '回复失败，errCode：' + res.apiResponse.errCode,
          icon: 'none',
          duration: 1500,
          success: () => {
            setTimeout(wx.navigateBack, 1500)
          }
        });
      }
    }
  },
})

