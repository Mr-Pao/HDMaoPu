'use strict';

/**
 * 生成演示数据，填充 data/*.json（v4.1.0）
 *
 * 设计原则：
 *  1. 幂等 —— 每次运行从 data/cat.json 与 data/photo.json 的既有内容派生，
 *     重复执行结果一致，不会叠加。
 *  2. 外键自洽 —— comment.cat_id / rating.cat_id / inter.item_id 等全部指向
 *     真实存在的 cat / photo，跑完会交叉校验一遍。
 *  3. 不碰 COS —— 只写本地 data/，上传交给 scripts/upload-data.js（由 Actions 或手动触发）。
 *  4. 时间基准固定（BASE_DATE），避免每次生成的时间戳漂移导致 diff 噪音。
 *
 * 用法：
 *   node scripts/gen-demo-data.js            # 直接写入 data/
 *   node scripts/gen-demo-data.js --dry-run  # 只校验和打印，不落盘
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DRY = process.argv.includes('--dry-run');

// 固定时间基准：2026-10-31 12:00 (UTC+8) = 2026-10-31T04:00:00Z
const BASE = Date.parse('2026-10-31T04:00:00.000Z');
const DAY = 24 * 3600 * 1000;

/** n 天前的 ISO 字符串 */
function daysAgo(n, hour = 10) {
  const t = BASE - n * DAY;
  const d = new Date(t);
  d.setUTCHours(hour - 8, 0, 0, 0); // hour 按 UTC+8 理解
  return d.toISOString();
}

/** n 天前的毫秒时间戳 */
function msAgo(n) {
  return BASE - n * DAY;
}

