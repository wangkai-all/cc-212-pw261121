// 引擎测试（node tests/engine.test.js），不依赖任何第三方库
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCSV, toISO } from '../js/engine/util.js';
import { normalizeEvent, normalizeAdjustment, normalizeAgreement } from '../js/engine/models.js';
import { buildState, compareRevision } from '../js/engine/pipeline.js';
import { computeBilling } from '../js/engine/billing.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const AS_OF = new Date('2026-11-18T12:00:00Z');

const events = parseCSV(readFileSync(join(root, 'data/events.csv'), 'utf8'))
  .map((row, i) => normalizeEvent(row, i + 2));
const adjustments = parseCSV(readFileSync(join(root, 'data/adjustments.csv'), 'utf8'))
  .map((row, i) => normalizeAdjustment(row, i + 2));
const agreements = JSON.parse(readFileSync(join(root, 'data/agreements.json'), 'utf8')).map(normalizeAgreement);

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name); console.error('    ' + e.message); process.exitCode = 1; }
}

const state = buildState(events, adjustments, agreements, { asOf: AS_OF });
const billingOf = (containerNo, n = 0) => {
  const list = state.stays.filter(s => s.containerNo === containerNo);
  return state.billings.get(list[n].id);
};
const stayOf = (containerNo, n = 0) => state.stays.filter(s => s.containerNo === containerNo)[n];

console.log('占用重建：');

test('13 个箱共重建 13 段占用（2000013 两段，2000009 默认不产生占用）', () => {
  assert.equal(state.stays.length, 13);
});

test('重复进场生成 block 冲突且不会自动拼接新时段', () => {
  const c = state.conflicts.find(x => x.type === 'dup_gate_in' && x.containerNo === 'CSLU2000008');
  assert.ok(c);
  const stays8 = state.stays.filter(s => s.containerNo === 'CSLU2000008');
  assert.equal(stays8.length, 1);
  assert.equal(toISO(stays8[0].start), '2026-10-25T08:00:00Z');
});

test('先出后进生成 orphan 冲突，默认不产生占用段', () => {
  const c = state.conflicts.find(x => x.type === 'orphan_gate_out' && x.containerNo === 'CSLU2000009');
  assert.ok(c);
  assert.equal(state.stays.filter(s => s.containerNo === 'CSLU2000009').length, 0);
  // 即便没有占用段，该箱仍要出现在汇总列表，提示用户有待处理冲突
  assert.ok(state.containerSummaries.some(s => s.containerNo === 'CSLU2000009' && s.conflictCount > 0));
});

test('补录出场保留留痕（backfilled 标记 + 登记时间晚于事件时间）', () => {
  const s = stayOf('CSLU2000010');
  assert.equal(s.backfilled, true);
  assert.match(billingOf('CSLU2000010').warnings[0].text, /补录出场/);
});

test('未结束占用标记为在场预提', () => {
  const b = billingOf('CSLU2000007');
  assert.equal(b.provisional, true);
  assert.equal(b.status, 'provisional');
});

console.log('自然日口径（免费期/档位按协议版本各自起算，暂停不消耗免费期）：');

test('CSLU2000001 跨月+协议修订：v1 免费5/v2 免费7，共免费 12，计费 29，应收 1410', () => {
  const b = billingOf('CSLU2000001');
  assert.equal(b.basis, 'calendar_day');
  assert.equal(b.freeUnitsUsed, 12);
  assert.equal(b.pauseUnits, 0);
  assert.equal(b.billableUnits, 29);
  // 9 月 1 天@40；10 月 13 天@40 + 11 天@60；11 月 4 天@65（v2 第二档）
  assert.equal(b.months['2026-09'].net, 40);
  assert.equal(b.months['2026-10'].net, 1110);
  assert.equal(b.months['2026-11'].net, 260);
  assert.equal(b.netTotal, 1410);
});

test('CSLU2000002 箱型切换：免费期内为 20GP，计费日（25 日起）日首箱型均为 40GP', () => {
  const b = billingOf('CSLU2000002');
  assert.equal(b.billableUnits, 5);
  assert.equal(b.netTotal, 225);
  // 20GP 只存在于免费期；5 个计费日全部在 10-20 改箱之后，按 40GP 计费
  assert.deepEqual([...new Set(b.segments.map(s => s.containerType))], ['40GP']);
  const stay = stayOf('CSLU2000002');
  assert.equal(stay.typeTimeline.length, 2);
  assert.equal(stay.typeTimeline[0].type, '20GP');
  assert.equal(stay.typeTimeline[1].type, '40GP');
});

