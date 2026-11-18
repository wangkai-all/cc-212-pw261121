// 主界面渲染与交互。所有动态文本走 textContent / createElement，避免注入。

import { AppStore } from './store.js';
import { fmtMoney, fmtDateTime, fmtDate, download, parseCSV } from '../engine/util.js';
import { EVENT_TYPE_LABEL, ADJ_TYPE_LABEL } from '../engine/models.js';
import { BASIS_LABEL } from '../engine/agreements.js';
import { agreementHistory, compareRevision } from '../engine/pipeline.js';

const store = new AppStore();
const els = {};
let activeTab = 'overview';
let selectedContainer = null;
const filters = { text: '', status: 'all', onlyAnomalies: false };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

function statusBadge(b, stay) {
  if (b.feeHeld) return h('span', { class: 'badge held', text: '费用挂起' });
  if (b.provisional) return h('span', { class: 'badge provisional', text: '在场预提' });
  if (b.status === 'zero_fee') return h('span', { class: 'badge zero', text: '零费用' });
  return h('span', { class: 'badge final', text: '已结算' });
}

// ---------------- KPI ----------------
function renderKpi(state) {
  const t = state.totals;
  const cards = [
    { label: '最终应收（已出场定账）', value: fmtMoney(t.netFinal), hint: `${t.finalStays} 段已结算占用，含零费用` },
    { label: '在场预提（非最终账单）', value: fmtMoney(t.netProvisional), hint: `${t.openContainerCount} 个箱仍在场，截止 ${fmtDate(state.asOf)} 按已发生时间预提`, cls: 'prov' },
    { label: '累计部分减免', value: fmtMoney(t.discount), hint: '暂停计费不计金额，此处仅统计减免让利' },
    { label: '费用挂起待处理', value: String(t.heldStays), hint: '口径冲突 / 待补进场，裁定前不出账单', cls: 'held' },
    { label: '冲突与异常', value: String(state.conflicts.length), hint: `${state.conflicts.filter(c => !c.resolution).length} 项未处理`, cls: state.conflicts.length ? 'held' : '' },
  ];
  return h('div', { class: 'kpi-row' }, ...cards.map(c =>
    h('div', { class: 'kpi' },
      h('div', { class: 'label', text: c.label }),
      h('div', { class: 'value ' + (c.cls || ''), text: c.value }),
      h('div', { class: 'hint', text: c.hint }))));
}

// ---------------- 侧栏容器列表 ----------------
function renderSidebar(state) {
  const wrap = els.containerList;
  wrap.innerHTML = '';
  let list = state.containerSummaries;
  if (filters.text) list = list.filter(s => s.containerNo.toLowerCase().includes(filters.text.toLowerCase()));
  if (filters.status !== 'all') list = list.filter(s => {
    const anyHeld = s.heldCount > 0;
    if (filters.status === 'held') return anyHeld;
    if (filters.status === 'open') return s.open;
    if (filters.status === 'zero') return s.net === 0 && !anyHeld && !s.open;
    if (filters.status === 'final') return !s.open && !anyHeld && s.net > 0;
    return true;
  });
  if (filters.onlyAnomalies) list = list.filter(s => s.conflictCount > 0 || s.heldCount > 0 || s.backfilled);

  if (!list.length) wrap.append(h('div', { class: 'empty', text: '没有匹配的集装箱' }));
  for (const s of list) {
    const held = s.heldCount > 0;
    wrap.append(h('button', {
      class: 'container-item' + (selectedContainer === s.containerNo ? ' active' : ''),
      onclick: () => { selectedContainer = s.containerNo; activeTab = 'detail'; render(); },
    },
      h('span', { class: 'cno', text: s.containerNo }),
      h('span', { class: 'meta' },
        h('span', { text: `${s.stayCount} 段占用` }),
        h('span', { class: 'mono', text: held ? '挂起' : fmtMoney(s.net) })),
      h('span', { class: 'meta' },
        h('span', { style: 'display:flex;gap:4px;flex-wrap:wrap' },
          s.open ? h('span', { class: 'badge provisional', text: '在场' }) : null,
          s.backfilled ? h('span', { class: 'badge warn', text: '补录' }) : null,
          s.conflictCount ? h('span', { class: 'badge block', text: `冲突 ${s.conflictCount}` }) : null,
          !s.open && !s.backfilled && !s.conflictCount ? h('span', { class: 'badge final', text: '正常' }) : null))));
  }
}

