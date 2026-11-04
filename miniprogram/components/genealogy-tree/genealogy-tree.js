/**
 * genealogy-tree 谱系树组件（v4.0.3）
 * 属性：cat / parents / children
 * 事件：bind:tapnode -> { catId }
 *
 * 说明：原 genealogy-tree.ts 在 useCompilerPlugins=false 的工程里不会被编译，
 * 组件等于不存在。这里补等价 JS 实现（WXML 不支持内联 svg，用 view 布局）。
 */
var DEFAULT_AVATAR = '/pages/public/images/info/default_avatar.png';

Component({
  properties: {
    cat: { type: Object, value: {} },
    parents: { type: Array, value: [] },
    children: { type: Array, value: [] },
  },

  data: {
    cover: DEFAULT_AVATAR,
    hasData: false,
  },

  observers: {
    'cat,parents,children': function (cat, parents, children) {
      cat = cat || {};
      var avatar = cat.avatar;
      var cover = (avatar && (avatar.photo_compressed || avatar.photo_id)) || DEFAULT_AVATAR;
      var hasData = (Array.isArray(parents) && parents.length > 0)
        || (Array.isArray(children) && children.length > 0);
      this.setData({ cover: cover, hasData: !!hasData });
    },
  },

  methods: {
    onTapNode: function (e) {
      var id = e.currentTarget.dataset.id;
      if (id) {
        this.triggerEvent('tapnode', { catId: id });
      }
    },
  },
});
