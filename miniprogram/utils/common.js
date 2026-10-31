// 存放共享功能，避免循环引用
import { use_private_tencent_cos, sign_expires_tencent_cos } from "../config";
import COS from '../packages/tencentcloud/cos';
import { removeQueryParams, parseQueryParams, getDeltaHours } from './utils'
import { getCacheItem, setCacheItem } from "./cache";

// 获取当前用户的openid
async function getCurrentUserOpenid() {
  try {
    const app = getApp();
    console.log("App instance:", app);
    const res = await app.mpServerless.user.getInfo({
      authProvider: 'wechat_openapi'
    });
    if (res.success) {
      return res.result.user.oAuthUserId;
    }
    return null;
  } catch (error) {
    console.log("getCurrentUserOpenid error:", error);
    return null;
  }
}

async function downloadFile(filePath) {
  return new Promise(function (resolve, reject) {
    wx.downloadFile({
      url: filePath,
      success(res) {
        console.log('cloud.downloadFile success', res);
        resolve(res);
      },
      fail: res => reject(res)
    });
  });
}

async function uploadFile(options) {
  const app = getApp();

  const fileName = options.cloudPath;
  const filePath = options.filePath;

  if (!use_private_tencent_cos) {
    return await app.mpServerless.file.uploadFile({
      filePath: filePath, // 小程序临时文件路径
      cloudPath: fileName, // 上传至云端的路径
    })
  }

  const data = (await app.mpServerless.function.invoke('getURL', {
    fileName: fileName
  })).result

  const formData = data.formData;
  const postURL = data.postURL;
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: postURL,
      filePath: filePath,
      name: "file",
      formData: formData,
      success(res) {
        console.log('cloud.uploadFile success', res);
        // wx.uploadFile 和 wx.cloud.uplaodFile 返回值不一样
        // TODO 生成 fileID 按wxcloud生成的是图片的地址
        const cleanKey = formData.key.startsWith("/") ? formData.key.slice(1) : formData.key;
        res.fileUrl = postURL + cleanKey;
        res.fileId = '';
        console.log("res.fileID", res.fileUrl);
        resolve(res);
      },
      fail(err) {
        reject(err);
      }
    })
  });
};

// 初始化腾讯云 COS
async function ensureCos() {
  if (!use_private_tencent_cos) {
    return undefined;
  }

  var cos = new COS({
    SimpleUploadMethod: 'putObject',
    getAuthorization: async function (options, callback) {
      var cosTemp = wx.getStorageSync('cosTemp');
      const app = getApp();
      if (!cosTemp || (new Date() > new Date(cosTemp.Expiration))) {
        console.log("开始获取 cosTemp");
        cosTemp = (await app.mpServerless.function.invoke('getTempCOS')).result
        wx.setStorageSync('cosTemp', cosTemp);
      }
      if (!cosTemp || !cosTemp.Credentials) {
        callback({
          TmpSecretId: "empty",
          TmpSecretKey: "empty",
          SecurityToken: "empty",
          ExpiredTime: "3392838427",
        });
        return;
      }
      callback({
        TmpSecretId: cosTemp.Credentials.TmpSecretId,
        TmpSecretKey: cosTemp.Credentials.TmpSecretKey,
        SecurityToken: cosTemp.Credentials.Token,
        ExpiredTime: cosTemp.ExpiredTime,
      });
    }
  });
  return cos;
}

// COS加密
async function signCosUrl(inputUrl) {
  let url = inputUrl;
  // console.log("[signCosUrl]", url);
  const app = getApp();
  // 不是腾讯云COS的不加密
  if (!url || !url.includes("myqcloud.com") || !app.cos || !use_private_tencent_cos) {
    return url;
  }

  if (!_needResign(url)) {
    return url;
  }

  // 去除参数部分
  url = removeQueryParams(url);

  // 获取缓存
  let cacheKey = `cos-sign-${url}`;
  let cacheItem = getCacheItem(cacheKey);
  if (cacheItem) {
    return cacheItem;
  }

  // 实际签名
  let signedUrl = await _doCosSign(url);

  // 保存缓存，使用默认过期时间
  let expireHours = sign_expires_tencent_cos / 3600; // 默认过期时间（小时）
  setCacheItem(cacheKey, signedUrl, expireHours);

  return signedUrl;
}

// 检查是否需要重新签名
async function _needResign(url) {
  if (!url.includes("?")) {
    return true;
  }

  let params = parseQueryParams(url);
  let signTime = parseInt(params["q-sign-time"]);
  // 检查是否有签名，签名是否过期
  if (!signTime || getDeltaHours(signTime) * 3600 > sign_expires_tencent_cos) {
    return true;
  }

  return false;
}


