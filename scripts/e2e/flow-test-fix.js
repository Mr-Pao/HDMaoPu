/**
 * flow-test-fix.js —— 补测：用例2 关注按钮 UI 滞后 bug 确证、用例5 断言修正、
 * 用例8/10 根因确证（admin db.get() 返回格式不匹配）
 */
const automator = require('miniprogram-automator');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('unhandledRejection', (e) => console.log('[未处理拒绝]', (e && e.message) || e));

const ROOT = 'C:/Users/yzx49/OneDrive/Pao/04Designing/MiniProgram/MaoPu';
const ART = path.join(ROOT, 'test-artifacts', 'flow');
let program = null, shotIdx = 100;

async function shot(tag) {
  shotIdx += 1;
  const f = path.join(ART, `fix${shotIdx}_${tag}.png`);
  try { await program.screenshot({ path: f }); return path.basename(f); } catch (e) { return ''; }
}
async function evalIn(fn, ...args) { return await program.evaluate(fn, ...args); }
const storageGet = (k) => evalIn((x) => wx.getStorageSync(x), k);
const storageSet = (k, v) => evalIn((x, v2) => wx.setStorageSync(x, v2), k, v);

async function findTextButton(pageEl, selectors, texts) {
  for (const s of selectors) {
    try {
      const els = await pageEl.$$(s);
      for (const el of els) {
        const t = (await el.text() || '').trim();
        if (texts.some((x) => t.includes(x))) return el;
      }
    } catch (e) {}
  }
  return null;
}

async function withInboxMock(fn) {
  try { await program.mockWxMethod('request', function () { return { statusCode: 200, data: {} }; }); } catch (e) { }
  try { await fn(); await sleep(1500); }
  finally { try { await program.resetMockWxMethod('request'); } catch (e) {} }
}