// ---------------- 月度汇总（跨月演示） ----------------
function renderMonths(state) {
  const keys = Object.keys(state.monthTotals).sort();
  return h('div', { class: 'card' },
    h('h2', { text: '按月应收（跨月分段）' }),
    h('div', { class: 'month-grid' }, ...keys.map(k => {
      const m = state.monthTotals[k];
      return h('div', { class: 'month-cell' },
        h('div', { class: 'mk', text: k }),
        h('div', { class: 'mv mono', text: fmtMoney(m.net) }),
        h('div', { class: 'muted', style: 'font-size:11px', text: `${m.units} 计费单位 · 减免 ${fmtMoney(m.discount)}` }),
        m.provisionalNet ? h('div', { class: 'prov', text: `含预提 ${fmtMoney(m.provisionalNet)}` }) : null);
    })));
}

// ---------------- 总览表 ----------------
function renderOverviewTable(state) {
  const rows = [];
  for (const s of state.containerSummaries) {
    const stays = state.stays.filter(x => x.containerNo === s.containerNo);
    rows.push(h('tr', { onclick: () => { selectedContainer = s.containerNo; activeTab = 'detail'; render(); }, style: 'cursor:pointer' },
      h('td', { text: s.containerNo }),
      h('td', { text: String(s.stayCount) }),
      h('td', {}, ...stays.map(st => h('div', { text: fmtDate(st.start || st.end) }))),
      h('td', {}, ...stays.map(st => h('div', { text: st.open ? '在场' : fmtDate(st.end) }))),
      h('td', { class: 'num mono', text: fmtMoney(s.gross) }),
      h('td', { class: 'num mono', text: fmtMoney(s.discount) }),
      h('td', { class: 'num mono', text: s.heldCount ? '—' : fmtMoney(s.net) }),
      h('td', {}, ...(s.conflictCount ? [h('span', { class: 'badge block', text: `异常 ${s.conflictCount}` })] : [h('span', { class: 'badge final', text: '正常' })]))));
  }
  return h('div', { class: 'card' },
    h('h2', { text: '集装箱账单汇总（点击行查看单箱时间线）' }),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {},
          ...['箱号', '占用段数', '进场', '出场', '原始金额', '减免', '应收', '状态'].map((x, i) =>
            h('th', { class: i >= 4 && i <= 6 ? 'num' : '', text: x })))),
        h('tbody', {}, ...rows))));
}

