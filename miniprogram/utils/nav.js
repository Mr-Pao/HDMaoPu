// 自绘导航：把全局状态栏 / 导航栏高度同步进当前页面的 data
// 说明：全局 app.json 未设 navigationStyle，只有自绘头部的页面单独设为 custom，
// 因此这些页面必须自己留出状态栏高度，否则内容会被刘海 / 灵动岛遮住。
function applyNav(page) {
  if (!page || !page.setData) {
    return;
  }
  let statusBarHeight = 20;
  let navBarHeight = 44;
  try {
    const app = getApp();
    const g = (app && app.globalData) || {};
    if (g.statusBarHeight != null) {
      statusBarHeight = g.statusBarHeight;
    }
    if (g.navBarHeight != null) {
      navBarHeight = g.navBarHeight;
    }
  } catch (e) {
    // getApp 尚未就绪时用兜底值
  }
  const data = page.data || {};
  if (data.statusBarHeight === statusBarHeight && data.navBarHeight === navBarHeight) {
    return;
  }
  page.setData({ statusBarHeight, navBarHeight });
}

module.exports = { applyNav };
