import {
  getUser
} from "../../../utils/user";
import {
  getCurrentUserOpenid
} from "../../../utils/common";
import { putInbox } from "../../../utils/writeback";
import { getNickname, saveNickname } from "../../../utils/nickname";
import { text as text_cfg } from "../../../config";
const passcode = require("../../../utils/passcode");
const app = getApp();
Page({

  /**
   * 页面的初始数据
   */
  data: {
    news_id: 0,
    news: 0,
    // 本页只在管理后台「猫抓板公告」里进入，口令门已在上一页把过，这里不再重复判权限
    auth: true,
    user: {},
    nickname: '',
    namelength: 0,
    namemaxlength: 30,
    titlelength: 0,
    titlemaxlength: 30,
    length: 0,
    maxlength: 800,
    photos_path: [],
    buttons: [{
      id: 0,
      name: '领养',
      checked: false,
    }, {
      id: 1,
      name: '救助',
      checked: false,
    }, {
      id: 2,
      name: '活动',
      checked: false,
    }, {
      id: 3,
      name: '其他',
      checked: false,
    }],
    modalButtons: [{
      id: 0,
      name: '否',
      checked: true,
    }, {
      id: 1,
      name: '是',
      checked: false,
    }],
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    this.setData({
      news_id: options.news_id
    })
    // 权限由管理后台入口把关，本页不再调用 checkAuth
    await this.loadNews();
  },

  onShow: async function () {
    await this.loadUserInfo();
  },

  // 昵称改为选填：不拦提交，只用于展示与记录最后修改人
  // 每次就地填，本机记住上一次填的（utils/nickname 的 last_nickname），换设备自然丢失
  async loadUserInfo() {
    const user = (await getUser()) || {};
    this.setData({
      user: Object.assign({}, user, {
        userInfo: user.userInfo || {},
      }),
      nickname: getNickname(),
    });
  },

  async loadNews() {
    const that = this;
    const { result } = await app.mpServerless.db.collection('news').findOne({
      _id: this.data.news_id
    })
    for (var i = 0; i < that.data.buttons.length; i++) {
      if (that.data.buttons[i].name == result.class) {
        that.data.buttons[i].checked = true;
      }
    }
    var modalButtons = [{
      id: 0,
      name: '否',
      checked: true,
    }, {
      id: 1,
      name: '是',
      checked: false,
    }];
    if (result.setNewsModal == true) {
      modalButtons = [{
        id: 0,
        name: '否',
        checked: false,
      }, {
        id: 1,
        name: '是',
        checked: true,
      }];
    }
    that.setData({
      news: result,
      photos_path: result.photosPath,
      titlelength: result.title.length,
      length: result.mainContent.length,
      buttons: that.data.buttons,
      modalButtons: modalButtons,
    })
  },

  previewImg: function (event) {
    const that = this;
    wx.previewImage({
      current: that.data.photos_path[event.currentTarget.dataset.index],
      urls: that.data.photos_path
    })
  },

  previewCover: function (event) {
    wx.previewImage({
      urls: [event.currentTarget.dataset.url]
    })
  },

  bindInputName(e) {
    var inputData = e.detail.value;
    this.setData({
      namelength: inputData.length
    })
  },

  bindInputTitle(e) {
    var inputData = e.detail.value;
    this.setData({
      titlelength: inputData.length
    })
  },

  bindInput(e) {
    var inputData = e.detail.value;
    this.setData({
      length: inputData.length
    })
  },

  // 昵称输入（选填，不填就匿名）
  inputNickname(e) {
    this.setData({
      nickname: e.detail.value
    });
  },

  goBack() {
    wx.navigateBack();
  },

  radioButtonTap: function (e) {
    let id = e.currentTarget.dataset.id;
    for (let i = 0; i < this.data.buttons.length; i++) {
      if (this.data.buttons[i].id == id) {
        this.data.buttons[i].checked = true;
      } else {
        this.data.buttons[i].checked = false;
      }
    }
    this.setData({
      buttons: this.data.buttons
    })
  },

  radioModalButtonTap: function (e) {
    let id = e.currentTarget.dataset.id;
    var mb = this.data.modalButtons;
    for (let i = 0; i < mb.length; i++) {
      if (mb[i].id == id) {
        mb[i].checked = true;
      } else {
        mb[i].checked = false;
      }
    }
    this.setData({
      modalButtons: mb
    });
  },

  async bindSubmit(e) {
    var submitData = e.detail.value;
    if (!submitData.title) {
      wx.showToast({
        title: '标题不能为空',
        icon: 'none'
      })
      return;
    }

    var classBelongto = "";
    for (let i = 0; i < this.data.buttons.length; i++) {
      if (this.data.buttons[i].checked == true) {
        classBelongto = this.data.buttons[i].name;
      }
    }

    var setNewsModal = false;
    if (this.data.modalButtons[1].checked == true) {
      setNewsModal = true;
    }

    // 昵称取输入框的值，空则匿名；顺手记到本机（换设备自然丢失）
    if (this.data.nickname) {
      saveNickname(this.data.nickname);
    }
    var data = {
      openidLastModify: (this.data.user && this.data.user.openid) || (await getCurrentUserOpenid()),
      userNicknameLastModify: submitData.name || this.data.nickname || '匿名猫友',
      // 服务端 manageNews 会用服务端时间兜底，这里只是客户端展示值
      dateLastModify: new Date().toISOString(),
      title: submitData.title,
      mainContent: submitData.mainContent,
      class: classBelongto,
      setNewsModal: setNewsModal,
    }

    const resModal = await wx.showModal({
      content: '确认修改'
    })
    if (resModal.confirm) {
      await this.doModify(this.data.news_id, data)
    }
  },

  async doModify(item_id, item_data) {
    // 没有口令就别提交：服务端 tokenOk() 会直接 drop:bad-token，用户以为改成功了
    const token = this.getToken();
    if (!this.ensureToken(token)) return;

    // 写 inbox/manage/，由 process-inbox.yml 聚合成 data/news.json 再推 COS。
    // putInbox 永远不 reject，返回 false 只代表这次没传上去。
    const ok = await putInbox("manage", {
      action: "manageNews",
      op: "update",
      token: token,
      news_id: item_id,
      news: item_data
    });

    if (ok) {
      wx.showToast({
        title: text_cfg.sync.received_tip,
        icon: 'none',
        duration: 2000
      });
      setTimeout(wx.navigateBack, 1200);
    } else {
      wx.showToast({
        title: text_cfg.sync.offline_tip,
        icon: 'none',
        duration: 2500
      });
    }
  },

  // 取本机口令（utils/passcode.js，storage key manage_passcode）
  getToken() {
    return passcode.getToken();
  },

  // 没口令时引导设置，返回是否已经有口令可提交
  ensureToken(token) {
    if (token) return true;
    wx.showModal({
      title: '还没设置管理口令',
      content: '提交需要管理口令，否则后台会直接丢弃。现在设置吗？',
      confirmText: '去设置',
      success: res => {
        if (res.confirm) {
          passcode.promptToken({
            onSaved: () => {
              wx.showToast({ title: '口令已保存，请再点修改', icon: 'none', duration: 2500 });
            }
          });
        }
      }
    });
    return false;
  },
})