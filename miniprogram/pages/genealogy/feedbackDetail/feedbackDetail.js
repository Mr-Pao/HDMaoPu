import { getCurrentPath, shareTo } from "../../../utils/utils";
import { getUser, checkCanFeedback, isManagerAsync } from "../../../utils/user";
import { requestNotice, sendNotifyChkFeeedback } from "../../../utils/msg";
import { putInbox } from "../../../utils/writeback";
import { markPending } from "../../../utils/syncTip";
import { text as text_cfg } from "../../../config";
import { getCurrentUserOpenid } from "../../../utils/common";
import api from "../../../utils/cloudApi";
const app = getApp();
Page({
  /**
   * 页面的初始数据
   */
  data: {
    user: {},
    nickname: '',
    feedbackLength: 0,
    maxlength: 300,
    cat: undefined,
    text_cfg: text_cfg,
    isManager: false,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    if (options.cat_id != undefined) {
      const { result: catRes } = await app.mpServerless.db.collection('cat').findOne({ _id: options.cat_id }, { projection: { name: 1, _id: 1 } })
      this.setData({
        cat: catRes
      });
    }

    // 管理员可在此直接进入关系管理（添加关系入口已从详情页迁来）
    this.setData({
      isManager: await isManagerAsync(3)
    });

    // 检查是否可以上传
    this.setData({
      canFeedback: await checkCanFeedback()
    });
  },

  async onShow() {
    const user = await getUser();
    // 昵称就地填，本机记住上一次填的（换设备自然丢失）
    this.setData({
      user: user || {},
      nickname: wx.getStorageSync('last_nickname') || '',
    });
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    const pagesStack = getCurrentPages();
    const path = getCurrentPath(pagesStack);
    const share_text = `来给${this.data.cat.name}反馈信息 - ${text_cfg.app_name}`;
    return shareTo(share_text, path);
  },

  // 昵称输入（选填，不填就匿名）
  inputNickname(e) {
    this.setData({
      nickname: e.detail.value
    });
  },

  bindInput(e) {
    var inputData = e.detail.value;
    var name = e.currentTarget.dataset.name;
    if (name == 'feedbackInfo') {
      this.setData({
        feedbackLength: inputData.length
      })
      return;
    }

    if (name == 'contactInfo') {
      this.setData({
        contactLength: inputData.length
      })
      return;
    }
  },

  async safeCheck(submitData) {
  },

  async bindSubmit(e) {
    var submitData = e.detail.value;
    if (!submitData.feedbackInfo) {
      wx.showToast({
        title: '请填写信息后再提交哦',
        icon: 'none'
      })
      return;
    }
    // 安全检查
    console.log(submitData);
    const checkRes = await api.contentSafeCheck(submitData.feedbackInfo + submitData.contactInfo, "");
    console.log(checkRes);
    if (checkRes) {
      // 检测出问题
      wx.showModal(checkRes);
      return false;
    }

    wx.showLoading({
      title: '正在提交...',
      mask: true,
    })
    // 用户记录拿不到时兜底取 openid，保证每条反馈都能追到人
    const openid = (this.data.user && this.data.user.openid) || await getCurrentUserOpenid();
    var data = {
      openid: openid,
      openDate: api.getDate(),
      feedbackInfo: submitData.feedbackInfo,
      contactInfo: submitData.contactInfo,
      dealed: false,
    };
    if (this.data.cat != undefined) {
      data.cat_id = this.data.cat._id;
      data.cat_name = this.data.cat.name;
    }
    const res = await api.curdOp({
      operation: "add",
      collection: "feedback",
      data: data
    });

    console.log("curdOp(add-feedback) result:", res);
    if (!res.ok) {
      console.log('repliable record fail:\n');
      return;
    }

    // 同步到 COS inbox，由 Action 聚合进审核队列（kind 复用 comment，带 type 标记；
    // handleComment 要求 cat_id 非空，无关联猫猫时用占位标记，审核页可见即可）
    // 昵称取输入框的值，空则匿名；顺手记到本机（换设备自然丢失）
    if (this.data.nickname) {
      wx.setStorageSync('last_nickname', this.data.nickname);
    }
    const inboxCatId = data.cat_id || '(feedback)';
    const ok = await putInbox('comment', {
      cat_id: inboxCatId,
      content: data.feedbackInfo + (data.contactInfo ? `\n联系方式: ${data.contactInfo}` : ''),
      nickname: this.data.nickname || '匿名猫友',
      type: 'feedback',
    });
    if (ok) {
      markPending("comment", { cat_id: inboxCatId, label: "信息纠错" });
    }

    this.setData({
      feedbackId: res.insertedId
    });
    await this.askNotice();
    wx.hideLoading();
    await sendNotifyChkFeeedback();
    // 提交后要等 Actions 聚合 + 人工审核才展示，提示里说明延迟
    wx.showToast({
      title: ok ? '已收到，审核后展示' : text_cfg.sync.offline_tip,
      icon: 'none',
      duration: 2000
    })
  },

  async askNotice() {
    let repliable = await requestNotice('feedback'); // 请求订阅消息推送

    const res = await api.curdOp({
      operation: "update",
      collection: "feedback",
      item_id: this.data.feedbackId,
      data: { repliable: repliable },
    });

    console.log("curdOp(feedback-update) result:", res);
    if (res.ok) {
      wx.navigateBack();
    } else {
      console.log('repliable record fail:\n', res);
    }

  },

  toAddRelation() {
    const cat_id = this.data.cat && this.data.cat._id;
    if (!cat_id) return;
    wx.navigateTo({ url: `/pages/manage/catManage/catManage?cat_id=${cat_id}&activeTab=relation` });
  },

  async changeAgreement(e) {
    console.log(e);
    const checked = e.detail.value.length > 0;
    this.setData({
      agreementChecked: checked,
    })
  }
})

