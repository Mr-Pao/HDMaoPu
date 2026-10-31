// 放置与cat对象有关的函数
import { randomInt } from "./utils";
import { signCosUrl, signPhotoUrls } from "./common";
import { getCacheItem, setCacheItem, getCacheDate, setCacheDate, cacheTime } from "./cache";
const app = getApp();

// 获取猫猫的封面图
async function getAvatar(cat_id, total) {
  if (!total || total === 0) {
    return undefined;
  }

  const cacheKey = `cat-avatar-${cat_id}`;
  const cacheItem = getCacheItem(cacheKey);
  if (cacheItem) {
    return cacheItem;
  }

  // 先尝试获取精选照片
  let photo = await getBestPhoto(cat_id);
  
  // 如果没有精选照片，获取最新照片
  if (!photo) {
    photo = await getLatestPhoto(cat_id);
  }

  // 如果没有照片，返回 undefined
  if (!photo) {
    return undefined;
  }

  // 签名处理
  photo = await signPhotoUrls(photo);

  setCacheItem(cacheKey, photo, cacheTime.catAvatar);
  return photo;
}

// 辅助函数
async function getBestPhoto(cat_id) {
  try {
    const { result: photos } = await app.mpServerless.db.collection('photo').find({
      cat_id: cat_id,
      verified: true,
      best: true
    }, {
      sort: { mdate: -1 },
      limit: 1
    });
    
    return photos && photos.length > 0 ? photos[0] : null;
  } catch (error) {
    console.error("获取精选照片失败:", error);
    return null;
  }
}

async function getLatestPhoto(cat_id) {
  try {
    const { result: photos } = await app.mpServerless.db.collection('photo').find({
      cat_id: cat_id,
      verified: true
    }, {
      sort: { mdate: -1 },
      limit: 1
    });
    
    return photos && photos.length > 0 ? photos[0] : null;
  } catch (error) {
    console.error("获取最新照片失败:", error);
    return null;
  }
}

// 消除“有新相片”提示
function getVisitedDate(cat_id) {
  const key = "visit-cat-" + cat_id;
  return getCacheDate(key);
}
function setVisitedDate(cat_id) {
  const key = "visit-cat-" + cat_id;
  setCacheDate(key);
  return;
}

// 获取猫猫信息
async function getCatItem(cat_id, options) {
  if (!cat_id) {
    return undefined;
  }
  const cacheKey = `cat-item-${cat_id}`;
  let cacheItem = getCacheItem(cacheKey, options);
  if (cacheItem) {
    return cacheItem;
  }

  const { result } = await app.mpServerless.db.collection('cat').findOne({ _id: cat_id });
  cacheItem = result;
  setCacheItem(cacheKey, cacheItem, cacheTime.catItem);
  return cacheItem;
}

// 获取多个猫猫信息
async function getCatItemMulti(cat_ids, options) {
  if (!cat_ids || cat_ids.length === 0) {
    return [];
  }
  
  const res = {};
  const not_found = [];
  
  // 先从缓存获取
  for (const cat_id of cat_ids) {
    const cacheKey = `cat-item-${cat_id}`;
    const cacheItem = getCacheItem(cacheKey, options);
    if (cacheItem) {
      res[cat_id] = cacheItem;
    } else {
      not_found.push(cat_id);
    }
  }

  // 批量查询数据库中不存在缓存的记录
  if (not_found.length > 0) {
    const { result: db_res } = await app.mpServerless.db.collection('cat')
      .find({ _id: { $in: not_found } });
    
    for (const c of db_res) {
      const cacheKey = `cat-item-${c._id}`;
      setCacheItem(cacheKey, c, cacheTime.catItem);
      res[c._id] = c;
    }
  }
  
  return cat_ids.map(id => res[id]);
}

// 获取所有猫猫信息（用于构造关系图）
async function getAllCats(options) {
  const cacheKey = `cat-item-ALLCATS`;
  const cacheItem = getCacheItem(cacheKey, options);
  if (cacheItem) {
    return cacheItem;
  }

  const res = [];
  while (true) {
    const cats = (await app.mpServerless.db.collection('cat').find({}, { skip: res.length })).result;
    if (!cats || cats.length === 0) {
      break;
    }
    for (const item of cats) {
      res.push({
        _id: item._id,
        name: item.name,
        campus: item.campus,
        gender: item.gender,
        relations: item.relations
      });
    }
  }
  setCacheItem(cacheKey, res, cacheTime.catItem);
  return res;
}

export {
  getAvatar,
  getVisitedDate,
  setVisitedDate,
  getCatItem,
  getCatItemMulti,
  getAllCats
}