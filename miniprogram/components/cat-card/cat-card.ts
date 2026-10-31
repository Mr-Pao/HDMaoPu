/**
 * cat-card 猫卡片组件（v4.0.3）
 * 属性：
 *  - cat:      猫实体（见 types/domain.ts 的 Cat）
 *  - subtitle: 副标题（如“共 N 张便利贴”），可选
 * 展示：封面图、名称、品种/性别/出生、评分预览（星级，嵌入 star-rating）
 */
import { Cat } from '../../types/domain';

const DEFAULT_AVATAR = '/pages/public/images/info/default_avatar.png';

interface IData {
  cover: string;
  metaShow: boolean;
  displayName: string;
}

Component({
  properties: {
    cat: {
      type: Object,
      value: {} as Cat,
    },
    subtitle: {
      type: String,
      value: '',
    },
    title: {
      type: String,
      value: '',
    },
  },

  data: {
    cover: DEFAULT_AVATAR,
    metaShow: false,
    displayName: '',
  },

  observers: {
    'cat,title'(cat: Cat, title: string): void {
      const avatar = cat && cat.avatar;
      const cover = (avatar && (avatar.photo_compressed || avatar.photo_id)) || DEFAULT_AVATAR;
      const metaShow = !!(
        (cat && (cat.gender || cat.birthday || cat.rating))
      );
      const displayName = (title && title) || (cat && cat.name) || '';
      this.setData({ cover, metaShow, displayName });
    },
  },
});
