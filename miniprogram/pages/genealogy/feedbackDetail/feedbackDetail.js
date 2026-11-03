import { getCurrentPath, shareTo } from "../../../utils/utils";
import { getUser, checkCanFeedback } from "../../../utils/user";
import { requestNotice, sendNotifyChkFeeedback } from "../../../utils/msg";
import { putInbox } from "../../../utils/writeback";
import { markPending, backAfterSubmit } from "../../../utils/syncTip";
import { getNickname, saveNickname } from "../../../utils/nickname";
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
      nickname: getNickname(),
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
    const checkRes = await api.contentSafeCheck(submitData.feedbackInfo + submitData.contactInfo, "");
    if (checkRes) {
      // 检测出问题
      wx.showModal(checkRes);
      return false;
    }

    wx.showLoading({
      title: '正在提交...',
      mask: true,
    })
    // 订阅意愿必须在用户点击后立刻问（wx.requestSubscribeMessage 要求用户手势）。
    // 结果一并提交给服务端：管理员看到 repliable=false 就不显示「回复」按钮。
    const repliable = await requestNotice('feedback');

    // 用户记录拿不到时兜底取 openid，保证每条反馈都能追到人
    const openid = (this.data.user && this.data.user.openid) || await getCurrentUserOpenid();
    var data = {
      openid: openid,
      feedbackInfo: submitData.feedbackInfo,
      contactInfo: submitData.contactInfo || '',
      repliable: repliable === true,
    };
    if (this.data.cat != undefined) {
      data.cat_id = this.data.cat._id;
      data.cat_name = this.data.cat.name;
    }

    // 反馈走独立 kind（v4.0.71 起）：服务端 handleFeedback 会把它放进审核队列，
    // 审核通过后落 data/feedback.json —— 管理端「反馈处理」页才有数据可处理。
    // 以前借道 kind='comment'，服务端把 type:'feedback' 直接丢了，反馈永远进不了 feedback 表。
    if (this.data.nickname) {
      saveNickname(this.data.nickname);
    }
    const ok = await putInbox('feedback', {
      cat_id: data.cat_id || '',
      cat_name: data.cat_name || '',
      feedbackInfo: data.feedbackInfo,
      contactInfo: data.contactInfo,
      nickname: this.data.nickname || '匿名猫友',
      repliable: data.repliable,
    });
    if (ok) {
      markPending("feedback", { cat_id: data.cat_id, label: "信息纠错" });
    }

    wx.hideLoading();
    await sendNotifyChkFeeedback();
    // 提交后要等 Actions 聚合 + 人工审核才展示，提示里说明延迟；
    // 填完这一页就没别的事了，成功走「提示 + 自动返回上一页」，防止重复提交。
    // 失败不返回：留在页面上，输入的内容还在，用户可以再点一次。
    if (ok) {
      backAfterSubmit(text_cfg.sync.received_tip, { delay: 1400 });
    } else {
      wx.showToast({ title: text_cfg.sync.offline_tip, icon: 'none', duration: 2500 });
    }
  },

  async changeAgreement(e) {
    const checked = e.detail.value.length > 0;
    this.setData({
      agreementChecked: checked,
    })
  }
})

