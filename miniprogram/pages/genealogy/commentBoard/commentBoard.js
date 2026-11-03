import {
  formatDate,
  randomInt
} from "../../../utils/utils";
import config from "../../../config";
import {
  getUser,
  fillUserInfo,
  checkCanComment
} from "../../../utils/user";
import { blockInReview } from "../../../utils/review";
import {
  getCurrentUserOpenid
} from "../../../utils/common";
import {
  getAvatar
} from "../../../utils/cat";
import {
  getCatCommentCount
} from "../../../utils/comment";
import {
  requestNotice,
} from "../../../utils/msg";
import {
  putInbox,
} from "../../../utils/writeback";
import {
  markPending,
} from "../../../utils/syncTip";
import {
  getNickname,
  saveNickname,
} from "../../../utils/nickname";
import api from "../../../utils/cloudApi";
const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    show_fix_header: false,
    cat: {},
    comments: [],
    comment_count: 0,
    keyboard_height: 0,
    text_cfg: config.text,
    is_owner: false,
    user: {},
    nickname: '',

    paper_colors: ['white', 'yellow', 'green', 'pink'],
    paper_color_select: 0,
  },

  jsData: {
    cat_id: null,
    sendLock: false,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    if (await blockInReview("便利贴暂未开放")) return;
    this.jsData.cat_id = options.cat_id;
    this.setData({
      canComment: await checkCanComment()
    })
    // 启动加载
    await Promise.all([
      this.loadCat(),
      this.loadMoreComment(),
    ]);
  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady: function () {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow: async function () {
    await this.loadUserInfo();
  },

  // 昵称改为选填：不拦发便利贴，只用于显示与审核通知
  // 每次提交就地填，本机记住上一次填的（utils/nickname 的 last_nickname），换设备自然丢失
  async loadUserInfo() {
    const user = (await getUser()) || {};
    this.setData({
      user: Object.assign({}, user, {
        userInfo: user.userInfo || {},
      }),
      nickname: getNickname(),
    });
  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide: function () {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload: async function () {
    await this.ifSendNotifyVeriftMsg()
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
    const cat = this.data.cat;
    const cat_name = cat.name;
    const cat_avatar = cat.avatar.photo_compressed || cat.avatar.photo_id;
    return {
      title: `${cat_name}的便利贴墙 - ${config.text.app_name}`,
      imageUrl: cat_avatar,
    }
  },

  onShareTimeline: function () {
    return this.onShareAppMessage();
  },

  bindCommentScroll(e) {
    const to_top = e.detail.scrollTop;
    const show_fix_header = this.data.show_fix_header;

    const should_show = to_top > 5 ? true : false;
    if (should_show != show_fix_header) {
      this.setData({
        show_fix_header: should_show
      });
    }
  },

  async loadCat() {
    var cat = (await app.mpServerless.db.collection('cat').findOne({ _id: this.jsData.cat_id })).result;

    // 获取头像
    cat.avatar = await getAvatar(cat._id, cat.photo_count_best);

    // 获取总数
    var comment_count = await getCatCommentCount(cat._id);
    this.setData({
      cat: cat,
      comment_count: comment_count
    });
  },

  commentFocus(e) {
    this.setData({
      keyboard_height: e.detail.height || 0,
      input_focus: true,
    })
  },

  commentBlur() {
    this.setData({
      keyboard_height: 0,
      input_focus: false,
    })
  },

  commentInput(e) {
    this.setData({
      comment_input: e.detail.value
    });
  },

  // 昵称输入（选填，不填就匿名）
  inputNickname(e) {
    this.setData({
      nickname: e.detail.value
    });
  },

  // 发送便利贴
  async sendComment() {
    // 发送中
    if (this.jsData.sendLock) {
      return false;
    }

    const content = this.data.comment_input;

    // 空的就不用发了
    if (!content || content.length == 0) {
      return false;
    }

    this.jsData.sendLock = true;
    // 订阅审核通知
    await requestNotice('verify');
    wx.showLoading({
      title: '发送中...',
    });
    // 实际发送
    this.doSendComment();
    this.doSendCommentEnd();
  },

  async doSendComment() {
    const content = this.data.comment_input;

    // 判断是否可以发
    const user = this.data.user || {};
    if (user.cantComment) {
      wx.showModal({
        title: "发送失败",
        content: config.text.comment_board.ban_tip,
        showCancel: false,
      })
      return false;
    }

    // openid 兜底：本地 fake_openid，一设备一 id
    const user_openid = user.openid || (await getCurrentUserOpenid());

    // 插入便利贴
    const { paper_colors, paper_color_select } = this.data;
    var item = {
      content: content,
      user_openid: user_openid,
      cat_id: this.jsData.cat_id,
      paper_color: paper_colors[paper_color_select],
      needVerify: true,
    };

    const checkRes = await api.contentSafeCheck(content, this.data.nickname || '匿名猫友');
    if (!checkRes) {
      // 没有检测出问题
      // 记住本机上次填的昵称（换设备自然丢失），空值不覆盖
      if (this.data.nickname) {
        saveNickname(this.data.nickname);
      }
      await this.addComment(item, user);
      return
    }

    wx.showModal(checkRes);
    return false;
  },

  doSendCommentEnd() {
    wx.hideLoading();
    this.jsData.sendLock = false;
  },

  async addComment(item, user) {
    try {
      var res = await api.curdOp({
        operation: "add",
        collection: "comment",
        data: item
      });

      // 插入最新便利贴 + 清空输入框
      item.userInfo = { nickName: this.data.nickname || '匿名猫友' };
      item.datetime = formatDate(new Date(), "yyyy-MM-dd hh:mm:ss")
      var comments = this.data.comments;
      comments.unshift(item);

      // 获取总数
      var comment_count = await getCatCommentCount(item.cat_id, {
        nocache: true
      });
      this.setData({
        comment_input: "",
        comments: comments,
        comment_count: comment_count,
      });

      // 同步到 COS inbox，由 Action 聚合进审核队列（字段约定见 process-inbox handleComment）
      // 注意：提交后不是立刻生效，要等 Actions 聚合 + 人工审核，提示里说明清楚
      const ok = await putInbox('comment', {
        cat_id: item.cat_id,
        content: item.content,
        nickname: this.data.nickname || '匿名猫友',
      });

      if (ok) {
        markPending("comment", { cat_id: item.cat_id, label: "便利贴" });
        wx.showToast({
          title: config.text.sync.received_tip,
          icon: 'none',
          duration: 2000,
        });
      } else {
        wx.showToast({
          title: this.data.text_cfg.sync.offline_tip,
          icon: 'none',
          duration: 2500,
        });
      }
    } catch {
      wx.showModal({
        title: "张贴失败",
        showCancel: false,
      })
      console.error(res);
    }
  },

  // 加载更多便利贴
  // TODO(zing): 支持排序方式修改
  async loadMoreComment() {
    // 常用的对象
    var { comments, loadNoMore } = this.data;

    if (loadNoMore) {
      return;
    }

    var qf = {
      deleted: { $ne: true },
      cat_id: this.jsData.cat_id
    };
    var res = (await app.mpServerless.db.collection('comment').find(qf, { skip: comments.length, sort: { create_date: -1 }, limit: 10 })).result;
    if (res.length === 0) {
      this.setData({
        loadNoMore: true
      });
      return;
    }

    // 填充userInfo
    await fillUserInfo(res, "user_openid", "userInfo");
    for (var item of res) {
      item.datetime = formatDate(new Date(item.create_date), "yyyy-MM-dd hh:mm:ss")
      // 便签旋转
      item.rotate = randomInt(-5, 5);
      // 贴纸位置
      item.tape_pos_left = randomInt(20, 520);
      item.tape_rotate = randomInt(-50, +50);
      comments.push(item);
    }

    this.setData({ comments });

  },

  async deleteComment(e) {
    const index = e.detail.index;
    const item = e.detail.item;
    const comment_id = item._id;
    const username = item.userInfo?.nickName;
    // 弹窗提示一下
    var res = await wx.showModal({
      title: '提示',
      content: `确定删除\"${username}\"的便利贴？`
    });

    if (!res.confirm) {
      return false;
    }

    // 走 inbox 聚合软删（作者删自己的评论），不依赖本地覆盖层假写。
    // putInbox 永远不 reject，失败只是这次同步丢了，UI 不走崩。
    const ok = await putInbox('deleteComment', { comment_id });

    // 乐观更新：无论聚合是否成功，先移除本地该项（聚合后服务端软删，重进会消失）。
    var comments = this.data.comments;
    comments.splice(index, 1);
    this.setData({
      comments: comments,
      comment_count: Math.max(0, this.data.comment_count - 1),
    });

    if (ok) {
      markPending("comment", { cat_id: item.cat_id, label: "便利贴" });
      wx.showToast({
        title: config.text.sync.received_tip,
        icon: 'none',
        duration: 2000,
      });
    } else {
      // 防御：失败不要崩，给个轻提示（markPending 已吞异常，这里也不抛）。
      wx.showToast({
        title: config.text.sync.offline_tip,
        icon: 'none',
        duration: 2500,
      });
    }
  },

  async ifSendNotifyVeriftMsg() {
    const subMsgSetting = (await app.mpServerless.db.collection('setting').findOne({ _id: 'subscribeMsg' })).result;
    const triggerNum = subMsgSetting.verifyPhoto.triggerNum;  //几条未审核才触发
    // console.log("triggerN",triggerNum);
    var numUnchkPhotos = (await app.mpServerless.db.collection('comment').count({
      needVerify: true
    })).result;

    if (numUnchkPhotos >= triggerNum) {
      await sendNotifyVertifyNotice(numUnchkPhotos);
    }
  },

  selectPaperColor(e) {
    const { index } = e.currentTarget.dataset;
    this.setData({
      paper_color_select: index
    });
  }
})