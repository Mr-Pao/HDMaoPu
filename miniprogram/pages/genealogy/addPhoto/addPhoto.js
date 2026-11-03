import {
  generateUUID,
  getCurrentPath,
  shareTo,
  compressImage
} from "../../../utils/utils";
import {
  checkCanUpload,
} from "../../../utils/user";
import { blockInReview } from "../../../utils/review";
import {
  requestNotice,
  sendNotifyVertifyNotice
} from "../../../utils/msg";
import config from "../../../config";
import { getCurrentUserOpenid } from "../../../utils/common";
import { putInbox } from "../../../utils/writeback";
import { markPending, submittedModal, backAfterSubmit } from "../../../utils/syncTip";
const app = getApp();
Page({
  /**
   * 页面的初始数据
   */
  data: {
    isAuth: false,
    user: {},
    uploading: false,
    birth_date: '2008-01-01',
    photos: [],
    set_all: {},
    canUpload: false,
    text_cfg: config.text,
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad: async function (options) {
    if (await blockInReview("照片上传暂未开放")) return;
    // v4.0 上传通道未开放，任何入口进来都直接退回
    if (!config.photo_upload_enabled) {
      wx.showToast({ title: '照片上传暂未开放', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }

    const cat_id = options.cat_id;
    // var catRes = await db.collection('cat').doc(cat_id).field({
    //   birthday: true,
    //   name: true,
    //   campus: true,
    //   _id: true
    // }).get();
    var catRes = (await app.mpServerless.db.collection('cat').findOne({ _id: cat_id }, { projection: { birthday: 1, name: 1, campus: 1 } })).result;
    this.setData({
      cat: catRes,
      birth_date: catRes.birthday || ''
    });
    //this.checkUInfo();

    // 获取一下现在的日期，用在拍摄日前选择上
    const today = new Date();
    var now_date = today.getFullYear() + '-' + (today.getMonth() + 1) + '-' + today.getDate();
    this.setData({
      now_date: now_date
    });

    this.setData({
      canUpload: await checkCanUpload()
    });

    // 获取一下手机平台
    const device = await wx.getSystemInfoSync();
    this.setData({
      isIOS: device.platform == 'ios'
    });
  },

  async onShow() {
    // 不管用户档案：摄影师字段由表单里的 input 自己填
  },

  onUnload: async function (options) {
    await this.ifSendNotifyVeriftMsg()
  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage: function () {
    const pagesStack = getCurrentPages();
    const path = getCurrentPath(pagesStack);
    const share_text = `来给${this.data.cat.name}添加照片 - ${config.text.app_name}`;
    return shareTo(share_text, path);
  },

  async chooseImg(e) {
    var res = await wx.chooseMedia({
      count: 20,
      mediaType: ['image'],
      sizeType: ["compressed"],
      sourceType: ['album', 'camera'],
    })
    var photos = [];
    for (var file of res.tempFiles) {
      // 需要压缩
      if (file.size > 512 * 1024) {
        file.path = await compressImage(file.tempFilePath, 30);
      } else {
        file.path = file.tempFilePath;
      }

      photos.push({
        file: file
      });
    }
    this.setData({
      photos: photos,
      set_all: {},
    });
  },

  // 点击单个上传
  async uploadSingleClick(e) {
    if (this.data.uploading) {
      return;
    }
    this.setData({
      uploading: true
    })
    await requestNotice('verify');
    wx.showLoading({
      title: config.text.add_photo.uploading_tip,
      mask: true,
    });
    const currentIndex = e.currentTarget.dataset.index;
    const photo = this.data.photos[currentIndex];
    const ok = await this.uploadImg(photo);
    this.data.photos = this.data.photos.filter((ph) => {
      // 把已上传的图片从图片列表中去掉
      return ph.file.path != photo.file.path;
    });
    this.setData({
      uploading: false,
      photos: this.data.photos,
    });
    wx.hideLoading();
    if (ok) {
      markPending("photo", { cat_id: (this.data.cat || {})._id, label: "照片" });
      // 列表里已经没有待传的照片了，就说明这一页填完了：提示 + 自动返回，
      // 免得用户停在空表单上再点一次上传（会重复提交同一张）。
      if (!this.data.photos.length) {
        backAfterSubmit(config.text.sync.received_tip, { delay: 1200 });
      } else {
        submittedModal(config.text.sync.received_tip);
      }
    } else {
      submittedModal(config.text.sync.offline_tip);
    }
  },

  // 点击多个上传
  async uploadAllClick(e) {
    if (this.data.uploading) {
      return;
    }
    const photos = []; // 这里只会保存可以上传的照片
    for (const item of this.data.photos) {
      if (item.shooting_date && item.file.path) {
        photos.push(item);
      }
    }
    if (photos.length == 0) {
      wx.showModal({
        title: config.text.add_photo.unfinished_tip_title,
        content: config.text.add_photo.unfinished_tip_content,
        showCancel: false
      });
      return;
    }
    await requestNotice('verify');
    let allOk = true;
    for (let i = 0; i < photos.length; ++i) {
      wx.showLoading({
        title: '正在上传(' + (photos.length - i) + ')',
        mask: true,
      });
      const ok = await this.uploadImg(photos[i]);
      if (!ok) {
        allOk = false;
      }
      this.data.photos = this.data.photos.filter((ph) => {
        // 把已上传的图片从图片列表中去掉
        return ph.file.path != photos[i].file.path;
      });
    }
    this.setData({
      uploading: false,
      photos: this.data.photos,
    })
    wx.hideLoading();
    if (allOk) {
      markPending("photo", { cat_id: (this.data.cat || {})._id, label: "照片" });
      // 批量传完就没剩下要传的了，提示后直接返回详情页，避免重复点「全部上传」
      if (!this.data.photos.length) {
        backAfterSubmit(config.text.sync.received_tip, { delay: 1200 });
      } else {
        submittedModal(config.text.sync.received_tip);
      }
    } else {
      submittedModal(config.text.sync.offline_tip);
    }
  },

  async ifSendNotifyVeriftMsg() {
    const subMsgSetting = (await app.mpServerless.db.collection('setting').findOne({ _id: 'subscribeMsg' })).result;
    const triggerNum = subMsgSetting.verifyPhoto.triggerNum; //几条未审核才触发
    // console.log("triggerN",triggerNum);
    var numUnchkPhotos = (await app.mpServerless.db.collection('photo').count({
      verified: false
    })).result;

    if (numUnchkPhotos >= triggerNum) {
      await sendNotifyVertifyNotice(numUnchkPhotos);
    }
  },

  async uploadImg(photo) {
    // multiple 表示当前是否在批量上传，如果是就不显示上传成功的弹框
    this.setData({
      uploading: true,
    });
    const cat = this.data.cat;
    const tempFilePath = photo.file.path;
    //获取后缀
    const index = tempFilePath.lastIndexOf(".");
    let ext = index >= 0 ? tempFilePath.substr(index + 1) : "jpg";
    ext = (ext || "jpg").toLowerCase();
    if (ext === "jpeg") ext = "jpg";

    // 匿名直传：照片二进制 PUT 到 COS pending/ 前缀（桶策略允许匿名写 pending/*，单对象 ≤512KB）
    const openid = (await getCurrentUserOpenid()) || "anon";
    const ts = Date.now();
    const key = `pending/${openid}-${ts}.${ext}`;
    const baseUrl = String(config.data_base_url || "").replace(/\/+$/, "");
    const objectUrl = `${baseUrl}/${key}`;

    // 读取本地文件为 ArrayBuffer（wx.request 的 PUT 需要二进制 body）
    const arrayBuffer = await new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({
        filePath: tempFilePath,
        success: (res) => resolve(res.data),
        fail: reject,
      });
    });

    await new Promise((resolve, reject) => {
      wx.request({
        url: objectUrl,
        method: "PUT",
        data: arrayBuffer,
        header: {
          "Content-Type": ext === "webp" ? "image/webp" : "image/jpeg",
        },
        success: (res) => {
          if (res && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res);
          } else {
            reject(new Error("PUT 返回 " + (res && res.statusCode)));
          }
        },
        fail: reject,
      });
    });

    // 写元数据到 inbox（小 JSON，不含照片二进制），由 Actions 聚合进审核队列
    const ok = await putInbox("photo", {
      photo_key: key,
      cat_id: cat._id,
      photographer: photo.pher || "",
      shooting_date: photo.shooting_date || "",
    });
    return !!ok;
  },

  pickDate(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({
      ["photos[" + index + "].shooting_date"]: e.detail.value
    });
  },
  inputPher(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({
      ["photos[" + index + "].pher"]: e.detail.value
    })
  },

  // 下面是统一设置
  setAllDate(e) {
    const value = e.detail.value;
    var photos = this.data.photos;
    for (var ph of photos) {
      ph.shooting_date = value;
    }
    this.setData({
      "set_all.shooting_date": value,
      photos: photos,
    });
  },
  setAllPher(e) {
    const photographer = e.detail.value;
    var photos = this.data.photos;
    for (var ph of photos) {
      ph.pher = photographer;
    }
    this.setData({
      "set_all.pher": photographer,
      photos: photos,
    });
  },

  // 移除其中一个
  removeOne(e) {
    const index = e.currentTarget.dataset.index;
    const photos = this.data.photos;
    const new_photos = photos.filter((ph, ind, arr) => {
      // 这个photo是用户点击的photo，在上面定义的
      return index != ind;
    });
    this.setData({
      photos: new_photos
    });
  },

  goBackIndex(e) {
    wx.switchTab({
      url: '/pages/genealogy/genealogy',
    });
  }
})