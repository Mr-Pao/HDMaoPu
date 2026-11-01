// 昵称（就地填、不建用户档案）：每个提交场景当场填昵称，本机记住最后一次填的
// last_nickname，换设备 / 清缓存自然丢失；评分页（ratingDetail）故意不填昵称。
// 抽取自 commentBoard / feedbackDetail / modifyNews 三页重复的「读 last_nickname 预填 +
// 提交前写回」逻辑，行为与原内联代码一致。
const STORAGE_KEY = 'last_nickname';
const NICKNAME_MAX = 20;

// 读取上次填的昵称；没有就是空串。
// 不在此兜底匿名：调用处自行决定用 || '匿名猫友'，保持各页原有兜底语义不变。
function getNickname() {
  return wx.getStorageSync(STORAGE_KEY) || '';
}

// 记住这次填的昵称；空值不写（与原逻辑一致：仅在有值时回存）。
// name 会按 NICKNAME_MAX 截断，与输入框 maxlength=20 保持一致（正常输入已 <=20，截断为兜底）。
function saveNickname(name) {
  if (name) {
    wx.setStorageSync(STORAGE_KEY, String(name).slice(0, NICKNAME_MAX));
  }
}

module.exports = {
  getNickname,
  saveNickname,
  NICKNAME_MAX,
};
