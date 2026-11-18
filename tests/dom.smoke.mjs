// 真实页面 DOM 冒烟测试（可选，需要先安装 jsdom：npm i --no-save jsdom，并在 8765 端口起静态服务）
// 运行：python3 -m http.server 8765 然后 node tests/dom.smoke.mjs
import { JSDOM } from 'jsdom';
import http from 'node:http';

const BASE = 'http://localhost:8765/';
const errors = [];
const consoleErrors = [];

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: BASE + 'index.html',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
// 让应用模块里的全局 document/window 等指向 jsdom
global.window = window;
global.document = window.document;
try { Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true }); } catch {}
global.HTMLElement = window.HTMLElement;
global.Event = window.Event;
global.FileReader = window.FileReader;
global.Blob = window.Blob;

// jsdom / Node 全局 fetch 都换成走本地 http 服务器的最小实现
const localFetch = (u) => new Promise((resolve, reject) => {
  const url = new URL(u, BASE);
  http.get(url, (r) => {
    let data = '';
    r.on('data', (c) => (data += c));
    r.on('end', () => resolve({ ok: r.statusCode === 200, text: async () => data, json: async () => JSON.parse(data) }));
  }).on('error', reject);
});
window.fetch = localFetch;
global.fetch = localFetch;
window.console.error = (...a) => consoleErrors.push(a.join(' '));
window.addEventListener('error', (e) => errors.push(e.message));

// 读取真实 index.html，把 body 结构铺进 jsdom（boot 依赖这些元素 id）
const indexHtml = await (await fetch(BASE + 'index.html')).text();
window.document.documentElement.setAttribute('data-theme', 'light');
window.document.body.innerHTML = indexHtml.split('<body>')[1].split('</body>')[0];

// app.js 依赖 document DOMContentLoaded；这里直接 import 本地源码并手动触发
await import('../js/ui/app.js');
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));

// 等待异步 fetch 样例 + 渲染
await new Promise((r) => setTimeout(r, 1200));

const doc = window.document;
const results = {
  kpiCards: doc.querySelectorAll('.kpi').length,
  tabs: [...doc.querySelectorAll('.tab')].map(t => t.textContent.trim()),
  containerItems: doc.querySelectorAll('.container-item').length,
  monthCells: doc.querySelectorAll('.month-cell').length,
  overviewRows: doc.querySelectorAll('table.data tbody tr').length,
  consoleErrors,
  pageErrors: errors,
};

// 切到待处理页
const conflictTab = [...doc.querySelectorAll('.tab')].find(t => t.textContent.includes('待处理'));
conflictTab && conflictTab.click();
await new Promise((r) => setTimeout(r, 200));
results.conflictCards = doc.querySelectorAll('.conflict-card').length;
results.unresolvedBadges = [...doc.querySelectorAll('.conflict-card .badge')].filter(b => b.textContent.includes('待处理')).length;

// 选中 001 看单箱详情
const item = [...doc.querySelectorAll('.container-item')].find(i => i.textContent.includes('CSLU2000001'));
item && item.click();
await new Promise((r) => setTimeout(r, 200));
results.timelineBars = doc.querySelectorAll('.tl-seg').length;
results.timelineEvents = doc.querySelectorAll('.tl-event').length;
results.feeRows = doc.querySelectorAll('table.data tbody tr').length;
results.hasAgreementPanel = [...doc.querySelectorAll('.card h2')].some(h => h.textContent.includes('协议 A001'));

// 处理一个口径冲突
const basisTab = [...doc.querySelectorAll('.tab')].find(t => t.textContent.includes('待处理'));
basisTab && basisTab.click();
await new Promise((r) => setTimeout(r, 150));
const basisCard = [...doc.querySelectorAll('.conflict-card')].find(c => c.textContent.includes('口径'));
if (basisCard) {
  const btn = [...basisCard.querySelectorAll('button')].find(b => b.textContent.includes('自然日'));
  btn && btn.click();
  await new Promise((r) => setTimeout(r, 300));
  // 裁定后切到该箱详情，确认其费用状态不再挂起
  const target = [...doc.querySelectorAll('.container-item')].find(i => i.textContent.includes('CSLU2000011'));
  target && target.click();
  await new Promise((r) => setTimeout(r, 200));
  const heldBadge = [...doc.querySelectorAll('.badge.held')].find(x => x.closest('.card'));
  results.afterResolveBasisStillHeld = !!heldBadge;
  results.afterResolveBasisNet = doc.body.textContent.includes('¥126.00');
}

console.log(JSON.stringify(results, null, 2));
const fail = [];
if (results.kpiCards !== 5) fail.push('KPI 卡片数量应为 5');
if (results.containerItems < 13) fail.push('应列出至少 13 个集装箱');
if (results.overviewRows < 13) fail.push('总览表应有至少 13 行');
if (results.timelineBars === 0) fail.push('时间线应渲染费用条带');
if (results.timelineEvents < 3) fail.push('时间线应渲染事件标记');
if (results.afterResolveBasisStillHeld !== false) fail.push('口径冲突裁定后不应再费用挂起');
if (results.afterResolveBasisNet !== true) fail.push('口径裁定后应显示重算金额 ¥126.00');
if (results.consoleErrors.length) fail.push('存在 console.error: ' + results.consoleErrors.join(' | '));
if (results.pageErrors.length) fail.push('存在页面错误: ' + results.pageErrors.join(' | '));
if (fail.length) { console.error('SMOKE FAIL:', fail); process.exit(1); }
console.log('SMOKE PASS');