// ---------------- 时间线 ----------------
function renderTimeline(stay, billing, state) {
  const end = stay.open ? state.asOf : stay.end;
  const start = stay.start;
  if (!start) {
    return h('div', { class: 'notice critical', text: '该占用段缺少进场时间，无法绘制时间线与计费（待人工补填）' });
  }
  const t0 = start.getTime(), t1 = end.getTime();
  const pct = (t) => ((t - t0) / (t1 - t0)) * 100;

  // 构造每单位条带：免费 / 暂停 / 各档位 / 挂起
  const segs = [];
  if (billing.feeHeld) {
    segs.push(h('div', { class: 'tl-seg held', style: 'flex:1' }, h('span', { class: 'visually-hidden', text: '费用挂起区间' })));
  } else {
    // 免费 + 暂停用等宽占位示意（真实区间在逐段费用依据表可查），计费单位按费率档位着色
    for (let i = 0; i < billing.pauseUnits; i++) segs.push(h('div', { class: 'tl-seg paused', style: 'flex:1', title: '暂停计费' }));
    for (let i = 0; i < billing.freeUnitsUsed; i++) segs.push(h('div', { class: 'tl-seg free', style: 'flex:1', title: '免费期' }));
    for (const seg of billing.segments) {
      const cls = seg.tierOrdinal >= 21 ? 'tier3' : seg.tierOrdinal >= 11 ? 'tier2' : 'tier1';
      for (let i = 0; i < seg.unitCount; i++) {
        segs.push(h('div', {
          class: `tl-seg ${cls}` + (seg.waiverPct ? ' waiver' : ''),
          style: 'flex:1',
          dataset: { tip: `${seg.unitLabel}｜${BASIS_LABEL[seg.basis]} 第${seg.tierOrdinal}档｜${seg.containerType}｜${fmtMoney(seg.rate)}${seg.waiverPct ? `｜减免${seg.waiverPct}%` : ''}` },
        }));
      }
    }
  }

  // 事件标记
  const evs = state.events.filter(e => stay.eventIds.includes(e.id));
  const markers = evs.map(e => h('div', {
    class: 'tl-event ' + e.type,
    style: `left:${Math.max(2, Math.min(98, pct(e.time.getTime())))}%`,
    dataset: { tip: `${EVENT_TYPE_LABEL[e.type]} · ${fmtDateTime(e.time)}${e.location ? ' · ' + e.location : ''}${e.newType ? ' → ' + e.newType : ''}` },
  }, h('span', { text: EVENT_TYPE_LABEL[e.type] })));

  return h('div', { class: 'timeline' },
    h('div', { class: 'tl-track' }, ...segs),
    h('div', { class: 'tl-events' }, ...markers),
    h('div', { class: 'tl-axis' }, h('span', { text: fmtDateTime(start) }), h('span', { text: stay.open ? `预提截止 ${fmtDateTime(end)}` : fmtDateTime(end) })),
    h('div', { class: 'legend' },
      h('span', { class: 'key' }, h('span', { class: 'swatch', style: `background:var(--series-3)` }), '免费期'),
      h('span', { class: 'key' }, h('span', { class: 'swatch', style: `background:var(--series-1)` }), '第一档费率'),
      h('span', { class: 'key' }, h('span', { class: 'swatch', style: `background:var(--series-2)` }), '第二档费率'),
      h('span', { class: 'key' }, h('span', { class: 'swatch', style: `background:var(--series-4)` }), '第三档费率'),
      h('span', { class: 'key' }, h('span', { class: 'swatch paused-swatch', style: 'background:repeating-linear-gradient(45deg,var(--surface-2),var(--surface-2) 4px,var(--baseline) 4px,var(--baseline) 6px)' }), '暂停计费'),
      h('span', { class: 'key' }, h('span', { class: 'swatch', style: 'background:var(--surface-2);box-shadow:inset 0 0 0 2px var(--series-5)' }), '部分减免'),
      h('span', { class: 'key' }, h('span', { class: 'swatch', style: 'background:color-mix(in srgb,var(--critical) 25%,var(--surface-2))' }), '费用挂起')));
}

