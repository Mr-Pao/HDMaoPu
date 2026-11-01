/**
 * MaoPu 领域模型类型定义（v4.0.3）
 *
 * 字段来源核对（不臆造）：
 * - Cat / RatingSummary / RatingScores / Haunt / Relation：
 *   依据 data/cat.json 真实结构（cat.json 含完整字段示例）。
 * - RatingItem / RatingDoc：
 *   依据 miniprogram/utils/rating.js 的 convertRatingList / genDefaultRating。
 * - Comment：
 *   data/comment.json 为占位空数组（items: []），字段依据
 *   miniprogram/pages/genealogy/commentBoard/commentBoard.js 实际用法推导。
 */

/** 头像/封面图引用（getAvatar 返回结构） */
export interface Avatar {
  photo_id?: string;
  photo_compressed?: string;
}

/** 评分各维度原始分（与 utils/rating.js 的 ratingMap 键一致） */
export interface RatingScores {
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  r5: number;
}

/** 猫猫聚合评分（data/cat.json.rating） */
export interface RatingSummary {
  count: number;
  scores: RatingScores;
  avgScore: number;
  avgScoreDisp: string;
}

/** 单条评分维度展示项（convertRatingList 产物） */
export interface RatingItem {
  key: string;
  name: string;
  score: number;
  scoreDisp?: string;
}

/** 一条评分记录文档（collection: rating） */
export interface RatingDoc {
  _id?: string;
  _openid?: string;
  cat_id: string;
  r1: number;
  r2: number;
  r3: number;
  r4: number;
  r5: number;
}

/** 猫际关系（data/cat.json.relations[i]） */
export interface Relation {
  cat_id: string;
  type?: string;
  alias?: string;
}

/** 常出没地点 */
export interface Haunt {
  name: string;
  latitude: number;
  longitude: number;
}

/** 猫猫实体 */
export interface Cat {
  _id?: string;
  _no?: string;
  name: string;
  nickname?: string;
  campus?: string;
  area?: string;
  birthday?: string;
  colour?: string;
  gender?: string;
  characteristics?: string | string[];
  tutorial?: string;
  popularity?: number;
  sterilized?: boolean;
  adopt?: number;
  missing?: boolean;
  to_star?: boolean;
  relations?: Relation[];
  haunts?: Haunt[];
  rating?: RatingSummary;
  photo_count_best?: number;
  photo_count_total?: number;
  comment_count?: number;
  follow_count?: number;
  latitude?: number;
  longitude?: number;
  avatar?: Avatar;
  /** 页面运行期附加：已签名的精选图列表 */
  photo?: unknown[];
}

/** 便利贴/评论项（commentBoard 实际使用字段） */
export interface Comment {
  _id?: string;
  user_openid?: string;
  cat_id: string;
  paper_color?: string;
  needVerify?: boolean;
  userInfo?: {
    avatarUrl?: string;
    nickName?: string;
  };
  content: string;
  datetime?: string;
  create_date?: number;
  rotate?: number;
  tape_pos_left?: number;
  tape_rotate?: number;
  like_count?: number;
}
