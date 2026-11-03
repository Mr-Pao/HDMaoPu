import { getCacheItem, setCacheItem, cacheTime } from "./cache";
import { isReviewSync } from "./review";
const app = getApp();

function _getSettingCacheKey(setting_id) {
  return `setting-${setting_id}-cache`;
}

async function _getSetting(_id, options) {
  const cacheKey = _getSettingCacheKey(_id);
  var nocache = false
  if (options && options.nocache) {
    nocache = true;
  }

  var cacheItem = getCacheItem(cacheKey, { nocache: nocache });
  if (cacheItem !== undefined) {
    return cacheItem;
  }
  const { result } = await app.mpServerless.db.collection('setting').findOne({ _id: _id });
  cacheItem = result

  // nocache 模式下不落盘：只借 datasource 自己的 10 分钟 SWR 缓存，
  // 避免 7 天的 storage 缓存把线上改动挡住
  if (!nocache) {
    setCacheItem(cacheKey, cacheItem, cacheTime.pageSetting);
  }
  return cacheItem;
}

// 加载位置/花色过滤器
// 不用 7 天的 storage 缓存：直接走 datasource 的 SWR 缓存（10 分钟），
// 这样改 data/setting.json 后最多 10 分钟就能在小程序端看到新选项
async function loadFilter(options) {
  const opts = options || {};
  if (!opts.nocache) opts.nocache = true;
  return await _getSetting('filter', opts);
}

// 获取全局的设置
async function getGlobalSettings(key, options) {
  const opts = options || {};
  if (!opts.nocache) opts.nocache = true;
  var res = await _getSetting('pages', opts);
  if (!res) {
    return undefined;
  }

  if (key == null) {
    return res;
  }
  return res[key];
}

// 获取当前页面路径
function getCurrentPath() {
  const pages = getCurrentPages();
  const currentPage = pages[pages.length - 1];
  return currentPage?.route;
}

// 切换自定义tab
function showTab(page) {
  if (typeof page.getTabBar != 'function' || !page.getTabBar()) {
    return;
  }
  const path = getCurrentPath();
  
  // 避免不必要的 setData 调用
  const tabBar = page.getTabBar();
  if (tabBar.data && tabBar.data.activePath !== path) {
    tabBar.setData({
      activePath: path,
    });
  }

  // 只有在 tabBarHeight 变化时才更新
  // 审核态整条 tabBar 不显示，底部占位也必须给 0，否则页面底部会空出一条
  var tabBarHeight = isReviewSync() ? 0 : (wx.getStorageSync('tabBarHeight') || 80);
  if (page.data && page.data.tabBarHeight !== tabBarHeight) {
    page.setData({
      tabBarHeight: tabBarHeight
    })
  }
}

// 跳转到设置页，并发起提示（页面配置页已下线，这里退化成一句提示，不再跳转）
function toSettings(tip) {
  wx.showToast({
    title: tip || "页面设置暂未开放",
    icon: "none",
    duration: 2500,
  });
}
module.exports = {
  loadFilter,
  getGlobalSettings,
  showTab,
  getCurrentPath,
  toSettings,
}