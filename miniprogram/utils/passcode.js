// 管理口令工具（管理后台 / 审核队列共用）
//
// 口诀：
//   - 口令绝不写进小程序包，也不进 config.js。
//   - 用户在小程序里输一次，只存手机本地 storage（key: manage_passcode），永久有效。
//   - 客户端不做对错校验，真校验在 GitHub Actions 端 scripts/process-inbox.js 的 tokenOk()，
//     它读的是 data/gate.json 的 code——和小程序解锁用的是同一个值，全站只有这一处口令。
//     口令不对的提交会被 drop:bad-token 直接丢弃，页面不会报错。
//   - 所以两个管理页在提交前都要检查本地是否已有口令，没有就引导用户先设置。

const KEY = "manage_passcode";

// 本机「已解锁管理后台」标记。关于页连击 5 次 + 口令正确后写入，
// 全站所有管理入口（菜单显隐、公告删改、审核页等）都以它为唯一判据。
const UNLOCK_KEY = "admin_unlocked";

function isUnlocked() {
  try {
    return !!wx.getStorageSync(UNLOCK_KEY);
  } catch (e) {
    console.warn("[passcode] 读取解锁标记失败", e);
    return false;
  }
}

function setUnlocked(v) {
  try {
    if (v) {
      wx.setStorageSync(UNLOCK_KEY, 1);
    } else {
      wx.removeStorageSync(UNLOCK_KEY);
    }
  } catch (e) {
    console.warn("[passcode] 保存解锁标记失败", e);
  }
}

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
// 优先用自绘弹层 <passcode-modal>（原生 input，键盘右下角「完成」= 确认，不是换行）；
// 页面没放弹层时才退回 wx.showModal —— 那个在手机上回车只会换行。
// 注意：editable: true 时不能传 content（传了会变成弹窗说明文字，且输入框无法预填）
function promptToken(options) {
  const opts = options || {};
  const cb = typeof opts.onSaved === "function" ? opts.onSaved : null;
  const done = () => {
    typeof cb === "function" && cb();
  };

  let modal = null;
  try {
    modal = require("./passcodeModal");
  } catch (e) {
    modal = null;
  }

  if (modal && modal.hasModal()) {
    modal
      .open({
        title: opts.title || "管理口令",
        tip: opts.tip || "",
        placeholder: opts.placeholder || "输入管理口令",
        confirmText: opts.confirmText || "保存",
        password: !!opts.password,
        validate: opts.validate,
        onSaved: value => {
          setToken(value);
          done();
        },
      })
      .catch(() => legacyPrompt(done));
    return;
  }

  legacyPrompt(done);
}

// 老路径：wx.showModal({editable:true})，回车只会换行，只能点按钮
function legacyPrompt(done) {
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
  isUnlocked,
  setUnlocked,
};