/** 带固定种子的伪随机，保证多次运行同一结果 */
let _seed = 20261031;
function rnd() {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
function rndInt(min, max) {
  return min + Math.floor(rnd() * (max - min + 1));
}
function pick(arr) {
  return arr[rndInt(0, arr.length - 1)];
}

function readJSON(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf8'));
}

function writeJSON(name, obj) {
  const p = path.join(DATA_DIR, name + '.json');
  const text = JSON.stringify(obj, null, 2) + '\n';
  if (DRY) {
    console.log(`  [dry] ${name}.json  ${obj.items.length} 条`);
    return;
  }
  fs.writeFileSync(p, text, 'utf8');
  console.log(`  ✓ ${name}.json  ${obj.items.length} 条`);
}

function coll(items, version) {
  return { version: version || String(Date.now()), items };
}

// ---------------------------------------------------------------- 基础实体

const cats = readJSON('cat').items;
const photos = readJSON('photo').items;
const CAT_IDS = cats.map((c) => c._id);

// 演示用户（openid 固定，便于跨集合关联）
const USERS = [
  { openid: 'demo-openid-1', nickName: '猫友小王', role: 0, manager: 0 },
  { openid: 'demo-openid-2', nickName: '猫友小李', role: 0, manager: 0 },
  { openid: 'demo-openid-3', nickName: '猫友小张', role: 0, manager: 0 },
  { openid: 'demo-openid-4', nickName: '猫友小赵', role: 0, manager: 0 },
  { openid: 'demo-openid-5', nickName: '猫友小陈', role: 0, manager: 0 },
  { openid: 'demo-openid-6', nickName: '猫友小周', role: 0, manager: 0 },
  { openid: 'demo-openid-7', nickName: '猫友小吴', role: 0, manager: 0 },
  { openid: 'demo-openid-8', nickName: '猫友小林', role: 0, manager: 0 },
  // 管理员：manager=99 才能在「我的」页看到管理入口
  { openid: 'demo-openid-admin', nickName: '猫谱管理员', role: 0, manager: 99 },
];

const DEFAULT_AVATAR = '/pages/public/images/info/default_avatar.png';

// ---------------------------------------------------------------- user

function genUsers() {
  return USERS.map((u, i) => ({
    _id: 'demo-user-' + (i + 1),
    openid: u.openid,
    userInfo: {
      nickName: u.nickName,
      avatarUrl: DEFAULT_AVATAR,
    },
    manager: u.manager,
    role: u.role,
    // 关注列表：每人关注 2-4 只猫（本地 storage 为主，这里给云端一份快照）
    follow_cats: CAT_IDS.slice(i % 3, (i % 3) + 2 + (i % 3)),
    showcase_achievements: [],
    create_date: daysAgo(60 - i * 3),
  }));
}

// ---------------------------------------------------------------- comment

const COMMENT_TEXTS = [
  '今天又在法学院边草坪看到它了，胖了一圈。',
  '这只超级亲人，一蹲下就过来蹭腿。',
  '刚喂完罐头，吃得很香，大家可以放心投喂。',
  '下雨天躲到车底下了，路过的时候注意一下。',
  '耳朵上有个小缺口，是做过 TNR 的标记吧？',
  '下午三点左右在图书馆广场晒太阳，特别上镜。',
  '感觉最近有点瘦，是不是抢不到吃的？',
  '第一次见它，眼睛特别漂亮。',
  '这只的毛色越看越好看，橘得很正。',
  '昨天看到有人给它搭了个小纸箱，挺暖心的。',
  '它对这个牌子的猫粮完全不感兴趣，换一种试试。',
  '早上六点就在北门花坛蹲着了，作息很规律。',
  '跟另一只猫好像有点小摩擦，隔开喂比较好。',
  '拍照的时候一直扭头，只好抓拍了一张。',
  '已经连续三天在同一位置看到，可以加进常驻地了。',
  '希望有同学能帮忙做一下驱虫。',
];

const PAPER_COLORS = ['#FFF9C4', '#FFE0B2', '#C8E6C9', '#B3E5FC', '#F8BBD0', '#E1BEE7'];

function genComments(users) {
  const items = [];
  let n = 0;
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    const count = 3 + (i % 4); // 每只猫 3-6 条
    for (let j = 0; j < count; j++) {
      n++;
      const author = users[(i * 3 + j) % (users.length - 1)]; // 不含管理员
      items.push({
        _id: 'demo-comment-' + n,
        cat_id: cat._id,
        user_openid: author.openid,
        content: COMMENT_TEXTS[(i * 5 + j) % COMMENT_TEXTS.length],
        create_date: daysAgo(1 + n * 0.7),
        deleted: false,
        needVerify: false,
        paper_color: PAPER_COLORS[n % PAPER_COLORS.length],
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------- rating

/**
 * rating 集合：每条记录 = 一个用户对一只猫的五维评分（1-5 分）。
 * 注意：这里的 r1..r5 是「分数」，而 cat.rating.scores.r1..r5 是「得票计数」，语义不同。
 */
function genRatings(users) {
  const items = [];
  let n = 0;
  const scorers = users.filter((u) => u.manager === 0);
  for (let i = 0; i < cats.length; i++) {
    const cat = cats[i];
    // 每只猫 3-6 人评分
    const cnt = 3 + (i % 4);
    for (let j = 0; j < cnt; j++) {
      const u = scorers[(i + j) % scorers.length];
      n++;
      items.push({
        _id: 'demo-rating-' + n,
        _openid: u.openid,
        cat_id: cat._id,
        r1: rndInt(4, 5),
        r2: rndInt(4, 5),
        r3: rndInt(2, 5),
        r4: rndInt(4, 5),
        r5: rndInt(3, 5),
        create_date: daysAgo(2 + n),
      });
    }
  }
  return items;
}

/**
 * 由 rating 记录反推 cat.rating（得票计数形式），口径与 scripts/process-inbox.js 的 handleRating 一致：
 *   scores.rN = 打 N 分的人数
 *   count     = 总票数
 *   avgScore  = 加权平均
 *   avgScoreDisp = avgScore.toFixed(1)
 */
function applyCatRatings(catItems, ratingItems) {
  for (const cat of catItems) {
    const rs = ratingItems.filter((r) => r.cat_id === cat._id);
    const scores = { r1: 0, r2: 0, r3: 0, r4: 0, r5: 0 };
    for (const r of rs) {
      // 五维取整平均，模拟 process-inbox 的「一票一分数」口径
      const avg = (r.r1 + r.r2 + r.r3 + r.r4 + r.r5) / 5;
      const s = Math.min(5, Math.max(1, Math.round(avg)));
      scores['r' + s]++;
    }
    let sum = 0;
    let cnt = 0;
    for (let i = 1; i <= 5; i++) {
      sum += i * scores['r' + i];
      cnt += scores['r' + i];
    }
    cat.rating = {
      count: cnt,
      scores,
      avgScore: cnt ? sum / cnt : 0,
      avgScoreDisp: (cnt ? sum / cnt : 0).toFixed(1),
    };
  }
}

// ---------------------------------------------------------------- inter（点赞）

const TYPE_LIKE = 10000;

function genInter(users) {
  const items = [];
  let n = 0;
  // 每个用户给若干张照片点赞（用于排行榜 like_count>=1 的前提）
  for (let ui = 0; ui < users.length; ui++) {
    const u = users[ui];
    if (u.manager) continue;
    const likeCount = 3 + (ui % 4); // 每人点 3-6 张
    for (let k = 0; k < likeCount; k++) {
      const p = photos[(ui * 3 + k) % photos.length];
      n++;
      items.push({
        _id: 'demo-inter-' + n,
        type: TYPE_LIKE,
        uid: u.openid,
        item_id: p._id,
        create_date: daysAgo(1 + n * 0.5),
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------- photo 点赞数

function applyPhotoLikes(photoItems, interItems) {
  for (const p of photoItems) {
    p.like_count = interItems.filter((x) => x.item_id === p._id && x.type === TYPE_LIKE).length;
  }
}

// ---------------------------------------------------------------- feedback

const FEEDBACK_TEXTS = [
  '这只猫猫好像腿部有伤，走路一瘸一拐的，希望能安排检查。',
  '北门花坛的猫粮盆被清理了，请问还能继续投喂吗？',
  '建议给这只猫加一个常出没地点标记，最近一直在东门出现。',
  '发现一只没在猫谱里的新猫，黑白花，需要新建档案。',
  '照片上传一直失败，提示网络错误。',
  '希望在详情页加上疫苗记录，方便带去医院时查看。',
  '这只猫已经做过绝育了吧？耳朵有缺口。',
  '申请成为志愿者，帮忙定期拍照更新档案。',
];

function genFeedback(users) {
  return FEEDBACK_TEXTS.map((text, i) => {
    const u = users[i % (users.length - 1)];
    const cat = cats[i % cats.length];
    const replied = i % 3 === 1; // 部分已回复
    const item = {
      _id: 'demo-feedback-' + (i + 1),
      // 注意：管理端 checkFeedbacks 用 openid 补 userInfo，我的反馈页用 _openid 过滤，两个都要有
      _openid: u.openid,
      openid: u.openid,
      cat_id: cat._id,
      feedbackInfo: text,
      contactInfo: i % 4 === 0 ? '微信: cat_lover_' + (i + 1) : '',
      openDate: daysAgo(20 - i),
      dealed: replied,
      repliable: true,
    };
    if (replied) {
      item.replyInfo = '已收到反馈，我们会尽快安排志愿者跟进，感谢你关注校园猫猫！';
      item.replyDate = daysAgo(19 - i);
    }
    return item;
  });
}

// ---------------------------------------------------------------- news

const NEWS_ITEMS = [
  {
    title: '冬季猫窝投喂点开放公告',
    class: '其他',
    mainContent:
      '随着气温下降，我们在南校园设置了 6 个保暖猫窝，分别位于北门花坛、法学院边草坪、荣光堂、图书馆广场、英东体育场与园东湖。\n\n每个猫窝内配有防潮垫与保温棉，志愿者会每周检查并更换。欢迎同学们就近参与维护，如发现猫窝受潮或损坏，可以在小程序内提交反馈。\n\n请勿将剩饭剩菜倒入猫窝，以免吸引老鼠和蚊虫。',
    setNewsModal: true,
    show: true,
    days: 2,
  },
  {
    title: '本季度 TNR 工作小结',
    class: '救助',
    mainContent:
      '本季度我们完成了 5 只猫的诱捕-绝育-放归（TNR）工作，其中 3 只为新发现的个体。\n\n绝育后的猫猫耳部会有一个小缺口作为标记，便于志愿者识别，避免重复手术。术后观察期为 3-7 天，期间由志愿者在家中照料。\n\n感谢参与诱捕和接送的同学们。下一轮 TNR 计划在 12 月开展，需要更多人手。',
    setNewsModal: false,
    show: true,
    days: 9,
  },
  {
    title: '「校园猫猫摄影比赛」结果公布',
    class: '活动',
    mainContent:
      '本次摄影比赛共收到 87 份投稿，经过志愿者与专业摄影同学的两轮评选，最终选出 10 张作品。\n\n获奖作品已在小程序「排行榜」页面展示。感谢每一位投稿的同学，你们镜头下的猫猫让这个秋天温暖了很多。\n\n下届比赛预计在明年春天举办，届时会增设短视频组别。',
    setNewsModal: false,
    show: true,
    days: 16,
  },
  {
    title: '关于规范投喂的倡议',
    class: '其他',
    mainContent:
      '近期发现部分投喂点出现猫粮堆积、气味较重的情况，给附近宿舍和教学楼带来困扰。\n\n我们倡议：\n1. 按需投喂，一次投喂量以猫猫能在 20 分钟内吃完为准；\n2. 使用便携餐盒，投喂后带走残余；\n3. 不投喂人类食物，尤其是含盐、含葱蒜的食品；\n4. 发现猫猫食欲明显下降，请及时在反馈中说明。\n\n感谢配合。',
    setNewsModal: false,
    show: true,
    days: 24,
  },
  {
    title: '三花「团子」走失，请帮忙留意',
    class: '救助',
    mainContent:
      '团子（橘色，公猫，左耳有绝育缺口）于上周在园东湖附近走失，最后目击时间为傍晚。\n\n它性格略胆小，遇到陌生人会躲。如果看到相似个体，请拍下照片并在小程序内提交反馈，或直接在猫谱中找到「团子」的档案留言。\n\n请不要强行抓捕，以免它受惊跑到更远的地方。',
    setNewsModal: false,
    show: true,
    days: 31,
  },
  {
    title: '新猫档案「花生」建成',
    class: '其他',
    mainContent:
      '奶牛色的「花生」是最近在东门附近被发现的新个体，目前已建立档案并补充了 3 张照片。\n\n初步观察，花生亲人程度较高，尚未绝育。我们会在下一次 TNR 行动中优先安排。\n\n欢迎大家继续补充它的活动范围与性格特点。',
    setNewsModal: false,
    show: true,
    days: 45,
  },
  {
    title: '志愿者招募：每周巡护 2 小时',
    class: '活动',
    mainContent:
      '我们希望招募一批稳定的志愿者，负责每周一次的定点巡护：\n\n- 检查猫窝与投喂点状况\n- 记录猫猫健康与数量变化\n- 拍摄更新档案照片\n\n每人每周投入约 2 小时，可两人一组轮换。有兴趣的同学请通过「我的 → 意见反馈」联系我们，注明可参与的时间段。',
    setNewsModal: false,
    show: true,
    days: 58,
  },
  {
    title: '猫谱小程序使用说明',
    class: '其他',
    mainContent:
      '欢迎使用火大猫谱！\n\n「猫谱」页可以看到所有已建档的校园猫，点击卡片进入详情页可以查看照片、便利贴留言、疫苗与评分信息。\n\n在「新闻」页我们会不定期发布救助进展与活动通知。如果发现没有档案的新猫，欢迎通过反馈告诉我们。',
    setNewsModal: false,
    show: true,
    days: 72,
  },
];

function genNews() {
  return NEWS_ITEMS.map((n, i) => ({
    _id: 'demo-news-' + (i + 1),
    userNickname: '猫谱管理员',
    title: n.title,
    mainContent: n.mainContent,
    coverPath: `photos/${CAT_IDS[i % CAT_IDS.length]}/cover.jpg`,
    photosPath: [`photos/${CAT_IDS[i % CAT_IDS.length]}/cover.jpg`],
    class: n.class,
    setNewsModal: n.setNewsModal,
    show: n.show,
    date: daysAgo(n.days),
  }));
}

// ---------------------------------------------------------------- badge_def

const BADGE_DEFS = [
  { _id: 'bd-first-meet', name: '初次相遇', desc: '第一次在猫谱中见到猫猫', level: 'C', rankDesc: '相遇的开始', img: '' },
  { _id: 'bd-photo-fan', name: '拍猫达人', desc: '累计拍摄并上传 10 张猫猫照片', level: 'B', rankDesc: '镜头里的猫', img: '' },
  { _id: 'bd-like-star', name: '人气之星', desc: '单张照片获得 20 次以上点赞', level: 'B', rankDesc: '被更多人看见', img: '' },
  { _id: 'bd-comment-king', name: '便利贴之王', desc: '累计发布 20 条便利贴留言', level: 'B', rankDesc: '留下最多故事的人', img: '' },
  { _id: 'bd-tnr-hero', name: 'TNR 卫士', desc: '参与或协助完成一次绝育行动', level: 'A', rankDesc: '为绝育贡献一份力', img: '' },
  { _id: 'bd-adopter', name: '暖心归宿', desc: '成功领养一只校园猫', level: 'A', rankDesc: '给了一个家', img: '' },
  { _id: 'bd-night-owl', name: '夜巡者', desc: '在夜间时段记录过猫猫状态', level: 'C', rankDesc: '深夜的守护', img: '' },
  { _id: 'bd-map-pioneer', name: '地图开拓者', desc: '新增 5 个猫猫常出没地点', level: 'B', rankDesc: '摸清了活动范围', img: '' },
  { _id: 'bd-legend', name: '猫谱传奇', desc: '累计获得 100 个徽章', level: 'S', rankDesc: '传说级热爱', img: '' },
  { _id: 'bd-guardian', name: '守护者', desc: '连续 30 天访问猫谱', level: 'S', rankDesc: '风雨无阻', img: '' },
];

function genBadgeDef() {
  return BADGE_DEFS.map((b) => ({ ...b }));
}

// ---------------------------------------------------------------- badge

const BADGE_REASONS = ['checkIn', 'watchPictureAD', 'watchVideoAD', 'manual'];

function genBadge(users, badgeDefs) {
  const items = [];
  let n = 0;
  const normal = users.filter((u) => u.manager === 0);
  // 用户级徽章（catId = null），loadUserBadge 只看 catId===null 且无 givenTime
  for (let ui = 0; ui < normal.length; ui++) {
    const u = normal[ui];
    const cnt = 2 + (ui % 4);
    for (let k = 0; k < cnt; k++) {
      const def = badgeDefs[(ui * 2 + k) % badgeDefs.length];
      n++;
      items.push({
        _id: 'demo-badge-' + n,
        _openid: u.openid,
        catId: null,
        badgeDef: def._id,
        reason: BADGE_REASONS[k % BADGE_REASONS.length],
        acquireTime: daysAgo(1 + ((ui * 5 + k) % 25)),
        givenTime: null,
      });
    }
  }
  // 猫猫级徽章，detailCat 的 reloadCatBadge 按 catId 查
  for (let ci = 0; ci < cats.length; ci++) {
    const cnt = 1 + (ci % 3);
    for (let k = 0; k < cnt; k++) {
      const def = badgeDefs[(ci + k + 3) % badgeDefs.length];
      n++;
      items.push({
        _id: 'demo-badge-' + n,
        _openid: normal[ci % normal.length].openid,
        catId: cats[ci]._id,
        badgeDef: def._id,
        reason: 'manual',
        acquireTime: daysAgo(2 + ((ci * 3 + k) % 20)),
        givenTime: null,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------- badge_rank

/**
 * 快照结构：{ _id, mdate, rankV2: { [days]: { count: {catId: n}, score: {catId: n}, [badgeDefId]: {catId: n} } } }
 * 组件遍历 rankV2[days]，再对每个 rankKey 遍历 catId -> 计数。
 */
function genBadgeRank(cats2, badgeDefs) {
  const mk = (scale) => {
    const o = {};
    for (let ci = 0; ci < cats2.length; ci++) {
      const c = cats2[ci];
      o[c._id] = Math.max(1, ((cats2.length - ci) * scale) % 9);
    }
    return o;
  };
  const build = (scale) => {
    const r = { count: mk(scale), score: mk(scale + 2) };
    // 取前 3 个徽章定义各做一榜
    badgeDefs.slice(0, 3).forEach((d, i) => {
      r[d._id] = mk(scale + i + 1);
    });
    return r;
  };
  return [
    {
      _id: 'demo-badge-rank-1',
      mdate: daysAgo(0, 8),
      rankV2: {
        7: build(1),
        30: build(2),
        365: build(3),
      },
    },
  ];
}

// ---------------------------------------------------------------- photo_rank

/**
 * 快照结构：{ _id, mdate, stat: { [openid]: { count: n } } }
 * 注意 stat 的 key 是 openid，值里是 count（组件按 `_openid` 回填 userInfo）。
 */
function genPhotoRank(users, interItems) {
  const stat = {};
  for (const u of users) {
    if (u.manager) continue;
    const cnt = interItems.filter((x) => x.uid === u.openid).length;
    if (cnt > 0) stat[u.openid] = { count: cnt };
  }
  return [
    {
      _id: 'demo-photo-rank-1',
      mdate: daysAgo(0, 8),
      stat,
    },
  ];
}

// ---------------------------------------------------------------- reward

/**
 * 注意：页面执行 r.records.replace(/^#+|#+$/g,'').split('#')，
 * 所以 records 必须是 # 分隔的字符串，不能是数组。
 */
function genReward() {
  return [
    {
      _id: 'demo-reward-1',
      mdate: daysAgo(5, 9),
      recordDate: daysAgo(5, 9),
      records: '#猫友小王#赞助了 1 袋 2kg 猫粮#猫友小李#赞助了 20 个罐头#匿名猫友#赞助了 5 个猫窝#',
    },
    {
      _id: 'demo-reward-2',
      mdate: daysAgo(35, 9),
      recordDate: daysAgo(35, 9),
      records: '#猫友小张#赞助了驱虫药 3 盒#猫友小周#赞助了 1 个保温垫#',
    },
    {
      _id: 'demo-reward-3',
      mdate: daysAgo(66, 9),
      recordDate: daysAgo(66, 9),
      records: '#猫友小陈#赞助了绝育手术费用 1 例#猫友小林#赞助了 30 个罐头#',
    },
  ];
}

// ---------------------------------------------------------------- achievement

function genAchievement(users) {
  const items = [];
  let n = 0;
  for (let ui = 0; ui < users.length; ui++) {
    const u = users[ui];
    if (u.manager) continue;
    const cnt = 1 + (ui % 3);
    for (let k = 0; k < cnt; k++) {
      n++;
      items.push({
        _id: 'demo-ach-' + n,
        openid: u.openid,
        key: ['first_meet', 'photo_fan', 'comment_king', 'night_owl'][(ui + k) % 4],
        create_date: daysAgo(5 + ui * 2 + k),
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------- review_queue

/**
 * 条目结构参照 scripts/process-inbox.js 的 handleComment / handleDecision：
 * { _id, kind, ts, openid, status, data }
 */
function genReviewQueue(users) {
  const pendingTexts = [
    '这只猫最近好像一直在打喷嚏，是不是感冒了？',
    '东门新来了一只小幼猫，很瘦，求关注。',
    '想申请给「花生」补充几张新照片。',
    '这个投喂点的水盆空了，麻烦补充一下。',
    '建议把「团子」的状态改成失踪，已经两周没见。',
  ];
  return pendingTexts.map((t, i) => {
    const u = users[i % (users.length - 1)];
    return {
      _id: 'demo-rq-' + (i + 1),
      kind: 'comment',
      ts: msAgo(1 + i),
      openid: u.openid,
      status: 'pending',
      data: {
        cat_id: CAT_IDS[i % CAT_IDS.length],
        content: t,
        nickname: u.nickName,
        type: 'comment',
      },
    };
  });
}

// ---------------------------------------------------------------- 主流程

function main() {
  console.log('生成演示数据' + (DRY ? '（dry-run，不落盘）' : ''));
  console.log('基准时间：2026-10-31 12:00 (UTC+8)\n');

  const users = genUsers();
  const comments = genComments(users);
  const ratings = genRatings(users);
  const inter = genInter(users);
  const feedback = genFeedback(users);
  const news = genNews();
  const badgeDefs = genBadgeDef();
  const badge = genBadge(users, badgeDefs);
  const badgeRank = genBadgeRank(cats, badgeDefs);
  const reward = genReward();
  const achievement = genAchievement(users);
  const reviewQueue = genReviewQueue(users);

  // 派生统计
  applyCatRatings(cats, ratings);
  applyPhotoLikes(photos, inter);
  for (const cat of cats) {
    const cs = comments.filter((c) => c.cat_id === cat._id && !c.deleted);
    cat.comment_count = cs.length;
    // follow_count 之前一直是 0，补一个与关注列表一致的冗余计数
    cat.follow_count = users.filter((u) => (u.follow_cats || []).includes(cat._id)).length;
    cat.photo_count_total = photos.filter((p) => p.cat_id === cat._id && !p.deleted).length;
    cat.photo_count_best = photos.filter((p) => p.cat_id === cat._id && p.best && !p.deleted).length;
    // 首页排序字段 mphoto：取该猫最新照片的 mdate 毫秒值
    const latest = photos
      .filter((p) => p.cat_id === cat._id && p.mdate)
      .map((p) => Date.parse(p.mdate))
      .sort((a, b) => b - a)[0];
    if (latest) cat.mphoto = latest;
  }
  const photoRank = genPhotoRank(users, inter);

  console.log('写入集合：');
  writeJSON('user', coll(users));
  writeJSON('comment', coll(comments));
  writeJSON('rating', coll(ratings));
  writeJSON('inter', coll(inter));
  writeJSON('feedback', coll(feedback));
  writeJSON('news', coll(news));
  writeJSON('badge_def', coll(badgeDefs));
  writeJSON('badge', coll(badge));
  writeJSON('badge_rank', coll(badgeRank));
  writeJSON('photo_rank', coll(photoRank));
  writeJSON('reward', coll(reward));
  writeJSON('achievement', coll(achievement));
  writeJSON('review_queue', coll(reviewQueue));
  writeJSON('cat', coll(cats, readJSON('cat').version));
  writeJSON('photo', coll(photos, readJSON('photo').version));

  console.log('\n跨集合一致性校验：');
  const errs = [];
  const catIdSet = new Set(CAT_IDS);
  const photoIdSet = new Set(photos.map((p) => p._id));
  const userOpenidSet = new Set(users.map((u) => u.openid));
  const badgeDefIdSet = new Set(badgeDefs.map((b) => b._id));

  const check = (cond, msg) => {
    if (!cond) errs.push(msg);
  };

  comments.forEach((c) => {
    check(catIdSet.has(c.cat_id), `comment ${c._id} 的 cat_id 不存在: ${c.cat_id}`);
    check(userOpenidSet.has(c.user_openid), `comment ${c._id} 的 user_openid 不存在`);
  });
  ratings.forEach((r) => {
    check(catIdSet.has(r.cat_id), `rating ${r._id} 的 cat_id 不存在`);
    check(userOpenidSet.has(r._openid), `rating ${r._id} 的 _openid 不存在`);
  });
  inter.forEach((x) => {
    check(photoIdSet.has(x.item_id), `inter ${x._id} 的 item_id 不存在: ${x.item_id}`);
    check(userOpenidSet.has(x.uid), `inter ${x._id} 的 uid 不存在`);
  });
  feedback.forEach((f) => {
    check(catIdSet.has(f.cat_id), `feedback ${f._id} 的 cat_id 不存在`);
    check(userOpenidSet.has(f.openid) && userOpenidSet.has(f._openid), `feedback ${f._id} 的 openid/_openid 缺失`);
    check(typeof f.repliable === 'boolean', `feedback ${f._id} 缺 repliable`);
    check(typeof f.dealed === 'boolean', `feedback ${f._id} 缺 dealed`);
  });
  badge.forEach((b) => {
    check(badgeDefIdSet.has(b.badgeDef), `badge ${b._id} 的 badgeDef 不存在: ${b.badgeDef}`);
    if (b.catId) check(catIdSet.has(b.catId), `badge ${b._id} 的 catId 不存在`);
  });
  reward.forEach((r) => {
    check(typeof r.records === 'string' && r.records.includes('#'), `reward ${r._id} 的 records 必须是 # 分隔字符串`);
  });
  news.forEach((n) => {
    check(Array.isArray(n.photosPath), `news ${n._id} 缺 photosPath 数组（detailNews 会调 .map）`);
    check(typeof n.show === 'boolean', `news ${n._id} 缺 show（首页预加载按 show:true 查）`);
    check(!!n.date, `news ${n._id} 缺 date（按 date 倒序）`);
  });
  reviewQueue.forEach((q) => {
    check(['pending', 'approved', 'rejected'].includes(q.status), `review_queue ${q._id} status 非法`);
  });

  // cat 统计与派生数据一致性
  cats.forEach((c) => {
    const cnt = comments.filter((x) => x.cat_id === c._id && !x.deleted).length;
    check(c.comment_count === cnt, `cat ${c._id} comment_count=${c.comment_count} 与实际 ${cnt} 不符`);
    const lc = inter.filter((x) => x.item_id && photos.some((p) => p._id === x.item_id && p.cat_id === c._id)).length;
    const expectLikes = photos.filter((p) => p.cat_id === c._id).reduce((s, p) => s + (p.like_count || 0), 0);
    check(expectLikes === lc, `cat ${c._id} 照片点赞总数 ${expectLikes} 与 inter ${lc} 不符`);
  });

  // 排行榜前提：photo_rank 需要至少一张 like_count>=1 的照片
  const likedPhotos = photos.filter((p) => p.like_count >= 1);
  check(likedPhotos.length > 0, 'photo 没有 like_count>=1 的数据，排行榜会空');

  if (errs.length) {
    console.error('\n✗ 校验失败 ' + errs.length + ' 项：');
    errs.forEach((e) => console.error('  - ' + e));
    process.exitCode = 1;
  } else {
    console.log('  ✓ 全部通过');
    console.log('\n统计概览：');
    console.log(`  用户 ${users.length} / 评论 ${comments.length} / 评分 ${ratings.length} / 点赞 ${inter.length}`);
    console.log(`  反馈 ${feedback.length} / 新闻 ${news.length} / 勋章定义 ${badgeDefs.length} / 勋章 ${badge.length}`);
    console.log(`  成就 ${achievement.length} / 打赏 ${reward.length} / 审核队列 ${reviewQueue.length}`);
    console.log(`  有赞照片 ${likedPhotos.length}/${photos.length}`);
    const avg = cats.map((c) => c.rating.avgScore).filter((x) => x > 0);
    console.log(`  猫猫评分区间 ${Math.min(...avg).toFixed(1)} - ${Math.max(...avg).toFixed(1)}（${avg.length} 只有评分）`);
  }
}

main();
