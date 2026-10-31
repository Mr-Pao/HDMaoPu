import { getCacheItem, setCacheItem, cacheTime } from "./cache";

function _commentCountKey(cat_id) {
  return `cat-comment-count-${cat_id}`;
}

// 获取单个猫的便利贴数量
async function getCatCommentCount(cat_id, options) {
  const cacheKey = _commentCountKey(cat_id);
  const cacheItem = getCacheItem(cacheKey, options);
  if (cacheItem !== undefined) {
    return cacheItem;
  }

  const count = await _doGetCatCommentCount(cat_id);
  setCacheItem(cacheKey, count, cacheTime.commentCount);
  return count;
}

// 批量获取多个猫的便利贴数量
async function getCatCommentCountMulti(cat_ids, options) {
  if (!cat_ids || cat_ids.length === 0) {
    return {};
  }

  const result = {};
  const needQuery = [];

  // 先从缓存获取
  for (const cat_id of cat_ids) {
    const cacheKey = _commentCountKey(cat_id);
    const cacheItem = getCacheItem(cacheKey, options);
    if (cacheItem !== undefined) {
      result[cat_id] = cacheItem;
    } else {
      needQuery.push(cat_id);
    }
  }

  // 并行查询数据库（使用 count 而不是 aggregate，更兼容）
  if (needQuery.length > 0) {
    const app = getApp();
    
    try {
      await Promise.all(needQuery.map(async cat_id => {
        const { result: count } = await app.mpServerless.db.collection('comment').count({ 
          cat_id: cat_id, 
          deleted: { $ne: true } 
        });
        result[cat_id] = count;
        const cacheKey = _commentCountKey(cat_id);
        setCacheItem(cacheKey, count, cacheTime.commentCount);
      }));
    } catch (error) {
      console.error("批量获取评论数失败:", error);
      // 失败时保持缓存中的结果
    }
  }

  return result;
}

async function _doGetCatCommentCount(cat_id) {
  const app = getApp();
  if (cat_id === undefined) {
    return 0;
  }
  const { result } = await app.mpServerless.db.collection('comment').count({ cat_id: cat_id, deleted: { $ne: true } });
  return result;
}

module.exports = {
  getCatCommentCount,
  getCatCommentCountMulti,
}