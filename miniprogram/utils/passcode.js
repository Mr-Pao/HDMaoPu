// 管理口令工具（管理后台 / 审核队列共用）
//
// 口诀：
//   - 口令绝不写进小程序包，也不进 config.js。
//   - 用户在小程序里输一次，只存手机本地 storage（key: manage_passcode），永久有效。
//   - 客户端不做对错校验，真校验在 GitHub Actions 端 scripts/process-inbox.js 的 tokenOk()
//     （对比 REVIEW_PASSCODE）；口令不对的提交会被 drop:bad-token 直接丢弃，页面不会报错。
//   - 所以两个管理页在提交前都要检查本地是否已有口令，没有就引导用户先设置。

const KEY = "manage_passcode";

// 读口令，没有就是空串；storage 异常也当没有
function getToken() {
  try {
    return String(wx.getStorageSync(KEY) || "");
  } catch (e) {
    console.warn("[passcode] 读取口令失败", e);
    return "";
  }
}

function hasToken() {
  return !!getToken();
}

// 存口令；传入空串视为清除
function setToken(v) {
  const val = String(v == null ? "" : v).trim();
  try {
    if (val) {
      wx.setStorageSync(KEY, val);
    } else {
      wx.removeStorageSync(KEY);
    }
  } catch (e) {
    console.warn("[passcode] 保存口令失败", e);
  }
}

// 弹输入框让用户输入口令
// 注意：editable: true 时不能传 content（传了会变成弹窗说明文字，且输入框无法预填）
function promptToken(options) {
  const opts = options || {};
  const cb = typeof opts.onSaved === "function" ? opts.onSaved : null;
  const done = () => {
    typeof cb === "function" && cb();
  };

  try {
    wx.showModal({
      editable: true,
      title: "管理口令",
      placeholderText: "输入管理口令（只存本机，不会打包进小程序）",
      confirmText: "保存",
      cancelText: "取消",
      success: res => {
        if (!res || !res.confirm) return;
        // 确认后：非空 = 保存；空串 = 清除口令。两种情况都回调
        setToken(res.content || "");
        done();
      },
      fail: err => {
        console.warn("[passcode] 口令弹窗失败", err);
      },
    });
  } catch (e) {
    console.warn("[passcode] 口令弹窗异常", e);
  }
}

module.exports = {
  getToken,
  hasToken,
  setToken,
  promptToken,
};
