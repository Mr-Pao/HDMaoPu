// 猫猫管理（v4.0.65 起是**唯一**的猫资料入口）
//
// 历史：以前「关于 → 管理后台」里同时有「猫资料编辑」(admin?tab=cat) 和「猫猫管理」两个入口，
// 改的是同一批 cat 字段，前者是简版表单、后者是全功能版。v4.0.65 删掉了简版，
// 照片的下架/精选/转移也一并收进本页的照片卡（原来在 admin?tab=photo）。
//
// 本页只做三件事，全部是真实写入（putInbox → COS inbox/manage/ → Actions 聚合）：
//   1. 搜猫 → 选中
//   2. <cat-info-tab> 改资料（updateCat，白名单 19 字段）
//   3. <relation-tab> 改猫际关系（updateCat，patch.relations）
//
// ⚠️ 聚合端没有新建猫的 action，所以本页不提供「新建猫」入口（点了也落不了库）。

import { checkAuth } from "../../../utils/user";
import { getAvatar, getCatItem } from "../../../utils/cat";
import config from "../../../config";

const app = getApp();

Page({
  data: {
    auth: false,
    activeTab: 'info', // info | relation，默认进资料编辑
    selectedCat: null, // 当前选中的猫咪
    showSearchResults: false, // 是否显示搜索结果
    searchKeyword: '', // 搜索关键词
    searchResults: [], // 搜索结果列表

    text_cfg: config.text, // 文本配置
  },

  async onLoad(options) {
    if (!(await checkAuth(this, 2))) return;

    this.setData({ auth: true });

    // 加载对应猫
    if (options.cat_id) {
      this.getCatById(options.cat_id);
    }

    // 切换到对应选项卡（checkFeedbacks 长按猫名会带 activeTab=info 进来）
    if (options.activeTab === 'info' || options.activeTab === 'relation') {
      this.setData({ activeTab: options.activeTab });
    }
  },

  // 切换选项卡
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ activeTab: tab });

    if (tab === 'info' && this.data.selectedCat) {
      // cat-info-tab 在 info tab 才渲染，等一帧再取组件实例
      setTimeout(() => {
        const catInfoTab = this.selectComponent('#catInfoTab');
        if (catInfoTab) catInfoTab.loadCatData(this.data.selectedCat);
      }, 300);
    }

    // 没选猫时提示先搜猫 —— 以前这里会弹「是否添加新猫」，但聚合端没有新建猫的 action
    if (tab === 'info' && !this.data.selectedCat) {
      wx.showToast({ title: '先搜索并选择一只猫猫', icon: 'none', duration: 2000 });
    }
  },

  onSearchInput(e) {
    this.setData({ searchKeyword: e.detail.value });
    if (!e.detail.value.trim()) {
      this.setData({ showSearchResults: false });
    }
  },

  async searchCat() {
    const keyword = this.data.searchKeyword.trim();
    if (!keyword) return;

    try {
      wx.showLoading({ title: '搜索中...' });
      const { result } = await app.mpServerless.db.collection('cat').find({
        $or: [
          { name: { $regex: keyword } },
          { nickname: { $regex: keyword } },
        ]
      }, { limit: 10 });

      const cats = [];
      for (const cat of result) {
        cat.avatar = await getAvatar(cat._id, cat.photo_count_best);
        cats.push(cat);
      }

      this.setData({ searchResults: cats, showSearchResults: true });
      wx.hideLoading();
    } catch (error) {
      console.error("搜索猫咪失败:", error);
      wx.hideLoading();
      wx.showToast({ title: '搜索失败', icon: 'none' });
    }
  },

  selectCat(e) {
    const catId = e.currentTarget.dataset.id;
    this.getCatById(catId);
    this.setData({ showSearchResults: false, searchKeyword: '' });
  },

  onShow() {
    // 如果有选中的猫咪，刷新数据（保存后返回这里要看到最新值）
    if (this.data.selectedCat) {
      this.getCatById(this.data.selectedCat._id);
    }
  },

  async getCatById(catId) {
    if (!catId) return;

    try {
      wx.showLoading({ title: '加载中...' });

      const cat = await getCatItem(catId);
      cat.avatar = await getAvatar(cat._id, cat.photo_count_best);

      this.setData({ selectedCat: cat });

      // 确保 catInfoTab 加载最新的猫咪信息
      setTimeout(() => {
        const catInfoTab = this.selectComponent('#catInfoTab');
        if (catInfoTab && this.data.activeTab === 'info') {
          try {
            catInfoTab.setData({ selectedCat: cat });
            catInfoTab.loadCat(catId);
          } catch (error) {
            console.error('调用catInfoTab.loadCat出错:', error);
          }
        }
      }, 300);
      wx.hideLoading();
    } catch (error) {
      console.error("加载猫咪信息失败:", error);
      wx.hideLoading();
      wx.showToast({ title: '加载猫咪信息失败', icon: 'none' });
    }
  },

  // 跳转到猫猫主页
  navigateToCat(e) {
    const cat = e.currentTarget.dataset.cat;
    wx.navigateTo({
      url: `/pages/genealogy/detailCat/detailCat?cat_id=${cat._id}`
    });
  },

  // 关系选项卡：添加一条关系
  handleAddRecord() {
    if (!this.data.selectedCat) return;
    const relationTab = this.selectComponent('#relationTab');
    if (relationTab) relationTab.addRelation();
  },

  // 保存猫咪信息（保存成功由 cat-info-tab 的 backAfterSubmit 收尾并返回上一页）
  handleSaveCat() {
    const infoTab = this.selectComponent('#catInfoTab');
    if (infoTab) infoTab.saveCat();
  },

  // 更新信息
  onCatUpdated(e) {
    const catId = e.detail && e.detail.catId;
    if (catId && this.data.selectedCat) {
      this.getCatById(catId);
    }
  },

  // 右下角浮动按钮：按当前 tab 决定是「加关系」还是「保存资料」
  handleActionButtonClick() {
    const { activeTab, selectedCat } = this.data;
    if (!selectedCat) {
      wx.showToast({ title: '先搜索并选择一只猫猫', icon: 'none' });
      return;
    }
    if (activeTab === 'relation') {
      this.handleAddRecord();
    } else {
      this.handleSaveCat();
    }
  },
})
