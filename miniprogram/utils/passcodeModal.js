// 管理口令弹层（单例控制器）
//
// 为什么不用 wx.showModal({ editable: true })：
//   那个输入框在手机上按回车是「换行」，不是「确定」，用户只能去点按钮。
//   这里换成原生 <input confirm-type="done" bindconfirm>，
//   键盘右下角的「完成」= 直接确认。
//
// 用法：页面 wxml 末尾放一行 <passcode-modal />（页面 js 不用改），
//       然后照旧调用 passcode.promptToken({ onSaved })——
//       promptToken 会自动找到当前页面上那个弹层来打开。
//
// 组件在 attached 时入栈、detached 时出栈，open() 取栈顶（= 最近挂载、即当前页）。

const stack = [];

function register(component) {
  const i = stack.indexOf(component);
  if (i >= 0) stack.splice(i, 1);
  stack.push(component);
}

function unregister(component) {
  const i = stack.indexOf(component);
  if (i >= 0) stack.splice(i, 1);
}

function findCurrent() {
  for (let i = stack.length - 1; i >= 0; i--) {
    const c = stack[i];
    if (c && c.__alive !== false) return c;
  }
  return null;
}

function hasModal() {
  return !!findCurrent();
}

// 打开弹层。options: { title, tip, placeholder, confirmText, cancelText, password, value,
//                      validate(v) => '' | '错误文案', onSaved(v), onCancel() }
function open(options) {
  const comp = findCurrent();
  if (!comp) return Promise.reject(new Error("no-passcode-modal"));
  return comp.open(options || {});
}

module.exports = { open, register, unregister, hasModal };