// 实际签名操作
async function _doCosSign(url) {
  const app = getApp();
  const cosInfo = _getRegionBucketPath(url);
  return new Promise((resolve) => {
    app.cos.getObjectUrl({
      Bucket: cosInfo.bucket, /* 填入您自己的存储桶，必须字段 */
      Region: cosInfo.region, /* 存储桶所在地域，例如 ap-beijing，必须字段 */
      Key: cosInfo.filePath, /* 存储在桶里的对象键（例如1.jpg，a/b/test.txt），支持中文，必须字段 */
      Protocol: "https:",
      Expires: sign_expires_tencent_cos, // 单位秒
    }, function (err, data) {
      if (err) {
        console.error(err);
        resolve(url)
        return;
      }
      // console.log("[signCosUrl]", data.Url);
      resolve(data.Url);
    });
  });
}


/**
 * 将图片URL转换为WebP格式（如果支持的话）
 * @param {string} url - 原始图片URL
 * @returns {string} - WebP格式的图片URL
 */
function convertToWebP(url) {
  if (!url) return url;
  
  // 已经是webp格式，直接返回
  if (url.toLowerCase().endsWith('.webp')) {
    return url;
  }
  
  // 替换常见图片格式为webp
  const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp'];
  for (const ext of extensions) {
    if (url.toLowerCase().endsWith(ext)) {
      return url.slice(0, -ext.length) + '.webp';
    }
  }
  
  return url;
}

/**
 * 获取支持的图片格式URL（优先WebP）
 * @param {string} url - 原始图片URL
 * @param {boolean} [preferWebP=true] - 是否优先使用WebP
 * @returns {string} - 优化后的图片URL
 */
function getOptimizedImageUrl(url, preferWebP = true) {
  if (!url) return url;
  
  if (preferWebP) {
    return convertToWebP(url);
  }
  
  return url;
}

// 提取COS的region和bucket字段
function _getRegionBucketPath(url) {
  // 返回：{region: 'ap-guangzhou', bucket: 'bucket-name', filePath: "xxx/xxx.xxx"}
  const regex = /http[s]*:\/\//i;
  const newUrl = url.replace(regex, '');
  const items = _splitOnce(newUrl, '/');
  const firstItems = items[0].split('.');

  if (firstItems[0] !== 'cos') {
    // 例如：https://bucket-name.cos.ap-guangzhou.myqcloud.com/sample.png
    const bucket = firstItems[0].trim(); // 去除空白字符
    return { region: firstItems[2], bucket: bucket, filePath: items[1] };
  }

  // 例如：https://cos.ap-guangzhou.myqcloud.com/bucket-name/sample.png
  const path = _splitOnce(items[1], '/');
  const bucket = path[0].trim(); // 去除空白字符
  return { region: firstItems[1], bucket: bucket, filePath: path[1] };
}

function _splitOnce(str, sep) {
  const idx = str.indexOf(sep);
  return [str.slice(0, idx), str.slice(idx + 1)];
}

/**
 * 批量签名照片URL
 * @param {Object|Array} photos - 照片对象或照片数组
 * @param {string[]} [urlFields] - 需要签名的字段名数组，默认为 ['photo_id', 'photo_compressed', 'photo_watermark']
 * @returns {Promise<Object|Array>} - 签名后的照片对象或数组
 */
async function signPhotoUrls(photos, urlFields = ['photo_id', 'photo_compressed', 'photo_watermark']) {
  // 处理数组情况
  if (Array.isArray(photos)) {
    const signedPhotos = await Promise.all(
      photos.map(photo => _signSinglePhoto(photo, urlFields))
    );
    return signedPhotos;
  }
  
  // 处理单个对象情况
  return _signSinglePhoto(photos, urlFields);
}

/**
 * 签名单个照片对象的URL
 */
async function _signSinglePhoto(photo, urlFields) {
  if (!photo) return photo;
  
  const signedPhoto = { ...photo };
  for (const field of urlFields) {
    if (signedPhoto[field]) {
      signedPhoto[field] = await signCosUrl(signedPhoto[field]);
    }
  }
  return signedPhoto;
}

module.exports = {
  getCurrentUserOpenid,
  downloadFile,
  uploadFile,
  ensureCos,
  signCosUrl,
  signPhotoUrls,
  convertToWebP,
  getOptimizedImageUrl
}