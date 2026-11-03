'use strict';

/**
 * 数据落地验证：直接驱动项目真实的 utils/datasource.js，
 * 按各页面的实际查询方式打一遍，确认「页面能查到、字段能取到」。
 *
 * 做法：
 *  - 在 Node 里桩掉 wx.*，让 datasource 从本地 data/ 读文件（不走网络）
 *  - 用 datasource 暴露的 db 接口，复刻页面的查询语句
 *
 * 口径（2026-11-01 起）：data/ 是真实数据（21 只猫 / 278 张照片），
 * 演示数据已全部清空。所以断言分成两类：
 *  1. 真实数据必须成立的不变量：引用完整、计数自洽、日期合法、筛选枚举匹配、
 *     公网 URL 形态、空表查询不报错等；
 *  2. 空表（comment/rating/news/user…）只验「能查、不抛异常」，
 *     不再断言「条数 > 0」——那是有数据的时期才成立的条件。
 * 文件名沿用历史名称，勿改为 verify-real-data.js（AGENTS.md 与文档仍引用旧名）。
 *
 * 用法：node scripts/verify-demo-data.js
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// ---------------------------------------------------------------- wx 桩
const storage = {};
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => {
    storage[k] = v;
  },
  removeStorageSync: (k) => {
    delete storage[k];
  },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  showModal: () => {},
  // datasource 固定走 wx.request 拉 {baseUrl}/data/<name>.json，
  // 这里拦截后直接读本地文件，等价于 COS 返回 200 + JSON。
  request: (opt) => {
    const name = String(opt.url || '').split('/data/').pop().replace(/\.json.*$/, '');
    const p = path.join(DATA_DIR, name + '.json');
    let statusCode = 200;
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      statusCode = 404;
      data = null;
    }
    // 异步回调，模拟网络
    setTimeout(() => {
      if (opt.success) opt.success({ statusCode, data });
      if (opt.complete) opt.complete({ statusCode, data });
    }, 0);
  },
  cloud: { database: () => ({}) },
};

global.getApp = () => ({ mpServerless: null, cos: null, globalData: {} });

// 让 datasource 的远端拉取直接读本地文件
global.setTimeout = setTimeout;

// ---------------------------------------------------------------- 加载 datasource
const dsPath = path.join(ROOT, 'miniprogram', 'utils', 'datasource.js');
let src = fs.readFileSync(dsPath, 'utf8');

// datasource 是 ESM 风格（import/export），这里做最小变换以便 require
src = src
  .replace(/^import\s+([\s\S]*?)\s+from\s+['"](.+?)['"];?$/gm, '')
  .replace(/^export\s+default\s+/m, 'module.exports = ')
  .replace(/^export\s*\{([\s\S]*?)\};?$/gm, '')
  .replace(/^export\s+(async\s+)?function\s+/gm, '$1function ')
  .replace(/^export\s+const\s+/gm, 'const ');

const tmpFile = path.join(ROOT, 'scripts', '.datasource.cjs');
fs.writeFileSync(tmpFile, src, 'utf8');

let datasource;
try {
  datasource = require(tmpFile);
} catch (e) {
  console.error('datasource 加载失败：', e.message);
  process.exit(1);
}

const createJsonServerless =
  datasource.createJsonServerless || (datasource.default && datasource.default.createJsonServerless);

if (!createJsonServerless) {
  console.error('未找到 createJsonServerless 导出');
  process.exit(1);
}

// ---------------------------------------------------------------- 跑验证
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail ? '  ' + detail : ''));
}

async function main() {
  // baseUrl 指向本地目录；实际取数由上面的 wx.request 桩完成
  const serverless = createJsonServerless({
    baseUrl: 'https://local.test',
  });

  const db = serverless.db;

  // ---------------------------------------------------------------- 基础数据
  const cats = (await db.collection('cat').find({ deleted: { $ne: true } })).result;
  const photos = (await db.collection('photo').find({ deleted: { $ne: true } })).result;
  const catById = {};
  cats.forEach((c) => {
    catById[c._id] = c;
  });
  const photoCountByCat = {};
  photos.forEach((p) => {
    photoCountByCat[p.cat_id] = (photoCountByCat[p.cat_id] || 0) + 1;
  });

  const stamp = /^\d{3,}$/;
  const isEmptyTable = async (name) => {
    const r = await db.collection(name).find({});
    return Array.isArray(r.result);
  };

  console.log('\n【猫谱主页 / cat】');
  {
    check('首页查询有结果', cats.length > 0, `${cats.length} 只`);
    check('_id 不重复', new Set(cats.map((c) => c._id)).size === cats.length);
    check('每只都有 name', cats.every((c) => typeof c.name === 'string' && c.name));
    check('mphoto 都是数字', cats.every((c) => typeof c.mphoto === 'number'));
    const sorted = (await db.collection('cat').find({ deleted: { $ne: true } }, { sort: { mphoto: -1, like_count: -1 } })).result;
    check('按 mphoto 倒序', sorted.every((x, i, a) => i === 0 || a[i - 1].mphoto >= x.mphoto));
    check('当前在册计数 > 0', cats.filter((c) => c.adopt !== 1 && !c.to_star && !c.missing).length > 0);
    check('comment_count 是数字', cats.every((c) => typeof c.comment_count === 'number'));
    check('follow_count 是数字', cats.every((c) => typeof c.follow_count === 'number'));
    check('like_count 是数字（详情页/首页点赞格）', cats.every((c) => typeof c.like_count === 'number'));
    check('campus 都有值（详情页只拼 campus + area）', cats.every((c) => typeof c.campus === 'string' && c.campus));
    check('rating 结构完整（count 为 0 时不能是 null）',
      cats.every((c) => c.rating && typeof c.rating === 'object' && typeof c.rating.count === 'number'));
    check('rating.count 为 0 时 scores/avgScore 归零',
      cats.filter((c) => c.rating.count === 0).every((c) =>
        c.rating.avgScore === 0 && ['r1', 'r2', 'r3', 'r4', 'r5'].every((k) => c.rating.scores[k] === 0)));
    check('avgScoreDisp 是一位小数', cats.every((c) => /^\d\.\d$/.test(c.rating.avgScoreDisp)));
  }

  console.log('\n【筛选 / setting 内嵌 filter】');
  {
    const f = (await db.collection('setting').findOne({ _id: 'filter' })).result;
    check('setting 里有 filter 记录（loadFilter 读这里）', !!f);
    const colour = (f && f.colour) || [];
    const campuses = (f && f.campuses) || [];
    check('filter.colour 非空', colour.length > 0, colour.join('/'));
    check('filter.campuses 非空', campuses.length > 0, campuses.join('/'));
    const badColour = cats.filter((c) => c.colour && !colour.includes(c.colour));
    check('每只猫的 colour 都在 filter.colour 里', badColour.length === 0, badColour.map((c) => `${c.name}=${c.colour}`).join(','));
    const badCampus = cats.filter((c) => !campuses.includes(c.campus));
    check('每只猫的 campus 都在 filter.campuses 里', badCampus.length === 0, badCampus.map((c) => `${c.name}=${c.campus}`).join(','));
    const areaOk = Array.isArray(f && f.area);
    check('filter.area 是数组（无细分地点时为空数组）', areaOk);
  }

  console.log('\n【相册 / photo】');
  {
    check('相册查询有结果', photos.length > 0, `${photos.length} 张`);
    const badRef = photos.filter((p) => !catById[p.cat_id]);
    check('每张照片的 cat_id 都能在 cat 里找到', badRef.length === 0, badRef.map((p) => `${p._id}->${p.cat_id}`).join(','));
    check('_id 不重复', new Set(photos.map((p) => p._id)).size === photos.length);
    check('全部 verified（首页/相册都过滤 verified:true）', photos.every((p) => p.verified === true));
    const isRealDate = (s) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
      if (!m) return false;
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    };
    const badDate = photos.filter((p) => !isRealDate(p.shooting_date));
    check('shooting_date 都是合法日期', badDate.length === 0, badDate.map((p) => `${p._id}=${p.shooting_date}`).join(','));
    const beforeBirth = photos.filter((p) => catById[p.cat_id] && catById[p.cat_id].birthday && p.shooting_date < catById[p.cat_id].birthday);
    check('拍摄日期不早于猫咪生日', beforeBirth.length === 0, beforeBirth.map((p) => p._id).join(','));
    const badUrl = photos.filter((p) => !/^https:\/\/[\w.-]+\/catimg\/[a-z]+\/[a-z]+\/\d{3}\.(jpg|jpeg|png)$/.test(p.photo_compressed || ''));
    check('photo_compressed 是 catimg 公网地址（拼音+序号）', badUrl.length === 0, badUrl.slice(0, 3).map((p) => p._id).join(','));
    check('photo_id / photo_watermark 与 compressed 同源',
      photos.every((p) => p.photo_id === p.photo_compressed && p.photo_watermark === p.photo_compressed));
    // 每只猫恰好 1 张 best，且 photo_count_best 与之一致
    const bestByCat = {};
    photos.filter((p) => p.best).forEach((p) => {
      bestByCat[p.cat_id] = (bestByCat[p.cat_id] || 0) + 1;
    });
    const multiBest = Object.keys(bestByCat).filter((k) => bestByCat[k] > 1);
    check('每只猫最多 1 张 best', multiBest.length === 0, multiBest.join(','));
    const cntMismatch = cats.filter((c) => (bestByCat[c._id] || 0) !== c.photo_count_best);
    check('photo_count_best 与 best 张数一致', cntMismatch.length === 0, cntMismatch.map((c) => `${c.name} ${c.photo_count_best}vs${bestByCat[c._id] || 0}`).join(','));
    const totalMismatch = cats.filter((c) => (photoCountByCat[c._id] || 0) !== c.photo_count_total);
    check('photo_count_total 与照片数一致', totalMismatch.length === 0, totalMismatch.map((c) => `${c.name} ${c.photo_count_total}vs${photoCountByCat[c._id] || 0}`).join(','));
    // 取头像链路：getBestPhoto 用 { cat_id, verified:true, best:true }, sort mdate:-1
    const first = cats[0];
    const avatar = (await db.collection('photo').find({ cat_id: first._id, verified: true, best: true }, { sort: { mdate: -1 } })).result;
    check('头像查询（best:true）能取到', avatar.length === 1, `${first.name} ${avatar.length} 张`);
    check('相册按 shooting_date 倒序不报错',
      (await db.collection('photo').find({ cat_id: first._id, verified: true }, { sort: { shooting_date: -1 } })).result.length > 0);
  }

  console.log('\n【空表安全（演示数据已清空，查询不能报错）】');
  {
    const empties = ['comment', 'rating', 'feedback', 'news', 'adoption', 'inter',
      'achievement', 'reward', 'photo_rank', 'inbox_log', 'review_queue', 'user'];
    for (const t of empties) {
      let ok = false;
      let n = 0;
      try {
        const r = await db.collection(t).find({});
        ok = Array.isArray(r.result);
        n = ok ? r.result.length : 0;
      } catch (e) {
        ok = false;
      }
      check(`${t} 可查询`, ok, `${n} 条`);
    }
  }

  console.log('\n【便利贴 / comment】');
  {
    const r = await db.collection('comment').find({ deleted: { $ne: true } }, { sort: { create_date: -1 }, limit: 10 });
    check('commentBoard 查询不报错', Array.isArray(r.result), `${r.result.length} 条`);
    const bad = r.result.filter((c) => !catById[c.cat_id]);
    check('便利贴的 cat_id 都能对应到猫', bad.length === 0);
  }

  console.log('\n【评分 / rating】');
  {
    const rs = (await db.collection('rating').find({})).result;
    check('rating 集合每条都有 cat_id + 五维', rs.every((r) => r.cat_id && [r.r1, r.r2, r.r3, r.r4, r.r5].every((v) => v >= 1 && v <= 5)));
    const bad = rs.filter((r) => !catById[r.cat_id]);
    check('rating 的 cat_id 都能对应到猫', bad.length === 0);
  }

  console.log('\n【排行榜 / photo_rank】');
  {
    const liked = await db.collection('photo').find({ like_count: { $gte: 1 } }, { sort: { like_count: -1 }, limit: 7 });
    check('排行榜查询不报错', Array.isArray(liked.result));
    check('按点赞数倒序', liked.result.every((x, i, a) => i === 0 || a[i - 1].like_count >= x.like_count));
    const pr = (await db.collection('photo_rank').find({}, { sort: { mdate: -1 }, limit: 1 })).result;
    if (pr.length) {
      const stat = pr[0].stat || {};
      const openids = Object.keys(stat);
      const us = openids.length ? (await db.collection('user').find({ openid: { $in: openids } })).result : [];
      check('stat 的 openid 都能在 user 找到', us.length === openids.length, `${us.length}/${openids.length}`);
    } else {
      check('photo_rank 为空时不报错（排行榜显示空态）', true);
    }
  }

  console.log('\n【新闻 / news】');
  {
    const list = (await db.collection('news').find({}, { sort: { date: -1 } })).result;
    check('新闻列表查询不报错', Array.isArray(list), `${list.length} 条`);
    check('每条 photosPath 都是数组', list.every((n) => Array.isArray(n.photosPath)));
    check('每条 show 都是布尔', list.every((n) => typeof n.show === 'boolean'));
  }

  console.log('\n【反馈 / feedback】');
  {
    const all = (await db.collection('feedback').find({})).result;
    check('feedback 查询不报错', Array.isArray(all), `${all.length} 条`);
    check('有数据时 _openid 与 openid 都在（我的反馈页/管理端各用一个）',
      all.every((f) => f._openid !== undefined && f.openid !== undefined));
    check('repliable 均为布尔', all.every((f) => typeof f.repliable === 'boolean'));
  }

  console.log('\n【打赏 / reward】');
  {
    const r = (await db.collection('reward').find({}, { sort: { mdate: -1 } })).result;
    check('reward 查询不报错', Array.isArray(r), `${r.length} 条`);
    let splitOk = true;
    for (const x of r) {
      if (typeof x.records !== 'string') {
        splitOk = false;
        break;
      }
      const parts = x.records.replace(/^#+|#+$/g, '').split('#');
      if (!parts.length || parts.some((p) => !p)) splitOk = false;
    }
    check('records 能被页面 replace/split 正确处理', splitOk);
  }

  console.log('\n【成就 / achievement】');
  {
    const a = (await db.collection('achievement').find({})).result;
    check('achievement 查询不报错', Array.isArray(a), `${a.length} 条`);
    check('每条有 key 和 create_date', a.every((x) => x.key && x.create_date));
  }

  console.log('\n【审核队列 / review_queue】');
  {
    const q = (await db.collection('review_queue').find({ status: 'pending' })).result;
    check('review_queue 查询不报错', Array.isArray(q), `${q.length} 条`);
    check('每条 data.cat_id 与 openid 都在', q.every((x) => x.data && x.data.cat_id && x.openid));
  }

  console.log('\n【用户 / user】');
  {
    const r = (await db.collection('user').find({ manager: 99 })).result;
    check('管理员查询不报错', Array.isArray(r), `manager=99 共 ${r.length} 个`);
    const all = (await db.collection('user').find({})).result;
    check('每条有 openid 与 userInfo.nickName', all.every((u) => u.openid && u.userInfo && u.userInfo.nickName));
    // 空表时 datasource 会把首个访客设为 manager=99，这是预期引导，不算缺陷
    check('user 为空或存在真实账号', all.length === 0 || all.every((u) => !String(u._id).startsWith('demo-user-')));
  }

  console.log('\n【审核态开关 / app-config】');
  {
    const cfg = (await db.collection('app-config').findOne({ _id: 'app-config' })).result;
    check('app-config 存在且可查询', !!cfg);
    check('reviewVersions 是数组', !!cfg && Array.isArray(cfg.reviewVersions), cfg && JSON.stringify(cfg.reviewVersions));
    check('reviewVersions 元素都是非空字符串',
      !!cfg && cfg.reviewVersions.every((v) => typeof v === 'string' && v.trim()),
      cfg && JSON.stringify(cfg.reviewVersions));
    // 空数组 = 正常期。这条是提醒：提交前别忘了确认当前处于哪个状态
    check('当前处于正常期（reviewVersions 为空）',
      !!cfg && cfg.reviewVersions.length === 0,
      cfg && `当前 ${cfg.reviewVersions.length} 个白名单版本${cfg.reviewVersions.length ? '→审核态！' : ''}`);
  }

  // ---------------------------------------------------------------- 汇总
  const bad = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(50));
  console.log(`共 ${results.length} 项检查，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  if (bad.length) {
    console.log('\n失败项：');
    bad.forEach((b) => console.log('  - ' + b.name + (b.detail ? '（' + b.detail + '）' : '')));
    process.exitCode = 1;
  }

  // 清理临时文件
  try {
    fs.unlinkSync(tmpFile);
  } catch (e) {}
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});
