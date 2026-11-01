import { getGlobalSettings, getCurrentPath } from "../utils/page";
import { sleep } from "../utils/utils";
import { checkCanFullTabBar } from "../utils/user";
import tab from "./tab";

function getTabBarList() {
  var list = [];
  for (var key in tab) {
    list.push(tab[key]);
  }
  return list;
}

function isTabPath(path) {
  for (var key in tab) {
    if (tab[key]["pagePath"] === path) {
      return true;
    }
  }
  return false;
}

Component({
  data: {
    list: getTabBarList(),
    activePath: null
  },
  async created() {
    const currentPath = getCurrentPath();
    if (!currentPath) {
      await sleep(100);
    }
    const settings = await this.getSettings();
    if (settings == undefined) {
      if (isTabPath(currentPath)) {
        wx.showModal({
          title: 'TabBar错误001',
          content: `请重进小程序。当前页面：${currentPath}`,
          showCancel: false
        });
        return;
      }
      
      this.setData({
        list: tab,
        showTabBar: true,
      });
      return;
    }
    // 旧版「榜单」(leaderboard) 已下线，改为「图库」(gallery)。
    // 用户本地可能还缓存着旧 setting（pageSetting 缓存 7 天），
    // 这里做别名映射，无论缓存新旧都能正确显示图库 tab。
    const alias = { leaderboard: 'gallery' };
    const normalize = k => { const t = (k || '').trim(); return alias[t] || t; };
    let fullTab = settings.fullTab.split(',').map(normalize);
    const ctrlTab = new Map(settings.ctrlTab.split(',').map(i => [normalize(i), true]));
    var minTab = fullTab.filter(x => ctrlTab.get(x) === undefined);
    // 根据用户类型来确定底Tab
    var order = minTab;
    if (await checkCanFullTabBar() || !order) {
      order = fullTab;
    }

    if (!order && isTabPath(currentPath)) {
      wx.showModal({
        title: 'TabBar错误002',
        content: `请重进小程序。当前页面：${currentPath}`,
        showCancel: false
      });
      return;
    }

    // 下线 tab 兜底：v4.0.23 起去掉「喵友圈」(followFeed)，旧缓存里的
    // fullTab 仍含它、顺序也过期。只要 setting 里出现已下线/从未上线的 key，
    // 就丢弃它的顺序，改按 tab.js 的权威顺序重排（权限过滤照旧生效）。
    const RETIRED_TAB_KEYS = ['followFeed', 'recognize', 'leaderboard', 'map'];
    const staleOrder = fullTab.some(k => RETIRED_TAB_KEYS.indexOf(k) !== -1);
    if (staleOrder) {
      const authoritative = Object.keys(tab);
      fullTab = authoritative;
      order = (await checkCanFullTabBar()) ? authoritative : authoritative.filter(x => ctrlTab.get(x) === undefined);
    }

    // 存起来其他地方可以查看
    wx.setStorageSync('tabBarOrder', order)
    
    // 重新排序list
    var newList = [];
    for (const key of order) {
      const item = tab[key.trim()];
      if (!item) {
        continue;
      }
      newList.push(item);
    }
    this.setData({
      list: newList,
      showTabBar: true,
    });
  },
  attached() {
    var obj = this.createSelectorQuery();
    obj.select('.tab-bar').boundingClientRect(function (rect) {
      wx.setStorageSync('tabBarHeight', rect.height)     // 将获取到的高度设置缓存，以便之后使用
    }).exec();
  },
  methods: {
    switchTab(e) {
      const {path} = e.currentTarget.dataset;
      if (path == this.data.activePath) {
        return;
      }

      const url = `/${path}`;
      wx.switchTab({url});
    },
    
    // 带有重试机制的读取设置
    async getSettings() {
      let maxTry = 3;
      let res = undefined;
      while (res === undefined && maxTry > 0) {
        res = await getGlobalSettings("tabBarCtrl");
        maxTry --;
        await sleep(300);
      }
      return res;
    },
  }
})