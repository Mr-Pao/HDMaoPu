// 存放共享功能，避免循环引用
import { use_private_tencent_cos, sign_expires_tencent_cos } from "../config";
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
// COS加密：cos 静态化模式下公开读，无需签名，直接返回原 URL
async function signCosUrl(inputUrl) {
  return inputUrl;
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
  signCosUrl,
  signPhotoUrls,
  convertToWebP,
  getOptimizedImageUrl
}