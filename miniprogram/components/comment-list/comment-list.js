/**
 * comment-list 评论（便利贴）列表项组件
 * properties: comment / index / canDelete
 * event: bind:delete -> { index, item }
 *
 * 说明：这个组件原来是 comment-list.ts，但工程 project.config.json 的
 * setting.useCompilerPlugins 是 false（没开 TS 编译插件），.ts 不会被编译成
 * .js，组件实际"不存在"，于是便利贴数字有、列表永远空白。这里补一份等价的
 * JS 实现（.js 优先级高于 .ts，devtools 会直接用这份）。
 */
Component({
  properties: {
    comment: {
      type: Object,
      value: {},
    },
    index: {
      type: Number,
      value: -1,
    },
    canDelete: {
      type: Boolean,
      value: false,
    },
  },

  data: {},

  methods: {
    onDelete: function () {
      this.triggerEvent('delete', {
        index: this.data.index,
        item: this.data.comment,
      });
    },
  },
});
