// 管理口令输入弹层
// 为什么不用 wx.showModal({editable:true})：那个输入框在手机上回车是「换行」而不是「确定」，
// 这里用原生 <input confirm-type="done" bindconfirm>，键盘右下角的「完成」直接确认。
const controller = require("../../utils/passcodeModal");

Component({
  properties: {
    password: { type: Boolean, value: false },
  },

  data: {
    visible: false,
    title: "管理口令",
    tip: "",
    placeholder: "输入管理口令",
    error: "",
    confirmText: "确定",
    cancelText: "取消",
    value: "",
  },

  lifetimes: {
    attached() {
      controller.register(this);
    },
    detached() {
      controller.unregister(this);
    },
  },

  methods: {
    // 供 controller 调用：返回 Promise<boolean>（true = 已确认并保存）
    open(options) {
      const o = options || {};
      this.__opts = o;
      return new Promise(resolve => {
        this.__resolve = resolve;
        this.setData({
          visible: true,
          title: o.title || "管理口令",
          tip: o.tip || "",
          placeholder: o.placeholder || "输入管理口令",
          error: "",
          confirmText: o.confirmText || "确定",
          cancelText: o.cancelText || "取消",
          value: o.value || "",
        });
      });
    },

    onInput(e) {
      this.setData({ value: (e && e.detail && e.detail.value) || "" });
    },

    async onConfirm(e) {
      const detail = (e && e.detail) || {};
      const value = String((detail.value != null ? detail.value : this.data.value) || "").trim();
      const opts = this.__opts || {};

      if (!value) {
        this.setData({ error: "口令不能为空" });
        return;
      }

      if (typeof opts.validate === "function") {
        let err = "";
        try {
          err = (await opts.validate(value)) || "";
        } catch (ex) {
          err = "校验失败，请重试";
        }
        if (err) {
          this.setData({ error: err });
          return;
        }
      }

      const onSaved = opts.onSaved;
      const resolve = this.__resolve;
      this.__opts = null;
      this.__resolve = null;
      this.setData({ visible: false, error: "", value: "" });

      if (typeof onSaved === "function") onSaved(value);
      if (resolve) resolve(true);
    },

    onCancel() {
      const opts = this.__opts || {};
      const resolve = this.__resolve;
      this.__opts = null;
      this.__resolve = null;
      this.setData({ visible: false, error: "", value: "" });

      if (typeof opts.onCancel === "function") opts.onCancel();
      if (resolve) resolve(false);
    },

    // 吃掉事件，避免点面板冒泡到遮罩被关掉
    noop() {},
  },
});
