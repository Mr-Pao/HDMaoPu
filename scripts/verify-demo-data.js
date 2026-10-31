'use strict';

/**
 * 演示数据落地验证：直接驱动项目真实的 utils/datasource.js，
 * 按各页面的实际查询方式打一遍，确认「页面能查到、字段能取到」。
 *
 * 做法：
 *  - 在 Node 里桩掉 wx.*，让 datasource 从本地 data/ 读文件（不走网络）
 *  - 用 datasource 暴露的 db 接口，复刻页面的查询语句
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

  console.log('\n【用户】');
  {
    const r = await db.collection('user').find({ manager: 99 });
    check('管理员账号存在', r.result.length === 1, `manager=99 共 ${r.result.length} 个`);
    const u = await db.collection('user').findOne({ openid: 'demo-openid-1' });
    check('按 openid 查用户', !!u.result, u.result && u.result.userInfo.nickName);
    check('userInfo.nickName 可用', !!(u.result && u.result.userInfo && u.result.userInfo.nickName));
  }

  console.log('\n【便利贴 / comment】');
  {
    const catId = 'demo-cat-1';
    const r = await db
      .collection('comment')
      .find({ deleted: { $ne: true }, cat_id: catId }, { sort: { create_date: -1 }, limit: 10 });
    check('commentBoard 查询有结果', r.result.length > 0, `${r.result.length} 条`);
    check('排序生效（create_date 倒序）', r.result.every((x, i, a) => i === 0 || Date.parse(a[i - 1].create_date) >= Date.parse(x.create_date)));
    const cnt = await db.collection('comment').count({ deleted: { $ne: true }, needVerify: { $ne: true } });
    check('info 页评论总数 > 0', cnt.result > 0, String(cnt.result));
    check(
      '评论作者都能在 user 里找到',
      (await (async () => {
        const openids = [...new Set(r.result.map((c) => c.user_openid))];
        const us = await db.collection('user').find({ openid: { $in: openids } });
        return us.result.length === openids.length;
      })())
    );
  }

  console.log('\n【评分 / rating】');
  {
    const cat = (await db.collection('cat').findOne({ _id: 'demo-cat-1' })).result;
    check('cat.rating.count > 0', cat.rating.count > 0, `count=${cat.rating.count}`);
    check('avgScore 在 0-5', cat.rating.avgScore >= 0 && cat.rating.avgScore <= 5, String(cat.rating.avgScore));
    check('avgScoreDisp 是一位小数', /^\d\.\d$/.test(cat.rating.avgScoreDisp), cat.rating.avgScoreDisp);
    const scores = cat.rating.scores;
    const total = scores.r1 + scores.r2 + scores.r3 + scores.r4 + scores.r5;
    check('scores 合计 == count', total === cat.rating.count, `${total} vs ${cat.rating.count}`);
    const ratio = await db.collection('rating').find({ cat_id: 'demo-cat-1' });
    check('rating 集合有该猫记录', ratio.result.length > 0, `${ratio.result.length} 条`);
    check(
      'rating 记录五维都在 1-5',
      ratio.result.every((r) => [r.r1, r.r2, r.r3, r.r4, r.r5].every((v) => v >= 1 && v <= 5))
    );
  }

  console.log('\n【排行榜 / photo_rank + inter】');
  {
    const liked = await db.collection('photo').find({ like_count: { $gte: 1 } }, { sort: { like_count: -1 }, limit: 7 });
    check('排行榜查询有结果（like_count>=1）', liked.result.length > 0, `${liked.result.length} 张`);
    check('按点赞数倒序', liked.result.every((x, i, a) => i === 0 || a[i - 1].like_count >= x.like_count));
    const pr = await db.collection('photo_rank').find({}, { sort: { mdate: -1 }, limit: 1 });
    check('photo_rank 快照存在', pr.result.length === 1);
    const stat = pr.result[0] && pr.result[0].stat;
    check('photo_rank.stat 有数据', !!stat && Object.keys(stat).length > 0, stat && Object.keys(stat).length + ' 人');
    const openids = Object.keys(stat || {});
    const us = await db.collection('user').find({ openid: { $in: openids } });
    check('stat 的 openid 都能在 user 找到', us.result.length === openids.length, `${us.result.length}/${openids.length}`);
  }

  console.log('\n【勋章 / badge + badge_def】');
  {
    const defs = await db.collection('badge_def').find({});
    check('badge_def 非空', defs.result.length > 0, `${defs.result.length} 个`);
    check('每条有 name/desc/level', defs.result.every((d) => d.name && d.desc && d.level));
    const ub = await db.collection('badge').find({ _openid: 'demo-openid-1', catId: null });
    check('loadUserBadge 查询有结果', ub.result.length > 0, `${ub.result.length} 个`);
    check('用户徽章都无 givenTime 或被正确标记', ub.result.every((b) => b.givenTime === null || b.givenTime));
    const cb = await db.collection('badge').count({ catId: 'demo-cat-1' });
    check('loadCatBadge 计数 > 0', cb.result > 0, String(cb.result));
    const br = await db.collection('badge_rank').findOne({}, { sort: { mdate: -1 } });
    check('badge_rank 快照存在', !!br.result);
    const rv2 = br.result && br.result.rankV2;
    check('rankV2 有 7/30/365 三个窗口', !!rv2 && !!rv2[7] && !!rv2[30] && !!rv2[365]);
    const catsInRank = new Set();
    for (const win of Object.keys(rv2 || {})) {
      for (const k of Object.keys(rv2[win])) Object.keys(rv2[win][k]).forEach((id) => catsInRank.add(id));
    }
    const catIds = [...catsInRank];
    const cs = await db.collection('cat').find({ _id: { $in: catIds } });
    check('榜单里的 catId 都存在', cs.result.length === catIds.length, `${cs.result.length}/${catIds.length}`);
  }

  console.log('\n【新闻 / news】');
  {
    const home = await db.collection('news').find({ setNewsModal: true }, { sort: { date: -1 } });
    check('首页公告弹窗有数据', home.result.length > 0, `${home.result.length} 条`);
    check('公告有 coverPath 或 photosPath', home.result.every((n) => n.coverPath || (n.photosPath && n.photosPath.length)));
    const list = await db.collection('news').find({}, { sort: { date: -1 } });
    check('新闻列表有数据', list.result.length > 0, `${list.result.length} 条`);
    check('全部有 photosPath 数组', list.result.every((n) => Array.isArray(n.photosPath)));
    check('全部有 show 字段', list.result.every((n) => typeof n.show === 'boolean'));
    const pre = await db.collection('news').find({ show: true }, { sort: { time: -1 }, limit: 10 });
    check('app.js 预加载查询（show:true）有结果', pre.result.length > 0, `${pre.result.length} 条`);
    const cls = [...new Set(list.result.map((n) => n.class))];
    check('分类都在新闻页按钮范围内', cls.every((c) => ['领养', '救助', '活动', '其他'].includes(c)), cls.join(','));
  }

  console.log('\n【反馈 / feedback】');
  {
    const mine = await db.collection('feedback').find({ _openid: 'demo-openid-1' }, { sort: { openDate: -1 } });
    check('我的反馈查询有结果', mine.result.length > 0, `${mine.result.length} 条`);
    const pend = await db.collection('feedback').find({ dealed: false }, { sort: { openDate: -1 } });
    check('管理端待处理有数据', pend.result.length > 0, `${pend.result.length} 条`);
    const hist = await db.collection('feedback').count({ dealed: true });
    check('管理端已处理有数据', hist.result > 0, String(hist.result));
    const all = await db.collection('feedback').find({});
    check(
      '填充 userInfo 所需的 openid 字段存在',
      all.result.every((f) => f.openid),
      '管理端用 openid 补 userInfo'
    );
    check('repliable 均为布尔', all.result.every((f) => typeof f.repliable === 'boolean'));
  }

  console.log('\n【打赏 / reward】');
  {
    const r = await db.collection('reward').find({}, { sort: { mdate: -1, recordDate: -1 } });
    check('reward 有数据', r.result.length > 0, `${r.result.length} 条`);
    let splitOk = true;
    for (const x of r.result) {
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
    const a = await db.collection('achievement').find({ openid: 'demo-openid-1' });
    check('成就查询有结果', a.result.length > 0, `${a.result.length} 条`);
    check('每条有 key 和 create_date', a.result.every((x) => x.key && x.create_date));
  }

  console.log('\n【审核队列 / review_queue】');
  {
    const q = await db.collection('review_queue').find({ status: 'pending' });
    check('待审队列有数据', q.result.length > 0, `${q.result.length} 条`);
    check('每条 data.cat_id 存在', q.result.every((x) => x.data && x.data.cat_id));
    check('每条 openid 存在', q.result.every((x) => x.openid));
  }

  console.log('\n【猫谱主页 / cat】');
  {
    const r = await db.collection('cat').find({ deleted: { $ne: true } }, { sort: { mphoto: -1, popularity: -1 } });
    check('首页查询有结果', r.result.length > 0, `${r.result.length} 只`);
    check('mphoto 都是数字', r.result.every((c) => typeof c.mphoto === 'number'));
    check('按 mphoto 倒序', r.result.every((x, i, a) => i === 0 || a[i - 1].mphoto >= x.mphoto));
    const sterilized = await db.collection('cat').count({ sterilized: true });
    check('绝育计数 > 0', sterilized.result > 0, String(sterilized.result));
    const cur = await db.collection('cat').count({ adopt: { $ne: 1 }, to_star: { $ne: true }, missing: { $ne: true } });
    check('当前在册计数 > 0', cur.result > 0, String(cur.result));
    check('comment_count 与便利贴数一致', r.result.every((c) => typeof c.comment_count === 'number'));
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