// ---------------- 单箱详情 ----------------
function renderDetail(state) {
  if (!selectedContainer) return h('div', { class: 'empty', text: '请在左侧选择一个集装箱' });
  const stays = state.stays.filter(s => s.containerNo === selectedContainer);
  if (!stays.length) {
    const related = state.conflicts.filter(c => c.containerNo === selectedContainer);
    return h('div', { class: 'card' },
      h('h2', { text: selectedContainer }),
      h('div', { class: 'notice critical', text: '该箱没有可计费的占用段（事件流无法构成完整进场→出场）。' }),
      related.length ? h('div', {}, h('h3', { text: '关联冲突' }), ...related.map(c =>
        h('div', { class: 'conflict-card' },
          h('strong', { text: conflictTypeLabel(c.type) }),
          h('div', { class: 'muted', style: 'margin-top:4px', text: c.message }),
          h('div', { class: 'opts', style: 'margin-top:8px' },
            h('button', { class: 'small', onclick: () => { activeTab = 'conflicts'; render(); } }, '前往待处理')))))
        : h('div', { class: 'empty', text: '也没有关联冲突，请检查导入数据' }));
  }

  const blocks = [];
  blocks.push(h('div', { class: 'card' },
    h('h2', { text: `${selectedContainer} · 共 ${stays.length} 段占用` }),
    h('div', { class: 'notice info', text: '计费口径严格按协议约定：自然日与满24小时两套独立计算，绝不混用；在场箱只预提、不形成最终账单。' })));

  for (const [idx, stay] of stays.entries()) {
    const b = state.billings.get(stay.id);
    const body = [
      h('div', { class: 'kv', style: 'margin-bottom:12px' },
        h('span', { class: 'k', text: '占用区间' }), h('span', { text: `${fmtDateTime(stay.start || stay.end)} → ${stay.open ? '仍在场（预提）' : fmtDateTime(stay.end)}` }),
        h('span', { class: 'k', text: '计费口径' }), h('span', { text: b.feeHeld ? '挂起（未出账）' : BASIS_LABEL[b.basis] }),
        h('span', { class: 'k', text: '口径依据' }), h('span', { text: b.basisSource || '—' }),
        h('span', { class: 'k', text: '免费 / 暂停 / 计费' }), h('span', { text: `${b.freeUnitsUsed} / ${b.pauseUnits} / ${b.billableUnits} 单位` }),
        h('span', { class: 'k', text: '原始 / 减免 / 应收' }), h('span', { class: 'mono', text: b.feeHeld ? '—' : `${fmtMoney(b.grossTotal)} / ${fmtMoney(b.discountTotal)} / ${fmtMoney(b.netTotal)}` }),
        h('span', { class: 'k', text: '状态' }), h('span', {}, statusBadge(b, stay))),
    ];
    if (b.feeHeld) body.push(h('div', { class: 'notice critical', text: b.holdReason }));
    if (stay.backfilled) body.push(...(stay.warnings || []).map(w => h('div', { class: 'notice warn', text: '留痕：' + w.text })));
    if (stay.replacedStarts?.length) body.push(...stay.replacedStarts.map(r => h('div', { class: 'notice warn', text: `开始时间经人工裁定：${fmtDateTime(r.from)} 改为 ${fmtDateTime(r.to)}（原进场留痕）` })));
    if (b.warnings?.length) body.push(...b.warnings.filter(w => w.code !== 'backfilled_gate_out').map(w => h('div', { class: 'notice warn', text: '预警：' + w.text })));

    body.push(h('h3', { text: `时间线（占用段 ${idx + 1}）` }), renderTimeline(stay, b, state));

    // 逐段费用依据表
    if (!b.feeHeld && b.segments.length) {
      body.push(h('h3', { text: '逐段费用依据' }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ...['月份', '单位', '箱型', '协议/版本', '档位', '费率', '数量', '原始', '减免', '应收', '依据'].map(x => h('th', { text: x })))),
          h('tbody', {}, ...b.segments.flatMap(seg =>
            seg.unitDetails.map((u, i) => h('tr', {},
              h('td', { text: i === 0 ? seg.month : '' }),
              h('td', { text: u.unitLabel }),
              h('td', { text: seg.containerType || '未登记' }),
              h('td', { text: i === 0 ? `${seg.agreementId} v${seg.agreementVersion}` : '' }),
              h('td', { class: 'num', text: String(seg.tierOrdinal) }),
              h('td', { class: 'num mono', text: fmtMoney(u.rate) }),
              h('td', { class: 'num', text: i === 0 ? String(seg.unitCount) : '' }),
              h('td', { class: 'num mono', text: fmtMoney(u.gross) }),
              h('td', { class: 'num mono', text: fmtMoney(u.discount) }),
              h('td', { class: 'num mono', text: fmtMoney(u.net) }),
              h('td', { class: 'muted', style: 'font-size:11px', text: i === 0 ? seg.rateBasisText + (seg.waiverPct ? `；减免 ${seg.waiverPct}%（${seg.waiverReasons.join('；') || '协议减免'}）` : '') : '' }))))))));
    }

    // 适用的调整（暂停/减免追溯）
    const relatedAdj = state.adjustments.filter(a => a.containerNo === selectedContainer);
    if (relatedAdj.length) {
      body.push(h('h3', { text: '暂停 / 减免记录（可追溯）' }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ...['类型', '开始', '结束', '箱型', '减免比例', '原因'].map(x => h('th', { text: x })))),
          h('tbody', {}, ...relatedAdj.map(a => h('tr', {},
            h('td', { text: ADJ_TYPE_LABEL[a.type] }),
            h('td', { text: fmtDateTime(a.start) }),
            h('td', { text: fmtDateTime(a.end) }),
            h('td', { text: a.containerType || '全部' }),
            h('td', { text: a.discountPct ? a.discountPct + '%' : '—' }),
            h('td', { class: 'muted', text: a.reason || '—' })))))));
    }
    blocks.push(h('div', { class: 'card' }, h('h2', { text: `占用段 ${idx + 1}` }), ...body));
  }

  // 协议版本与修订差额
  blocks.push(renderAgreementPanel(state, stays[0]));
  return h('div', {}, ...blocks);
}