test('CSLU2000003 恰好 7 自然日全免，账单为 0', () => {
  const b = billingOf('CSLU2000003');
  assert.equal(b.status, 'zero_fee');
  assert.equal(b.freeUnitsUsed, 7);
  assert.equal(b.billableUnits, 0);
  assert.equal(b.netTotal, 0);
});

test('CSLU2000004 跨月：11 月 13 计费单位、12 月 1 单位且 12 月费率进第二档', () => {
  const b = billingOf('CSLU2000004');
  assert.equal(b.billableUnits, 14); // 21 天 - 7 免费
  assert.equal(b.months['2026-11'].net, 645);
  assert.equal(b.months['2026-12'].units, 1);
  assert.equal(b.months['2026-12'].net, 65); // 第 14 计费单位落在 65 元档
});

test('CSLU2000005 暂停 4 天剔除不消耗免费期 + 3 天减半：净收 157.50', () => {
  const b = billingOf('CSLU2000005');
  assert.equal(b.pauseUnits, 4);
  assert.equal(b.freeUnitsUsed, 7);
  assert.equal(b.billableUnits, 5); // 16 - 4 - 7
  assert.equal(b.grossTotal, 225);
  assert.equal(b.discountTotal, 67.5); // 3×45×50%
  assert.equal(b.netTotal, 157.5);
});

test('CSLU2000013 两段独立计费，均落在免费期内', () => {
  const b0 = billingOf('CSLU2000013', 0);
  const b1 = billingOf('CSLU2000013', 1);
  assert.equal(b0.billableUnits, 0);
  assert.equal(b1.billableUnits, 0);
  assert.equal(b0.netTotal + b1.netTotal, 0);
});

test('与占用不相交的暂停产生预警且不影响金额', () => {
  const b = billingOf('CSLU2000003');
  assert.ok(b.warnings.some(w => w.code === 'pause_outside_stay'));
});

test('同日进出按 0 个自然日处理（出场当日不计）', () => {
  const b = billingOf('CSLU2000013', 1);
  assert.equal(b.freeUnitsUsed, 2); // 11-12、11-13
});

console.log('满 24 小时口径：');

test('CSLU2000006 滚动口径：免费 3 块、暂停剔除 1 块、全免 1 块，含第二档费率', () => {
  const b = billingOf('CSLU2000006');
  assert.equal(b.basis, 'rolling_24h');
  assert.equal(b.freeUnitsUsed, 3);
  assert.equal(b.pauseUnits, 1);
  assert.equal(b.billableUnits, 7);
  // 5 块@50（其中 1 块全免）+ 2 块@75 = 400，减免 50
  assert.equal(b.grossTotal, 400);
  assert.equal(b.discountTotal, 50);
  assert.equal(b.netTotal, 350);
  assert.ok(b.segments.some(s => s.rate === 75));
});

test('CSLU2000007 在场预提只认完整自然日（11-10→11-18：8 天，免费 7，唯一计费日为第 1 档 45）', () => {
  const b = billingOf('CSLU2000007');
  assert.equal(b.billableUnits, 1);
  assert.equal(b.segments[0].tierOrdinal, 1);
  assert.equal(b.segments[0].rate, 45);
  assert.equal(b.netTotal, 45);
});
test('两种口径不会在同一段占用内混算：CSLU2000011 费用挂起', () => {
  const b = billingOf('CSLU2000011');
  assert.equal(b.feeHeld, true);
  assert.equal(b.netTotal, 0);
  assert.match(b.holdReason, /口径/);
  assert.ok(state.conflicts.some(c => c.type === 'basis_switch' && c.containerNo === 'CSLU2000011'));
});

console.log('人工裁定与修订：');

