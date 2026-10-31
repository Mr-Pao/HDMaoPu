/**
 * genealogy-tree 谱系树组件（v4.0.3）
 *
 * 说明：微信小程序 WXML 不支持原生 <svg> 内联渲染，故采用 view 布局实现
 * 纵向谱系树（与项目内 relationGraph 的 view 节点思路一致）：当前猫居中，
 * 上方接父/母，下方接子代。
 *
 * 属性：
 *  - cat:     当前猫（Cat）
 *  - parents: 父/母数组（Cat，可携带 relation 标签，如「父亲」「母亲」）
 *  - children:子代数组（Cat，可携带 relation 标签，如「子女」）
 * 事件：
 *  - bind:tapnode -> { catId }  点击任一节点时触发
 */
import { Cat } from '../../types/domain';

const DEFAULT_AVATAR = '/pages/public/images/info/default_avatar.png';

interface IData {
  cover: string;
  hasData: boolean;
}

Component({
  properties: {
    cat: {
      type: Object,
      value: {} as Cat,
    },
    parents: {
      type: Array,
      value: [] as Cat[],
    },
    children: {
      type: Array,
      value: [] as Cat[],
    },
  },

  data: {
    cover: DEFAULT_AVATAR,
    hasData: false,
  },

  observers: {
    'cat,parents,children': function (
      cat: Cat,
      parents: Cat[],
      children: Cat[],
    ): void {
      const avatar = cat && cat.avatar;
      const cover = (avatar && (avatar.photo_compressed || avatar.photo_id)) || DEFAULT_AVATAR;
      const hasData = Array.isArray(parents) && parents.length > 0
        || Array.isArray(children) && children.length > 0;
      this.setData({ cover, hasData: !!hasData });
    },
  },

  methods: {
    onTapNode(e: WechatMiniprogram.TouchEvent): void {
      const id = e.currentTarget.dataset.id;
      if (id) {
        this.triggerEvent('tapnode', { catId: id });
      }
    },
  },
});