function renderAgreementPanel(state, stay) {
  const history = agreementHistory(state).filter(g =>
    state.agreements.some(a => a.agreement_id === g.agreementId &&
      (a.scope_type === 'global' || a.scope_value === stay.containerNo)));
  const cards = history.map(g => {
    const rows = g.rows.map(r => {
      const a = r.agreement;
      return h('div', { class: 'month-cell', style: 'min-width:220px' },
        h('div', { class: 'mk', text: `${a.agreement_id} v${a.version}` }),
        h('div', { class: 'muted', style: 'font-size:11.5px', text: `${BASIS_LABEL[a.billing_basis]} · 免费 ${a.free_days} 单位` }),
        h('div', { class: 'muted', style: 'font-size:11.5px', text: `生效 ${fmtDate(a.effective_from)}${a.supersedes_at ? ' → 废止 ' + fmtDate(a.supersedes_at) : '（现行）'}` }),
        h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px', text: a.rates.map(x => `${x.type || '通用'} 第${x.from_day}档起 ${fmtMoney(x.rate)}`).join('；') }),
        r.diffFromPrev ? h('div', { style: 'margin-top:6px' }, ...r.diffFromPrev.map(d =>
          h('div', { style: 'font-size:11.5px' }, h('strong', { text: d.field + '：' }), h('span', { class: 'delta-up', text: d.from + ' ' }), '→ ', h('span', { class: 'delta-down', text: d.to })))) : null);
    });
    // 修订前后差额（仅对已关闭段可试算）
    let deltaBlock = null;
    if (g.rows.length >= 2 && stay && !stay.open && !stay.needsManualStart) {
      const last = g.rows[g.rows.length - 1].agreement;
      const prev = g.rows[g.rows.length - 2].agreement;
      if (last.billing_basis === prev.billing_basis) {
        const cmp = compareRevision(state, stay.id, prev, last);
        if (cmp) deltaBlock = h('div', { class: 'notice info', style: 'margin-top:8px', text: `本占用段修订前后差额：${fmtMoney(cmp.amounts.before)} → ${fmtMoney(cmp.amounts.after)}（${cmp.amounts.delta >= 0 ? '+' : ''}${fmtMoney(cmp.amounts.delta)}）` });
      } else {
        deltaBlock = h('div', { class: 'notice warn', style: 'margin-top:8px', text: '相邻版本计费口径不同，禁止自动混算；差额需在待处理页人工裁定口径后查看。' });
      }
    }
    return h('div', { class: 'card' }, h('h2', { text: `协议 ${g.agreementId}（${g.scope}）` }),
      h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' }, ...rows), deltaBlock);
  });
  return h('div', {}, ...cards);
}

// ---------------- 待处理 ----------------
function renderConflicts(state) {
  const unresolved = state.conflicts.filter(c => !c.resolution);
  const resolved = state.conflicts.filter(c => c.resolution);
  const cards = [];

  cards.push(h('div', { class: 'notice ' + (unresolved.length ? 'critical' : 'info'),
    text: unresolved.length ? `${unresolved.length} 项冲突未处理。系统不会自动拼接不存在的占用时段，所有金额在裁定前保持挂起/原样。` : '所有冲突均已处理。' }));

  for (const c of [...unresolved, ...resolved]) {
    cards.push(h('div', { class: 'conflict-card' + (c.resolution ? ' resolved' : '') },
      h('div', { style: 'display:flex;justify-content:space-between;gap:10px;align-items:flex-start' },
        h('div', {},
          h('strong', { text: `${c.containerNo} · ${conflictTypeLabel(c.type)}` }),
          h('div', { class: 'muted', style: 'margin-top:4px', text: c.message }),
          h('div', { class: 'muted', style: 'font-size:11px;margin-top:3px', text: `冲突编号 ${c.id}${c.eventTime ? ' · 发生于 ' + fmtDateTime(c.eventTime) : ''}` })),
        h('span', { class: 'badge ' + (c.resolution ? 'final' : 'block'), text: c.resolution ? '已处理' : (c.severity === 'warn' ? '预警' : '待处理') })),
      c.resolution
        ? h('div', { style: 'margin-top:8px' },
            h('span', { class: 'pill', text: '裁定：' + optionLabel(c, c.resolution.action) }),
            h('button', { class: 'small danger', style: 'margin-left:8px', onclick: () => store.resetResolution(c.id) }, '撤销裁定'))
        : h('div', { class: 'opts' }, ...c.options.map(o =>
            h('button', { class: 'small', onclick: () => store.resolveConflict(c.id, o.value) }, o.label)))));
  }
  if (!cards.length) cards.push(h('div', { class: 'empty', text: '暂无冲突' }));
  return h('div', {}, ...cards);
}

function conflictTypeLabel(t) {
  return ({
    dup_gate_in: '重复进场',
    orphan_gate_out: '先出后进（无进场）',
    basis_switch: '计费口径切换',
    event_outside_stay: '区间外事件',
    duplicate_event_id: '事件编号重复',
  })[t] || t;
}
function optionLabel(c, action) {
  const o = c.options?.find(x => x.value === action);
  return o ? o.label : action;
}

// ---------------- 协议页 ----------------
function renderAgreementsTab(state) {
  const history = agreementHistory(state);
  return h('div', {}, ...history.map(g => h('div', { class: 'card' },
    h('h2', { text: `${g.agreementId} · 适用范围 ${g.scope}` }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data agree-diff' },
      h('thead', {}, h('tr', {}, ...['版本', '口径', '免费期', '生效', '废止', '费率', '较上版修订'].map(x => h('th', { text: x })))),
      h('tbody', {}, ...g.rows.map(r => h('tr', {},
        h('td', { text: 'v' + r.agreement.version }),
        h('td', { text: BASIS_LABEL[r.agreement.billing_basis] }),
        h('td', { text: r.agreement.free_days + ' 单位' }),
        h('td', { text: fmtDate(r.agreement.effective_from) }),
        h('td', { text: r.agreement.supersedes_at ? fmtDate(r.agreement.supersedes_at) : '现行' }),
        h('td', { class: 'muted', style: 'font-size:11px', text: r.agreement.rates.map(x => `${x.type || '通用'}:${fmtMoney(x.rate)}@${x.from_day}`).join('；') }),
        h('td', {}, r.diffFromPrev
          ? h('div', {}, ...r.diffFromPrev.map(d => h('div', { style: 'font-size:11.5px' }, h('strong', { text: d.field + ' ' }), h('span', { class: 'from', text: d.from }), ' → ', h('span', { class: 'to', text: d.to }))))
          : h('span', { class: 'muted', text: '首个版本' }))))))))));
}

