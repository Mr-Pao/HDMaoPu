/**
 * cat-card 猫卡片组件（v4.0.3）
 * 属性：cat / title / subtitle
 *
 * 说明：原 cat-card.ts 在 useCompilerPlugins=false 的工程里不会被编译，
 * 组件等于不存在（便利贴墙顶部因此空白）。这里补等价 JS 实现。
 */
var DEFAULT_AVATAR = '/pages/public/images/info/default_avatar.png';

Component({
  properties: {
    cat: { type: Object, value: {} },
    subtitle: { type: String, value: '' },
    title: { type: String, value: '' },
  },

  data: {
    cover: DEFAULT_AVATAR,
    metaShow: false,
    displayName: '',
  },

  observers: {
    'cat,title': function (cat, title) {
      cat = cat || {};
      var avatar = cat.avatar;
      var cover = (avatar && (avatar.photo_compressed || avatar.photo_id)) || DEFAULT_AVATAR;
      var metaShow = !!(cat.gender || cat.birthday || cat.rating);
      var displayName = (title && title) || cat.name || '';
      this.setData({ cover: cover, metaShow: metaShow, displayName: displayName });
    },
  },
});