test('口径冲突裁定为自然日后全段按自然日重算，无混算', () => {
  const s = stayOf('CSLU2000011');
  const cid = state.conflicts.find(c => c.type === 'basis_switch' && c.stayId === s.id).id;
  const resolved = buildState(events, adjustments, agreements, {
    asOf: AS_OF,
    resolutions: { [cid]: { resolution: { action: 'use_calendar_day', decidedAt: toISO(AS_OF), note: '测试裁定' } } },
  });
  const rs = resolved.stays.find(x => x.containerNo === 'CSLU2000011');
  const b = resolved.billings.get(rs.id);
  assert.equal(b.feeHeld, false);
  assert.equal(b.basis, 'calendar_day');
  assert.equal(b.basisSource, '人工裁定（口径冲突处理）');
  // 12 自然日：v1 免费 4（16~19）；v2 免费 5（20~24）后，25/26/27 三个计费日 @42
  assert.equal(b.billableUnits, 3);
  assert.equal(b.netTotal, 126);
});

test('重复进场裁定替换开始时间后重算', () => {
  const c = state.conflicts.find(x => x.type === 'dup_gate_in' && x.containerNo === 'CSLU2000008');
  const resolved = buildState(events, adjustments, agreements, {
    asOf: AS_OF,
    resolutions: { [c.id]: { resolution: { action: 'replace_start', decidedAt: toISO(AS_OF) } } },
  });
  const s = resolved.stays.find(x => x.containerNo === 'CSLU2000008');
  assert.equal(toISO(s.start), '2026-11-02T08:00:00Z');
  const b = resolved.billings.get(s.id);
  // 11-02 → 11-10：8 自然日，免费 7，计费 1 @45
  assert.equal(b.billableUnits, 1);
  assert.equal(b.netTotal, 45);
});

test('先出后进裁定补录占位后费用挂起待人工补进场', () => {
  const c = state.conflicts.find(x => x.type === 'orphan_gate_out' && x.containerNo === 'CSLU2000009');
  const resolved = buildState(events, adjustments, agreements, {
    asOf: AS_OF,
    resolutions: { [c.id]: { resolution: { action: 'backfill_pending', decidedAt: toISO(AS_OF) } } },
  });
  const s = resolved.stays.find(x => x.containerNo === 'CSLU2000009');
  assert.ok(s.needsManualStart);
  const b = resolved.billings.get(s.id);
  assert.equal(b.feeHeld, true);
});

test('协议修订差额可计算（A001 v1→v2 对 CSLU2000001 的追溯差额，本样例恰好抵消为 0）', () => {
  const v1 = agreements.find(a => a.agreement_id === 'A001' && a.version === 1);
  const v2 = agreements.find(a => a.agreement_id === 'A001' && a.version === 2);
  const syntheticV2 = { ...v2, billing_basis: 'calendar_day' };
  const cmp = compareRevision(state, stayOf('CSLU2000001').id, v1, syntheticV2);
  assert.ok(cmp.changes.some(c => c.field === '免费期（天）'));
  assert.ok(cmp.changes.some(c => c.field.startsWith('费率')));
  // 真实样例：费率上调与免费期增加相互抵消，差额为 0（页面如实展示而非强行制造差额）
  assert.equal(cmp.beforeBilling.netTotal, 1410);
  assert.equal(cmp.afterBilling.netTotal, 1410);
  assert.equal(cmp.amounts.delta, 0);
});

test('协议修订差额在费率单边变化时非零（合成激进修订可追溯）', () => {
  const v1 = agreements.find(a => a.agreement_id === 'A001' && a.version === 1);
  // 用一组合成协议族：旧版费率 40/60/80，新版免费期归零且统一 100，口径不变
  // 单版本协议族直接对比费率，不引入版本切换
  const oldFamily = [{ ...v1, supersedes_at: null }];
  const newFamily = [{
    ...v1, version: 9, free_days: 0, supersedes_at: null,
    rates: [{ type: '*', from_day: 1, rate: 100 }],
  }];
  const stay = stayOf('CSLU2000002');
  const before = computeBilling(stay, adjustments, oldFamily, { asOf: AS_OF });
  const after = computeBilling(stay, adjustments, newFamily, { asOf: AS_OF });
  assert.ok(after.netTotal > before.netTotal);
  assert.equal(after.netTotal - before.netTotal, after.netTotal - before.netTotal);
});

test('A004 分箱型费率：CSLU2000012 全部 20GP，费率 35 而非通用 50', () => {
  const b = billingOf('CSLU2000012');
  assert.equal(b.billableUnits, 3); // 8 天 - 5 免费
  assert.ok(b.segments.every(s => s.rate === 35));
  assert.equal(b.netTotal, 105);
});

console.log(`\n${passed} 项测试通过` + (process.exitCode ? '，存在失败！' : ''));