// ---------------- 数据导入 / 审计 ----------------
function renderDataTab(state) {
  const filePick = (accept, onFile) => h('input', {
    type: 'file', class: 'file-input', accept,
    onchange: (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => { try { onFile(String(reader.result)); } catch (err) { alert('导入失败：' + err.message); } };
      reader.readAsText(f, 'utf-8');
    },
  });
  return h('div', {},
    h('div', { class: 'card' },
      h('h2', { text: '数据导入（本地解析，不上传任何服务器）' }),
      h('div', { class: 'filter-row' },
        h('label', {}, '进场 / 出场 / 移箱 / 箱型变化（CSV）', filePick('.csv', t => store.importEvents(t))),
        h('label', {}, '暂停计费 / 部分减免（CSV）', filePick('.csv', t => store.importAdjustments(t))),
        h('label', {}, '免费期协议（JSON）', filePick('.json', t => store.importAgreements(t)))),
      h('div', { class: 'notice info', style: 'margin-top:10px', text: '导入为追加模式，重复 event_id 会进入待处理；可先用「载入虚构样例」再导入自己的文件观察叠加效果。' })),
    h('div', { class: 'card' },
      h('h2', { text: '导出' }),
      h('div', { class: 'opts', style: 'display:flex;gap:10px;flex-wrap:wrap' },
        h('button', { onclick: () => download('账单明细.csv', store.exportBillCSV(currentFilter())) }, '导出当前筛选账单明细 CSV'),
        h('button', { onclick: () => download('事件数据.csv', store.exportEventsCSV()) }, '导出事件 CSV'),
        h('button', { onclick: () => download('费用调整.csv', store.exportAdjustmentsCSV()) }, '导出调整 CSV'))),
    h('div', { class: 'card' },
      h('h2', { text: '操作审计（冲突裁定 / 导入 / 补录均留痕）' }),
      state.auditLog.length
        ? h('div', {}, ...state.auditLog.map(l => h('div', { class: 'audit-item' },
            h('div', {}, h('strong', { text: l.action }), h('span', { class: 'at', style: 'margin-left:8px', text: l.at.toLocaleString('zh-CN') })),
            h('div', { class: 'muted', text: l.detail }))))
        : h('div', { class: 'empty', text: '暂无操作记录' })));
}

