const memoryCache = new Map();
const MEMORY_TTL = 60000;

function getCacheItem(key, options) {
  options = options || {};
  if (options.nocache) {
    return undefined;
  }

  const memoryData = memoryCache.get(key);
  if (memoryData && Date.now() < memoryData.expire) {
    return memoryData.item;
  }

  const data = wx.getStorageSync(key);
  if (!data) {
    return undefined;
  }

  if (new Date() > new Date(data.expire_date)) {
    wx.removeStorageSync(key);
    return undefined;
  }

  memoryCache.set(key, {
    item: data.item,
    expire: Date.now() + MEMORY_TTL
  });

  return data.item;
}

function setCacheItem(key, item, expire_hours, expire_minutes) {
  const expireDate = new Date();
  const expireMinutes = (expire_minutes || 0) + parseInt(expire_hours * 60);
  expireDate.setMinutes(expireDate.getMinutes() + expireMinutes);
  const data = {
    item: item,
    expire_date: expireDate
  };

  wx.setStorageSync(key, data);

  memoryCache.set(key, {
    item: item,
    expire: Date.now() + MEMORY_TTL
  });
}

function getCacheDate(key) {
  const date = wx.getStorageSync(key);
  if (!date) {
    return undefined;
  }
  return new Date(date);
}

function setCacheDate(key, date) {
  if (!date) {
    date = new Date();
  }
  wx.setStorageSync(key, date);
}

// 缓存时长设置（单位默认为hours）
// 注意：缓存图片链接会导致cos签名过期，应避免缓存已签名的URL
const cacheTime = {
  catAvatar: 0.1,              // 首页封面图 (6分钟)
  catItem: 0.1,                // 猫猫信息 (6分钟)
  commentCount: 0.08,          // 便利贴数量 (5分钟) - 之前为0，改为合理值避免频繁查询
  likeItem: 72,                // 点赞行为 (3天)
  pageSetting: 24 * 7,         // 页面设置 (7天)
  genealogyFCampus: 24 * 7 * 31, // 首页校区过滤选项 (31天)
  checkPhotoCampus: 24 * 7 * 31, // 最后一次审核照片的校区 (31天)
  genealogyNews: 12,           // 首页的news弹窗 (12小时内不重复弹)
}

module.exports = {
  getCacheDate,
  setCacheDate,
  getCacheItem,
  setCacheItem,
  cacheTime
}