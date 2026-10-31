/**
 * comment-list 评论（便利贴）列表项组件（v4.0.3）
 * 属性：
 *  - comment:   单条便利贴数据（见 types/domain.ts 的 Comment）
 *  - index:     在列表中的序号（删除时回传）
 *  - canDelete: 是否显示删除按钮（管理员或作者）
 * 事件：
 *  - bind:delete  -> { index, item }  点击删除时触发，由页面执行实际删除
 */
import { Comment } from '../../types/domain';

Component({
  properties: {
    comment: {
      type: Object,
      value: {} as Comment,
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
    onDelete(): void {
      this.triggerEvent('delete', {
        index: this.data.index,
        item: this.data.comment,
      });
    },
  },
});