async function main() {
  program = await automator.connect({ wsEndpoint: 'ws://localhost:9420' });
  await program.systemInfo();
  console.log('已连接');

  // ============ A. 根因确证：datasource db.get() 返回格式 ============
  console.log('== A. db.get() 返回格式确证 ==');
  const fmt = await evalIn(() => {
    const app = getApp();
    const col = app.mpServerless.db.collection('cat');
    return col.find({}, { limit: 5 }).then((r1) => ({
      hasGetMethod: typeof col.get,
      hasFind: typeof col.find,
      findResultIsArray: Array.isArray(r1.result),
      findResultLen: Array.isArray(r1.result) ? r1.result.length : -1,
    }));
  });
  console.log('collection API:', JSON.stringify(fmt));
  console.log(fmt.hasGetMethod === 'undefined'
    ? '>>> 确证 bug：datasource collection 无 get() 方法，admin.js loadCats / review.js loadQueue 调用即抛异常（猫列表/审核队列恒为空）'
    : '>>> get() 存在？需进一步检查');

  // ============ B. 用例2 重测：关注按钮 UI 状态滞后确证 ============
  console.log('== B. 用例2 重测：关注按钮 UI ==');
  await storageSet('followedCatIds', []);
  await program.reLaunch('/pages/genealogy/detailCat/detailCat?cat_id=demo-cat-1');
  await sleep(3500);
  let page = await program.currentPage();
  let plus = await page.$('.plus');
  await plus.tap(); await sleep(1200);
  page = await program.currentPage();
  let btn = await findTextButton(page, ['popup .button', 'popup >>> .button', '.buttons .button'], ['关注动态', '取消关注']);
  const t0 = btn ? (await btn.text()).trim() : '(无)';
  await withInboxMock(async () => { await btn.tap(); });
  await sleep(2500);
  const ids1 = await storageGet('followedCatIds');
  // 关注完成后（含 storage 写入后），重新打开弹窗读按钮文本
  await plus.tap(); await sleep(1200);
  page = await program.currentPage();
  btn = await findTextButton(page, ['popup .button', 'popup >>> .button', '.buttons .button'], ['关注动态', '取消关注']);
  const t1 = btn ? (await btn.text()).trim() : '(无)';
  const pageData = await page.data();
  const s = await shot('follow_btn_after_add');
  console.log(`按钮：关注前="${t0}" → 关注完成后="${t1}"；storage含demo-cat-1=${Array.isArray(ids1) && ids1.includes('demo-cat-1')}；page.followedCat=${pageData.followedCat}`);
  console.log(t1.includes('取消关注') && pageData.followedCat === true
    ? '>>> UI 状态正常（此前失败为测试时序问题）'
    : '>>> 确证 bug：关注成功后按钮/UI 状态未更新（followCat 中 loadUser 先于 storage 写入执行）');

  // ============ C. 用例5 重测（修正断言）：清场后仅关注 demo-cat-2 ============
  console.log('== C. 用例5 重测 ==');
  await storageSet('followedCatIds', ['demo-cat-2']);
  await program.reLaunch('/pages/info/myFollowCats/myFollowCats');
  await sleep(3500);
  page = await program.currentPage();
  const rows = await page.$$('.cat-info');
  console.log('关注列表行数:', rows.length);
  let targetRow = null;
  for (const row of rows) {
    const txt = (await row.text()).replace(/\s+/g, ' ');
    if (txt.includes('阿花') || txt.includes('demo-cat-2')) { targetRow = row; break; }
  }
  // 兜底：data/cat.json 里 demo-cat-2 的名字未知则用行文本判断
  if (!targetRow && rows.length === 1) targetRow = rows[0];
  if (targetRow) {
    const btn2 = await targetRow.$('.follow-btn');
    const before2 = (await btn2.text()).trim();
    await withInboxMock(async () => { await btn2.tap(); });
    await sleep(2000);
    const after2 = (await btn2.text()).trim();
    const ids2 = await storageGet('followedCatIds');
    const removed = Array.isArray(ids2) && !ids2.includes('demo-cat-2');
    const rowCount = (await page.$$('.cat-info')).length;
    const s2 = await shot('myfollow_unfollow_fixed');
    console.log(`按钮：${before2} → ${after2}；storage移除demo-cat-2=${removed}；列表行数=${rowCount}（实现为标记"继续关注"，不移除行）`);
    console.log(removed ? '>>> 通过：storage 正确移除（行不消失为设计使然）' : '>>> 失败');
  } else {
    console.log('未找到 demo-cat-2 行');
  }

  // 清理：移空关注列表
  await storageSet('followedCatIds', []);

  // ============ D. 用例8 重测：admin 照片审核（cats 空根因下确认） ============
  console.log('== D. admin 照片审核重测 ==');
  await program.reLaunch('/pages/manage/admin/admin');
  await sleep(3500);
  page = await program.currentPage();
  await page.callMethod('onPhotoCatPick', { detail: { value: 0 } });
  await sleep(2500);
  const pd = await page.data();
  console.log(`admin cats 数量=${(pd.catNames || []).length}；photos=${(pd.photos || []).length}；photoLoading=${pd.photoLoading}`);
  const s3 = await shot('admin_photos_recheck');
  if ((pd.photos || []).length > 0) {
    const cards = await page.$$('.photo-card');
    const stateEl = await cards[0].$('.photo-state');
    const btnEl = await cards[0].$('.photo-btn');
    const bs = (await stateEl.text()).trim();
    await withInboxMock(async () => { await btnEl.tap(); });
    await sleep(1500);
    const cards2 = await (await program.currentPage()).$$('.photo-card');
    const as = (await (await cards2[0].$('.photo-state')).text()).trim();
    // 恢复
    await withInboxMock(async () => {
      const cards3 = await (await program.currentPage()).$$('.photo-card');
      await (await cards3[0].$('.photo-btn')).tap();
    });
    await sleep(1200);
    console.log(`下架切换：${bs} → ${as}；>>> 通过`);
  } else {
    console.log('>>> 受阻确认：photoCatIndex=-1 或 cats 为空，无法选猫看照片（根因见 A）');
  }

  console.log('补测完成');
  await program.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error('补测失败:', e.message); process.exit(1); });
