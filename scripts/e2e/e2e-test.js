/**
 * e2e-test.js —— 微信小程序自动逐页测试
 * 用法：node scripts/e2e/e2e-test.js
 * 依赖：miniprogram-automator（项目根 node_modules，--no-save 安装）
 * 产物：test-artifacts/ 下每页截图 + e2e-report.json
 */
const automator = require('miniprogram-automator');
const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/yzx49/OneDrive/Pao/04Designing/MiniProgram/MaoPu';
const CLI = 'C:\\Users\\yzx49\\Program\\微信web开发者工具\\cli.bat';
const ART = path.join(ROOT, 'test-artifacts');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('unhandledRejection', (e) => console.log('[未处理拒绝]', (e && e.message) || e));

async function main() {
  const appJson = readJson(path.join(ROOT, 'miniprogram/app.json'));
  const pages = [...appJson.pages];
  for (const sp of appJson.subPackages || appJson.subpackages || []) {
    for (const p of sp.pages) pages.push(sp.root.replace(/\/$/, '') + '/' + p);
  }

  const cats = readJson(path.join(ROOT, 'data/cat.json')).items || [];
  const catId = cats[0] && cats[0]._id;
  let sciId = '';
  try { sciId = (readJson(path.join(ROOT, 'data/science.json')).items || [])[0]._id; } catch (e) {}

  const paramMap = {
    'genealogy/detailCat': catId ? `?id=${catId}` : '',
    'genealogy/ratingDetail': catId ? `?id=${catId}` : '',
    'genealogy/commentBoard': catId ? `?id=${catId}` : '',
    'news/sciDetail': sciId ? `?id=${sciId}` : '',
  };
  const getParam = (page) => {
    for (const k in paramMap) if (page.includes(k)) return paramMap[k];
    return '';
  };

  fs.mkdirSync(ART, { recursive: true });
  const report = [];
  console.log(`共 ${pages.length} 个页面，启动开发者工具并逐页测试...`);

  // 先手动开启自动化端口：
  // "C:\Users\yzx49\Program\微信web开发者工具\cli.bat" auto --project <项目根> --auto-port 9420
  // cli auto 返回后项目窗口仍需编译启动，这里带重试连接
  let program = null;
  for (let i = 1; i <= 12; i++) {
    try {
      program = await automator.connect({ wsEndpoint: 'ws://localhost:9420' });
      console.log(`已连接自动化端口（第 ${i} 次尝试）`);
      break;
    } catch (e) {
      console.log(`连接失败（第 ${i}/12 次）：${e.message.slice(0, 60)}，5 秒后重试...`);
      await sleep(5000);
    }
  }
  if (!program) throw new Error('无法连接自动化端口 ws://localhost:9420');
  // 探测项目就绪：轻量命令轮询直到有响应（IDE 冷启动可能要 1-2 分钟）
  for (let i = 1; i <= 24; i++) {
    try {
      await program.systemInfo();
      console.log(`项目就绪（第 ${i} 次探测）`);
      break;
    } catch (e) {
      console.log(`未就绪（第 ${i}/24 次探测），5 秒后重试...`);
      if (i === 24) throw new Error('项目长时间未就绪');
      await sleep(5000);
      // 超时后可能需要重新连接
      try { program = await automator.connect({ wsEndpoint: 'ws://localhost:9420' }); } catch (e2) {}
    }
  }

  const consoleLogs = [];
  program.on('console', (msg) => {
    consoleLogs.push({
      type: msg.type,
      args: (msg.args || []).map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 400),
    });
  });
  const exceptions = [];
  program.on('exception', (err) => {
    exceptions.push({ message: err.message, stack: (err.stack || '').slice(0, 400) });
  });

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const entry = { page, ok: false, errors: [], warnings: 0, exception: null };
    const c0 = consoleLogs.length;
    const e0 = exceptions.length;
    try {
      await program.reLaunch('/' + page + getParam(page));
      const p = await program.currentPage();
      await sleep(2500);
      entry.ok = !!p;
      entry.errors = consoleLogs.slice(c0).filter((l) => l.type === 'error').map((l) => l.args);
      entry.warnings = consoleLogs.slice(c0).filter((l) => l.type === 'warn').length;
      entry.exception = exceptions.slice(e0).map((e) => e.message).join('; ') || null;
      const shot = path.join(ART, String(i + 1).padStart(2, '0') + '_' + page.replace(/\//g, '_') + '.png');
      await program.screenshot({ path: shot }).catch(() => {});
    } catch (e) {
      entry.errors.push('NAV ERROR: ' + e.message);
    }
    report.push(entry);
    const flag = entry.ok && entry.errors.length === 0 && !entry.exception ? 'OK ' : 'ERR';
    console.log(`[${flag}] ${page}  errors=${entry.errors.length}${entry.exception ? ' exception=' + entry.exception.slice(0, 80) : ''}`);
  }

  fs.writeFileSync(path.join(ART, 'e2e-report.json'), JSON.stringify(report, null, 2));
  const bad = report.filter((r) => !r.ok || r.errors.length || r.exception);
  console.log('\n===== 汇总 =====');
  console.log(`总计 ${report.length} 页，异常页 ${bad.length}`);
  for (const b of bad) console.log('  ✗', b.page, '|', (b.errors[0] || b.exception || '').slice(0, 120));

  await program.close();
  process.exit(bad.length ? 2 : 0);
}

main().catch((e) => { console.error('E2E 失败:', e.message); process.exit(1); });