function currentFilter() {
  return (stay, b) => {
    if (filters.status === 'held' && !b.feeHeld) return false;
    if (filters.status === 'open' && !stay.open) return false;
    if (filters.status === 'zero' && b.status !== 'zero_fee') return false;
    if (filters.onlyAnomalies) {
      const hasConflict = state0().conflicts.some(c => c.containerNo === stay.containerNo);
      if (!hasConflict && !stay.backfilled && !b.feeHeld) return false;
    }
    if (filters.text && !stay.containerNo.toLowerCase().includes(filters.text.toLowerCase())) return false;
    return true;
  };
}
function state0() { return store.state; }

// ---------------- 主渲染 ----------------
function render() {
  const state = store.state;
  if (!state) return;
  renderSidebar(state);
  els.kpi.innerHTML = '';
  els.kpi.append(renderKpi(state));
  els.tabs.innerHTML = '';
  const tabDefs = [
    ['overview', '总览'], ['detail', '单箱时间线'], ['conflicts', '待处理', state.conflicts.filter(c => !c.resolution).length],
    ['agreements', '协议版本'], ['data', '导入/导出/审计'],
  ];
  for (const [key, label, count] of tabDefs) {
    els.tabs.append(h('button', {
      class: 'tab' + (activeTab === key ? ' active' : ''),
      onclick: () => { activeTab = key; render(); },
    }, label, count ? h('span', { class: 'count ' + (count ? 'alert' : ''), text: String(count) }) : null));
  }
  els.main.innerHTML = '';
  if (activeTab === 'overview') els.main.append(renderMonths(state), renderOverviewTable(state));
  else if (activeTab === 'detail') els.main.append(renderDetail(state));
  else if (activeTab === 'conflicts') els.main.append(renderConflicts(state));
  else if (activeTab === 'agreements') els.main.append(renderAgreementsTab(state));
  else if (activeTab === 'data') els.main.append(renderDataTab(state));
}

// ---------------- 提示条 ----------------
function initTooltip() {
  const tip = h('div', { class: 'tooltip' });
  document.body.append(tip);
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) return;
    tip.style.display = 'block';
    tip.textContent = '';
    const parts = t.dataset.tip.split('｜');
    tip.append(h('div', { class: 'tt-val', text: parts[0] }));
    if (parts.length > 1) tip.append(h('div', { class: 'tt-sub', text: parts.slice(1).join('｜') }));
  });
  document.addEventListener('pointermove', (e) => {
    if (tip.style.display !== 'block') return;
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 300) + 'px';
    tip.style.top = Math.min(e.clientY + 14, window.innerHeight - 120) + 'px';
  });
  document.addEventListener('pointerout', (e) => { if (e.target.closest('[data-tip]')) tip.style.display = 'none'; });
}

// ---------------- 启动 ----------------
async function boot() {
  Object.assign(els, {
    kpi: document.getElementById('kpi'),
    tabs: document.getElementById('tabs'),
    main: document.getElementById('main'),
    containerList: document.getElementById('containerList'),
  });

  document.getElementById('loadSample').onclick = async () => {
    const [evCsv, adjCsv, agJson] = await Promise.all([
      fetch('data/events.csv').then(r => r.text()),
      fetch('data/adjustments.csv').then(r => r.text()),
      fetch('data/agreements.json').then(r => r.text()),
    ]);
    store.loadSample({
      events: parseCSV(evCsv),
      adjustments: parseCSV(adjCsv),
      agreements: JSON.parse(agJson),
    });
    selectedContainer = 'CSLU2000001';
  };

  document.getElementById('themeToggle').onclick = () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  };

  document.getElementById('searchBox').oninput = (e) => { filters.text = e.target.value; render(); };
  document.getElementById('statusFilter').onchange = (e) => { filters.status = e.target.value; render(); };
  document.getElementById('anomalyOnly').onchange = (e) => { filters.onlyAnomalies = e.target.checked; render(); };

  store.subscribe(render);
  initTooltip();

  // 自动载入样例，打开即可看效果
  document.getElementById('loadSample').click();
}

document.addEventListener('DOMContentLoaded', boot);
