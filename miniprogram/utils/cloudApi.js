import config from "../config";
import { getCurrentUserOpenid } from "./common";
const app = getApp();

const requestCache = new Map();
const CACHE_TTL = 10000;

function getDate(date) {
  return date ? new Date(date) : new Date();
}

async function callUnionOp(action, options = {}, cacheKey = null) {
  if (cacheKey) {
    const cached = requestCache.get(cacheKey);
    if (cached && Date.now() < cached.expire) {
      return cached.data;
    }
  }

  const params = {
    unionAction: action,
    ...options
  };

  let result;
  for (let retry = 0; retry < 2; retry++) {
    try {
      const response = await app.mpServerless.function.invoke('unionOp', params);
      result = response.result;
      break;
    } catch (error) {
      if (retry === 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      } else {
        throw error;
      }
    }
  }

  if (cacheKey) {
    requestCache.set(cacheKey, {
      data: result,
      expire: Date.now() + CACHE_TTL
    });
  }

  return result;
}

async function curdOp(options) {
  const openid = await getCurrentUserOpenid();
  return await callUnionOp('curdOp', {
    ...options,
    openid: openid,
  });
}

async function userOp(options) {
  var openid
  const res = await app.mpServerless.user.getInfo({
    authProvider: 'wechat_openapi'
  });
  if (res.success) {
    openid = res.result.user.oAuthUserId;
  } else {
    return {};
  }
  return await callUnionOp('userOp', {
    ...options,
    openid: openid,
    op: options.op
  });
}

async function sendMsgV2(options) {
  return await callUnionOp('sendMsgV2', options);
}

async function getMpCode(options) {
  const params = {
    _id: options._id,
    scene: options.scene,
    page: options.page,
    width: 500,
    use_private_tencent_cos: config.use_private_tencent_cos
  }
  return await callUnionOp('getMpCode', params);
}

async function managePhoto(options) {
  const openid = await getCurrentUserOpenid();
  return await callUnionOp('managePhoto', {
    ...options,
    openid: openid
  });
}

async function getAllSci(options) {
  return await callUnionOp('getAllSci', options);
}

async function updateCat(options) {
  const openid = await getCurrentUserOpenid();
  return await callUnionOp('updateCat', {
    ...options,
    openid: openid
  });
}

async function contentSafeCheck(content, nickname) {
  const openid = await getCurrentUserOpenid();
  const label_type = {
    100: "正常",
    10001: "广告",
    20001: "时政",
    20002: "色情",
    20003: "辱骂",
    20006: "违法犯罪",
    20008: "欺诈",
    20012: "低俗",
    20013: "版权",
    21000: "其他",
  }
  var res = await callUnionOp('commentCheck', { openid: openid, content: content, nickname: nickname });
  console.log("contentSafeCheck", res);
  // cos 静态数据源下 commentCheck 是 no-op（data 为 null），直接放行，不能误判为检测失败
  if (!res || res.data === null || res.data === undefined) {
    return;
  }
  if (res.errCode != 0 && res.errcode != 0) {
    return {
      title: "内容检测未通过",
      content: `接口访问错误，错误码${res.errcode}`,
      showCancel: false,
    };
  }

  const label_code = res.result.label;
  const label = label_type[label_code];
  if (label_code != 100) {
    return {
      title: "内容检测未通过",
      content: `涉及[${label_code}]${label}内容，请修改嗷~~`,
      showCancel: false,
    };
  }
  return;
}

async function getUserStats(options) {
  const openid = await getCurrentUserOpenid();
  console.log("openid", openid);
  return await callUnionOp('getUserStats', {
    ...options,
    openid: openid
  });
}

async function updateCatRating(options) {
  return await callUnionOp('updateCatRating', options);
}

async function getCatStats(options) {
  return await callUnionOp('getCatStats', options);
}

async function updateFollowCats(options) {
  const openid = await getCurrentUserOpenid();
  return await callUnionOp('updateFollowCats', {
    ...options,
    openid: openid
  });
}

async function vaccineOp(options) {
  const openid = await getCurrentUserOpenid();
  return await callUnionOp('vaccineOp', {
    ...options,
    openid: openid
  });
}

// 新增：关系操作接口
async function catRelationOp(options) {
  const openid = await getCurrentUserOpenid();
  return await callUnionOp('catRelationOp', {
    ...options,
    openid: openid
  });
}

async function manageRelationRules(options) {
  const openid = await getCurrentUserOpenid();
  return await callUnionOp('manageRelationRules', {
    ...options,
    openid: openid
  });
}

// 领养申请：apply / listMine / cancel / list / review / addNote
// 后端实现在 utils/datasource.js 的 _adoptionOp（COS 静态源没有云函数，
// unionOp 由 datasource 在本地重放）。
async function adoptionOp(options) {
  const openid = await getCurrentUserOpenid();
  return await callUnionOp('adoptionOp', {
    ...options,
    openid: openid
  });
}

module.exports = {
  curdOp,
  userOp,
  sendMsgV2,
  getMpCode,
  managePhoto,
  getAllSci,
  contentSafeCheck,
  updateCat,
  getDate,
  getUserStats,
  updateCatRating,
  getCatStats,
  updateFollowCats,
  vaccineOp,
  // 新增接口
  catRelationOp,
  manageRelationRules,
  adoptionOp,
};