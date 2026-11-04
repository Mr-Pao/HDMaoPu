/**
 * star-rating 评分星组件（v4.0.3）
 * 属性：value / max / readonly
 *
 * 说明：原 star-rating.ts 在 useCompilerPlugins=false 的工程里不会被编译，
 * 组件等于不存在。这里补等价 JS 实现（.js 优先于 .ts）。
 */
Component({
  properties: {
    value: { type: Number, value: 0 },
    max: { type: Number, value: 5 },
    readonly: { type: Boolean, value: true },
  },

  data: {
    stars: [],
  },

  observers: {
    'value,max': function (value, max) {
      var v = typeof value === 'number' ? value : 0;
      var m = typeof max === 'number' && max > 0 ? max : 5;
      var list = [];
      for (var i = 0; i < m; i++) {
        list.push({ filled: i + 1 <= v });
      }
      this.setData({ stars: list });
    },
  },
});
