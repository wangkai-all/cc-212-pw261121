// 领域模型：事件（进场/出场/移箱/箱型变化）与费用调整（暂停/减免）的标准化与校验

import { parseTime, toISO, uid } from './util.js';

export const EVENT_TYPES = ['gate_in', 'gate_out', 'move', 'type_change'];
export const EVENT_TYPE_LABEL = {
  gate_in: '进场',
  gate_out: '出场',
  move: '移箱',
  type_change: '箱型变化',
};
export const ADJ_TYPES = ['pause', 'waiver'];
export const ADJ_TYPE_LABEL = { pause: '暂停计费', waiver: '部分减免' };

export const CONTAINER_TYPES = ['20GP', '40GP', '40HQ', '20RF'];

// 原始 CSV 行 -> 标准化事件。校验失败抛出带行号的错误。
export function normalizeEvent(row, lineNo) {
  const at = (k) => (row[k] ?? '').trim();
  const containerNo = at('container_no');
  if (!containerNo) throw new Error(`第 ${lineNo} 行缺少 container_no`);
  const type = at('event_type');
  if (!EVENT_TYPES.includes(type)) {
    throw new Error(`第 ${lineNo} 行 event_type 非法（${type || '空'}），允许：${EVENT_TYPES.join('/')}`);
  }
  let time;
  try { time = parseTime(at('event_time')); }
  catch (e) { throw new Error(`第 ${lineNo} 行 event_time ${e.message}`); }
  const ev = {
    id: at('event_id') || uid('EV'),
    containerNo,
    type,
    time,
    location: at('location') || '',
    newType: '',
    recordedAt: null,
    note: at('note') || '',
    raw: { ...row },
    lineNo,
  };
  if (type === 'type_change') {
    ev.newType = at('new_type');
    if (!CONTAINER_TYPES.includes(ev.newType)) {
      throw new Error(`第 ${lineNo} 行箱型变化缺少合法 new_type（${CONTAINER_TYPES.join('/')}）`);
    }
  }
  if (at('recorded_at')) {
    try { ev.recordedAt = parseTime(at('recorded_at')); }
    catch { ev.recordedAt = null; }
  }
  return ev;
}

export function normalizeAdjustment(row, lineNo) {
  const at = (k) => (row[k] ?? '').trim();
  const containerNo = at('container_no');
  if (!containerNo) throw new Error(`第 ${lineNo} 行缺少 container_no`);
  const type = at('adj_type');
  if (!ADJ_TYPES.includes(type)) {
    throw new Error(`第 ${lineNo} 行 adj_type 非法，允许：${ADJ_TYPES.join('/')}`);
  }
  let start, end;
  try { start = parseTime(at('start_time')); }
  catch (e) { throw new Error(`第 ${lineNo} 行 start_time ${e.message}`); }
  try { end = parseTime(at('end_time')); }
  catch (e) { throw new Error(`第 ${lineNo} 行 end_time ${e.message}`); }
  if (end <= start) throw new Error(`第 ${lineNo} 行暂停/减免区间 end_time 必须晚于 start_time`);
  const adj = {
    id: at('adj_id') || uid('ADJ'),
    containerNo,
    type,
    start,
    end,
    reason: at('reason') || '',
    containerType: at('container_type') || '',
    discountPct: null,
    note: at('note') || '',
    lineNo,
  };
  if (type === 'waiver') {
    const pct = Number(at('discount_pct'));
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      throw new Error(`第 ${lineNo} 行减免 discount_pct 必须为 0~100 之间的数值`);
    }
    adj.discountPct = pct;
  }
  return adj;
}

// 协议 JSON 深拷贝并把字符串时间转 Date；rates 深拷贝
export function normalizeAgreement(jsonLike) {
  const a = JSON.parse(JSON.stringify(jsonLike, (k, v) => {
    if ((k === 'effective_from' || k === 'supersedes_at') && v) return v;
    return v;
  }));
  a.effective_from = parseTime(a.effective_from);
  if (a.supersedes_at) a.supersedes_at = parseTime(a.supersedes_at);
  if (!a.agreement_id) throw new Error('协议缺少 agreement_id');
  if (!['calendar_day', 'rolling_24h'].includes(a.billing_basis)) {
    throw new Error(`协议 ${a.agreement_id} billing_basis 非法`);
  }
  if (!Array.isArray(a.rates) || !a.rates.length) throw new Error(`协议 ${a.agreement_id} 缺少 rates`);
  for (const r of a.rates) {
    r.from_day = Number(r.from_day);
    r.rate = Number(r.rate);
    if (!Number.isFinite(r.from_day) || !Number.isFinite(r.rate)) {
      throw new Error(`协议 ${a.agreement_id} 费率行非法`);
    }
  }
  a.rates.sort((x, y) => x.from_day - y.from_day);
  if (a.rates[0].from_day !== 1) throw new Error(`协议 ${a.agreement_id} 费率必须从 from_day=1 开始`);
  a.scope_type = a.scope_type || 'global';
  a.scope_value = a.scope_value || '*';
  a.note = a.note || '';
  return a;
}

export function eventToRow(ev) {
  return {
    event_id: ev.id,
    container_no: ev.containerNo,
    event_type: ev.type,
    event_time: toISO(ev.time),
    location: ev.location || '',
    new_type: ev.newType || '',
    recorded_at: ev.recordedAt ? toISO(ev.recordedAt) : '',
    note: ev.note || '',
  };
}

export function adjToRow(adj) {
  return {
    adj_id: adj.id,
    container_no: adj.containerNo,
    adj_type: adj.type,
    start_time: toISO(adj.start),
    end_time: toISO(adj.end),
    container_type: adj.containerType || '',
    discount_pct: adj.discountPct ?? '',
    reason: adj.reason || '',
    note: adj.note || '',
  };
}
