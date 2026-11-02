import {
  text as text_cfg,
  cat_status_adopt
} from "../../../../config";
import {
  randomInt
} from "../../../../utils/utils";
import {
  loadFilter,
  getGlobalSettings
} from "../../../../utils/page";

import drawUtils from "../../../../utils/draw";

const share_text = text_cfg.app_name + ' - ' + text_cfg.recognize.share_tip;
const app = getApp();

// MeowID 开放平台的默认地址，配置里没写 apiBase 时用它兜底
const DEFAULT_API_BASE = 'https://platform.meowid.net';
// 一次识别最多展示几只候选
const MAX_DISPLAY = 5;
// 上传超时：MeowID 首次推理冷启动可能很慢，别设太短
const UPLOAD_TIMEOUT = 60 * 1000;

Page({

  /**
   * 页面的初始数据
   */
  data: {
    cameraAuth: false,
    devicePosition: 'back', // 前置/后置摄像头
    photoPath: null, // 用户选择的照片的路径
    photoBase64: null, // 用户选择的照片的base64编码，用于设置background-image
    campusList: ['所有位置'],
    campusIndex: 0,
    campusIndexOld: 0,
    lastFilterType: '',
    colourIndexOld: 0,
    colourList: ['所有花色'],
    colourIndex: 0,
    catList: [], // 展示的猫猫列表
    showResultBox: false, // 用来配合动画延时展示resultBox
    resultTitle: '', // 结果区标题（认出来 / 没认出来 / 没猫）
    showNoCatIcon: false, // 没检测到猫时显示提示图标
    showAdBox: true, // 展示banner广告
    ad: {},
    text_cfg: text_cfg,

    // 领养状态
    adopt_desc: cat_status_adopt,
  },

  jsData: {
    // MeowID 接口设置，onShow 中从数据库拉取。
    apiBase: null,
    projectId: null,
    apiKey: null,
    topK: 3,
    configLoaded: false,
    canvasSideLen: 720,
    // 最后一次接口返回的原始信息（用于区分「没检测到猫」和「没认出来」）
    lastSearch: null,
    // 接口返回的候选猫猫（已查过本地 cat 集合），展示的结果为在此基础上筛选。
    recognizeResults: [],
  },

  async onLoad() {
    var res = await loadFilter();
    this.setData({
      campusList: ['所有位置'].concat(res.campuses),
      colourList: ['所有花色'].concat(res.colour)
    })

    this.checkAuth();

    // 设置广告ID
    const ads = await getGlobalSettings('ads') || {};
    this.setData({
      ad: {
        banner: ads.recognize_banner
      },
    })
  },

  async onShow() {
    await this.loadRecognizeSettings();
    // 从聊天素材打开时自动识别（scene 1173）
    this.recognizeChatImage();
  },

  // 读取识猫接口配置（MeowID：apiBase / projectId / apiKey / topK）
  async loadRecognizeSettings() {
    // 真机（release）与开发者工具（develop）都读线上配置；
    // 只有体验版/审核版才回落 recognize_test（历史分组名，实际也常为空）
    const env = __wxConfig.envVersion === 'release' || __wxConfig.envVersion === 'develop' ? 'recognize' : 'recognize_test';
    const settings = await getGlobalSettings(env) || {};
    let apiBase = (settings.apiBase || DEFAULT_API_BASE).trim();
    if (apiBase && !/^https?:\/\//i.test(apiBase)) {
      apiBase = 'https://' + apiBase;
    }
    apiBase = apiBase.replace(/\/+$/, '');
    const topK = parseInt(settings.topK, 10);
    this.jsData.apiBase = apiBase;
    this.jsData.projectId = (settings.projectId || '').trim();
    this.jsData.apiKey = (settings.apiKey || '').trim();
    this.jsData.topK = isNaN(topK) || topK <= 0 ? 3 : Math.min(topK, 20);
    this.jsData.configLoaded = true;
  },

  hasRecognizeConfig() {
    return !!(this.jsData.projectId && this.jsData.apiKey);
  },

  recognizeChatImage() {
    var launchOptions = wx.getEnterOptionsSync();
    if (launchOptions.scene !== 1173) {
      return;
    }
    var materials = launchOptions.forwardMaterials;
    if (!materials || !materials.length || !materials[0].path) {
      return;
    }
    var chatImage = materials[0].path;
    if (this.data.photoPath === chatImage) {
      // 已经识别了
      return;
    }
    this.reset();
    //从聊天素材打开，识别素材图片
    this.setData({
      photoPath: chatImage,
      photoBase64: wx.getFileSystemManager().readFileSync(chatImage, 'base64')
    });
    this.recognizePhoto();
  },

  async checkAuth() {
    let setting = await wx.getSetting();
    this.setData({
      cameraAuth: setting.authSetting['scope.camera'] || false
    });
  },

  async reqCamAuth() {
    let setting = await wx.getSetting();
    if (setting.authSetting['scope.camera'] === false) {
      // 拒绝过授权，这时无法弹窗唤起授权，只能跳转到设置页面
      await wx.openSetting();
    } else {
      // 未申请过，唤起弹窗授权
      await wx.authorize({
        scope: 'scope.camera'
      });
    }
    this.checkAuth(); // 重新检查授权情况
  },

  takePhoto() {
    if (!this.data.cameraAuth) {
      return;
    }
    const that = this;
    const ctx = wx.createCameraContext();
    ctx.takePhoto({
      quality: 'high',
      success: (res) => {
        that.setData({
          photoPath: res.tempImagePath,
          photoBase64: wx.getFileSystemManager().readFileSync(res.tempImagePath, 'base64')
        });
        that.recognizePhoto();
      }
    });
  },

  toastTip(title, duration) {
    wx.showToast({
      icon: 'none',
      title: title,
      duration: duration || 2500,
      mask: true
    });
  },

  // 把 MeowID 的响应统一成候选数组。
  // 单猫时后端可能直接返回扁平对象（没有 candidates 包裹），这里一并兼容。
  extractCandidates(resp) {
    if (!resp) return [];
    if (Array.isArray(resp.candidates)) {
      return resp.candidates;
    }
    return [resp];
  },

  async recognizePhoto() {
    // 检查接口设置
    if (!this.jsData.configLoaded) {
      await this.loadRecognizeSettings();
    }
    if (!this.hasRecognizeConfig()) {
      this.toastTip(text_cfg.recognize.no_config_tip);
      return;
    }

    wx.showLoading({
      title: '翻阅猫谱中...',
      mask: true
    });

    let compressPhotoPath;
    try {
      compressPhotoPath = await this.compressPhoto();
    } catch (err) {
      wx.hideLoading();
      this.toastTip(text_cfg.recognize.network_tip);
      return;
    }

    const { apiBase, projectId, apiKey, topK } = this.jsData;
    const url = `${apiBase}/v1/projects/${encodeURIComponent(projectId)}/search?top_k=${topK}`;
    const that = this;

    wx.uploadFile({
      filePath: compressPhotoPath,
      name: 'image', // MeowID 的 multipart 字段名固定为 image
      url: url,
      header: {
        // MeowID 只认 Authorization: Bearer <api key>
        Authorization: 'Bearer ' + apiKey
      },
      timeout: UPLOAD_TIMEOUT,
      success(resp) {
        let body = null;
        try {
          body = JSON.parse(resp.data); // 这里也可能抛出异常
        } catch (err) {
          body = null;
        }
        if (resp.statusCode != 200) {
          wx.hideLoading();
          that.toastTip(that.describeError(resp.statusCode, body), 3500);
          wx.reportMonitor('recognizeCatPhotoError', 1);
          return;
        }
        if (!body) {
          wx.hideLoading();
          that.toastTip(text_cfg.recognize.network_tip);
          wx.reportMonitor('recognizeCatPhotoError', 1);
          return;
        }
        that.loadRecognizeResult(body);
      },
      fail(err) {
        wx.hideLoading();
        that.toastTip(text_cfg.recognize.network_tip);
        wx.reportMonitor('recognizeCatPhotoError', 1);
      }
    });
  },

  // 把接口错误翻译成人话
  describeError(statusCode, body) {
    const detail = body && body.detail;
    const code = (detail && detail.code) || (body && body.code) || '';
    if (code === 'project_mismatch') {
      return text_cfg.recognize.project_mismatch_tip;
    }
    if (code === 'invalid_api_key') {
      return text_cfg.recognize.key_invalid_tip;
    }
    if (code === 'AUTH_SESSION_EXPIRED') {
      return text_cfg.recognize.key_expired_tip;
    }
    if (detail && typeof detail === 'object' && detail.message) {
      return detail.message;
    }
    if (typeof detail === 'string' && detail) {
      return detail;
    }
    if (statusCode === 413) {
      return text_cfg.recognize.too_large_tip;
    }
    if (statusCode === 429) {
      return text_cfg.recognize.rate_limit_tip;
    }
    return text_cfg.recognize.network_tip;
  },

  async compressPhoto() {
    // 获取图像宽高信息
    const photoInfo = await wx.getImageInfo({
      src: this.data.photoPath,
    });
    // 使用canvas方法压缩图片
    const { canvasSideLen } = this.jsData;
    const drawRate = Math.max(photoInfo.width, photoInfo.height) / canvasSideLen; // 计算缩放比
    const drawWidth = Math.round(photoInfo.width / drawRate);
    const drawHeight = Math.round(photoInfo.height / drawRate);
    if (!this.jsData.ctx) {
      const { ctx, canvas } = await drawUtils.initCanvas('#canvasForCompress');
      this.jsData.ctx = ctx;
      this.jsData.canvas = canvas;
    }
    const { ctx, canvas } = this.jsData;
    await drawUtils.drawImage(ctx, canvas, photoInfo.path, 0, 0, drawWidth, drawHeight);

    const compressPhotoPath = await drawUtils.getTempPath(ctx, canvas, {
      width: drawWidth,
      height: drawHeight,
      destWidth: drawWidth,
      destHeight: drawHeight,
      fileType: 'jpg'
    });

    return compressPhotoPath;
  },

  async loadRecognizeResult(resp) {
    const candidates = this.extractCandidates(resp);
    const faceDetected = candidates.some(c => c && c.face_detected);
    this.jsData.lastSearch = {
      faceDetected: faceDetected,
      unknown: candidates.some(c => c && c.unknown),
    };

    // 拍平所有候选的 matches，按相似度从高到低排
    let matches = [];
    for (const candidate of candidates) {
      if (candidate && Array.isArray(candidate.matches)) {
        matches = matches.concat(candidate.matches);
      }
    }
    matches.sort((a, b) => (b.score || 0) - (a.score || 0));
    // 同一只猫只保留最高分那一条
    const seen = {};
    matches = matches.filter(m => {
      if (!m || !m.cat_id || seen[m.cat_id]) return false;
      seen[m.cat_id] = true;
      return true;
    });

    // 并行查本地猫谱，查不到的（本地没注册这只猫）直接丢掉
    const cats = await Promise.all(matches.map(m => this.getCatInfo(m)));
    this.jsData.recognizeResults = cats.filter(c => !!c);

    await this.applyFilterAndShow();
  },

  catFilter(res) {
    //点击筛选picker
    var type = res.currentTarget.dataset.type;
    // picker 返回的是字符串，统一转成数字，避免筛选与回滚时索引类型不一致
    var value = parseInt(res.detail.value, 10);
    if (isNaN(value) || value < 0) {
      value = this.data[type + 'Index'];
    }
    this.setData({
      [type + 'IndexOld']: this.data[type + 'Index'],
      lastFilterType: type,
      [type + 'Index']: value
    })
    this.applyFilterAndShow();
  },

  // 按位置/花色筛选，生成展示列表（不再做 softmax，直接用接口给的相似度）
  filterCatList() {
    const choseCampus = this.data.campusList[this.data.campusIndex];
    const choseColour = this.data.colourList[this.data.colourIndex];
    return this.jsData.recognizeResults.filter(cat => {
      const campusOk = choseCampus === '所有位置' || cat.campus === choseCampus;
      const colourOk = choseColour === '所有花色' || cat.colour === choseColour;
      return campusOk && colourOk;
    });
  },

  async applyFilterAndShow() {
    wx.showLoading({
      title: '筛选中...',
    });

    const filtered = this.filterCatList();
    const lastSearch = this.jsData.lastSearch || {};

    if (filtered.length === 0) {
      wx.hideLoading();
      // 筛选没结果时回滚选项；识别本身没结果是正常情况，不回滚
      if (this.jsData.recognizeResults.length > 0 && this.data.lastFilterType) {
        this.setData({
          [this.data.lastFilterType + 'Index']: this.data[this.data.lastFilterType + "IndexOld"]
        });
        this.toastTip('找不到这样的猫猫，试试换个选项吧', 2000);
        return false;
      }
      this.setData({
        catList: [],
        showNoCatIcon: !lastSearch.faceDetected,
        resultTitle: lastSearch.faceDetected
          ? text_cfg.recognize.unrecognized_tip
          : text_cfg.recognize.no_cat_tip,
        showResultBox: false,
      });
      // 结果区上移的动画留一点时间
      const that = this;
      setTimeout(() => {
        that.setData({ showResultBox: true });
      }, 300);
      return false;
    }

    const displayList = [];
    for (let index = 0; index < filtered.length && index < MAX_DISPLAY; index++) {
      const catInfo = filtered[index];
      catInfo.photo = await this.getCatPhoto(catInfo);
      displayList.push(catInfo);
    }

    wx.hideLoading();
    this.setData({
      catList: displayList,
      showNoCatIcon: false,
      resultTitle: displayList.length === 1
        ? text_cfg.recognize.single_cat_rec_tip
        : text_cfg.recognize.multi_cat_rec_tip,
      showResultBox: false,
    });

    // 在布局完成上移后展示resultBox
    const that = this;
    setTimeout(() => {
      that.setData({
        showResultBox: true,
      });
    }, 500);
    return true;
  },

  // MeowID 的 cat_id 是建档时服务端生成的，猫谱本地主键是 _id。
  // 优先用 data/cat.json 的 meowid_id（scripts/meowid-enroll.js 写入）对上，
  // 其次兼容「直接把 _id 当 cat_id 注册」，最后按猫名兜底（手工在控制台建的同名猫）。
  async getCatInfo(match) {
    const db = app.mpServerless.db.collection('cat');
    let catInfo = null;
    if (match.cat_id) {
      catInfo = (await db.findOne({ meowid_id: match.cat_id })).result;
      if (!catInfo) {
        catInfo = (await db.findOne({ _id: match.cat_id })).result;
      }
    }
    if (!catInfo && match.cat_name) {
      catInfo = (await db.findOne({ name: match.cat_name })).result;
    }
    if (!catInfo) {
      return null;
    }
    // 直接用接口返回的相似度（0-1），不再做 softmax
    catInfo.score = match.score;
    catInfo.support = match.support;
    return catInfo;
  },

  async getCatPhoto(catInfo) {
    // 优先从精选照片里随机挑一张
    const best = await this.queryOnePhoto({
      cat_id: catInfo._id,
      verified: true,
      best: true
    }, catInfo.photo_count_best);
    if (best) return best;
    // 没有精选图就退而求其次，随便拿一张过审的
    return await this.queryOnePhoto({
      cat_id: catInfo._id,
      verified: true
    }, catInfo.photo_count_total);
  },

  async queryOnePhoto(query, count) {
    const total = Math.max(1, parseInt(count, 10) || 1);
    const index = randomInt(0, total);
    const { result: photo } = await app.mpServerless.db.collection('photo').findOne(query, { skip: index });
    if (photo) return photo;
    // skip 越界（计数不准）时退回第一条
    const { result: fallback } = await app.mpServerless.db.collection('photo').findOne(query);
    return fallback || null;
  },

  async choosePhoto() {
    var res = await wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ["compressed"],
      sourceType: ['album'],
    })

    const filePath = res.tempFiles[0].tempFilePath;
    this.setData({
      photoPath: filePath,
      photoBase64: wx.getFileSystemManager().readFileSync(filePath, 'base64')
    });
    this.recognizePhoto();
  },

  reset() {
    this.jsData.recognizeResults = [];
    this.jsData.lastSearch = null;
    this.setData({
      photoPath: null,
      photoBase64: null,
      catList: [],
      showResultBox: false,
      resultTitle: '',
      showNoCatIcon: false,
      campusIndex: 0,
      colourIndex: 0
    });
  },

  reverseCamera() {
    if (!this.data.cameraAuth) {
      return;
    }
    if (this.data.devicePosition === 'front') {
      this.setData({
        devicePosition: 'back'
      });
    } else {
      this.setData({
        devicePosition: 'front'
      });
    }
  },

  savePhoto() {
    wx.saveImageToPhotosAlbum({
      filePath: this.data.photoPath,
      success() {
        wx.showToast({
          title: '保存成功',
          icon: 'success',
        });
      }
    })
  },

  tapCatCard(e) {
    const catId = e.currentTarget.dataset.catId;
    wx.navigateTo({
      url: '/pages/genealogy/detailCat/detailCat?cat_id=' + catId,
    });
  },

  tapPreview(e) {
    if (!this.data.photoPath) {
      return;
    }
    wx.previewImage({
      urls: [this.data.photoPath],
    });
  },

  onShareAppMessage() {
    return {
      title: share_text,
      imageUrl: '/pages/packageA/pages/images/recognize/share_cover.jpg'
    };
  },
  onShareTimeline: function () {
    return this.onShareAppMessage();
  },

  adLoad() {
    this.setData({
      showAdBox: true
    });
  },
  adError(err) {
    this.setData({
      showAdBox: false
    });
  },
  adClose() {
    this.setData({
      showAdBox: false
    });
  }

})
