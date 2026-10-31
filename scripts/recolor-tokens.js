#!/usr/bin/env node
/**
 * 把 wxss 里散落的中性色硬编码收敛到 app.wxss 的设计 token。
 *
 * 只动「中性灰阶」和「白」，不动语义色（红/黄/勋章色/微信链接蓝），
 * 因为语义色换个名字反而更难读，而且页面里往往靠它们区分状态。
 *
 * 用法：
 *   node scripts/recolor-tokens.js           # 直接改写
 *   node scripts/recolor-tokens.js --dry-run # 只统计
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const DRY = process.argv.includes('--dry-run');

// 顺序很重要：先长后短，避免 #ffffff 被 #fff 的规则切走一半
const MAP = [
  ['#ffffff', 'var(--color-surface)'],
  ['#fff', 'var(--color-surface)'],
  ['#fafafa', 'var(--color-white-dark)'],
  ['#f8f8f8', 'var(--color-gray-light)'],
  ['#f7f7fa', 'var(--color-gray-light)'],
  ['#f7f7f7', 'var(--color-gray-light)'],
  ['#f5f5f5', 'var(--color-bg)'],
  ['#eeeeee', 'var(--color-border)'],
  ['#ececec', 'var(--color-border)'],
  ['#e5e5e5', 'var(--color-border)'],
  ['#dddddd', 'var(--color-border)'],
  ['#ddd', 'var(--color-border)'],
  ['#999999', 'var(--color-text-tertiary)'],
  ['#999', 'var(--color-text-tertiary)'],
  ['#888888', 'var(--color-gray-max)'],
  ['#888', 'var(--color-gray-max)'],
  ['#666666', 'var(--color-text-secondary)'],
  ['#666', 'var(--color-text-secondary)'],
  ['#333333', 'var(--color-text)'],
  ['#333', 'var(--color-text)'],
  ['#222222', 'var(--color-black-light)'],
  ['#222', 'var(--color-black-light)'],
];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.wxss')) out.push(p);
  }
  return out;
}

let totalHits = 0;
let totalFiles = 0;
const report = [];

// app.wxss 是这些 token 的定义处，绝不能参与替换——
// 否则 --color-gray-light: #f7f7fa 会被改成自引用，变量直接失效。
const SKIP = new Set([path.join(ROOT, 'app.wxss')]);

for (const file of walk(ROOT, [])) {
  if (SKIP.has(file)) continue;
  let css = fs.readFileSync(file, 'utf8');
  const before = css;
  let hits = 0;

  for (const [hex, token] of MAP) {
    // 只匹配独立的色值：前面不能是 (# 或字母数字)，后面不能紧跟十六进制字符。
    // 这样 #fff 不会误伤 #fff7ee 这类带语义的浅色。
    const re = new RegExp(hex.replace('#', '#') + '(?![0-9a-fA-F])', 'gi');
    css = css.replace(re, (m) => {
      hits++;
      return token;
    });
  }

  if (css !== before) {
    totalHits += hits;
    totalFiles++;
    const rel = path.relative(path.join(__dirname, '..'), file);
    report.push(`  ${rel}  ${hits} 处`);
    if (!DRY) fs.writeFileSync(file, css, 'utf8');
  }
}

report.sort();
console.log(report.join('\n'));
console.log(`\n${DRY ? '[dry-run] ' : ''}涉及 ${totalFiles} 个文件，共替换 ${totalHits} 处中性色`);
