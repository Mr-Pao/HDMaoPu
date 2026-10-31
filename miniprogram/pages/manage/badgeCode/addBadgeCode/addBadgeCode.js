import { checkAuth } from "../../../../utils/user";
import { levelOrderMap } from "../../../../utils/badge";
import api from "../../../../utils/cloudApi";
import { generateUUID } from "../../../../utils/utils";

Page({

  /**
   * 页面的初始数据
   */
  data: {
    input: {},
    allBadgeLevels: Object.keys(levelOrderMap),
  },

  /**
   * 生命周期函数--监听页面加载
   */
  async onLoad(event) {
    console.log(event);
    await checkAuth(this, 3);
  },

  _filterString(str) {
    const allowedChars = this.data.allBadgeLevels;
    const filteredChars = [];
  
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      if (allowedChars.includes(char)) {
        if (!filteredChars.includes(char)) {
          filteredChars.push(char);
        }
      }
    }
  
    return filteredChars.join("");
  },

  onChangeText(e) {
    const {field, dtype} = e.currentTarget.dataset;
    let value = e.detail.value;

    // 对徽章等级字段进行过滤
    if (field === 'levels') {
      value = this._filterString(value);
    }

    // 数字限制
    if (['badgeCount', 'genCount', 'validDays'].includes(field)) {
      value = value.replace(/[^\d\-+]/g, '');
    }

    if (dtype === "number") {
      value = value.length ? parseInt(value): "";
    }

    this.setData({
      [`input.${field}`]: value 
    });
    return value;
  },

  async clickSubmit() {
    console.log(this.data.input);
    // 有效性检查放到后端来检查
    const res = await api.genBadgeCode(this.data.input);

    // cos 静态数据源下 genBadgeCode 是 no-op（返回 {ok:true, data:null}），不能当生成成功
    if (res && res.ok === true && res.data === null) {
      wx.showModal({
        title: '提示',
        content: '此功能需服务端支持，暂未开放',
        showCancel: false,
      })
      return;
    }

    if (res.ok) {
      wx.showModal({
        title: '生成成功',
        content: '请返回兑换码管理，获取具体兑换码',
        showCancel: false,
      })
    } else {
      wx.showModal({
        title: '失败了',
        content: res.message,
        showCancel: false,
      })
    }
  }
})
