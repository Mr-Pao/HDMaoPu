/**
 * star-rating 评分星组件（v4.0.3）
 * 属性：
 *  - value: number   当前分值（支持小数，按向下取整点亮）
 *  - max:   number   星星总数，默认 5
 *  - readonly: boolean 是否只读（仅展示用途），默认 true
 */
interface IData {
  stars: Array<{ filled: boolean }>;
}

Component({
  properties: {
    value: {
      type: Number,
      value: 0,
    },
    max: {
      type: Number,
      value: 5,
    },
    readonly: {
      type: Boolean,
      value: true,
    },
  },

  data: {
    stars: [] as Array<{ filled: boolean }>,
  },

  observers: {
    'value,max': function (value: number, max: number): void {
      const v = typeof value === 'number' ? value : 0;
      const m = typeof max === 'number' && max > 0 ? max : 5;
      const list: Array<{ filled: boolean }> = [];
      for (let i = 0; i < m; i++) {
        list.push({ filled: i + 1 <= v });
      }
      this.setData({ stars: list });
    },
  },
});
