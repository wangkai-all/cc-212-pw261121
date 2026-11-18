// 免费期协议：版本匹配、口径切换检测、修订前后差额

import { fmtDate, fmtDateTime, fmtMoney } from './util.js';

export const BASIS_LABEL = {
  calendar_day: '自然日',
  rolling_24h: '满 24 小时',
};

// 适用于该箱的协议族：优先箱专属，否则全局
export function agreementFamilyFor(agreements, containerNo) {
  const own = agreements.filter(a => a.scope_type === 'container' && a.scope_value === containerNo);
  if (own.length) return own;
  return agreements.filter(a => a.scope_type === 'global');
}

// t 时刻生效的协议版本（effective_from <= t < supersedes_at；未废止取最新生效版）
export function versionAt(family, t) {
  const active = family.filter(a =>
    a.effective_from.getTime() <= t.getTime() &&
    (!a.supersedes_at || a.supersedes_at.getTime() > t.getTime())
  );
  if (!active.length) return null;
  active.sort((a, b) => b.effective_from - a.effective_from);
  return active[0];
}

export function rateFor(agreement, containerType, billableOrdinal) {
  // 同协议内箱型各自维护费率表；未单列的箱型回落到 type='*' 的通用费率
  const exact = agreement.rates.filter(r => (r.type || '*') === containerType);
  const fallback = agreement.rates.filter(r => (r.type || '*') === '*');
  const table = exact.length ? exact : fallback;
  if (!table.length) return null;
  let pick = table[0];
  for (const r of table) if (r.from_day <= billableOrdinal) pick = r;
  return pick.rate;
}

// 检测一个占用段在其生命周期内是否发生计费口径切换（协议约定的两种口径不能混用）
export function detectBasisSwitch(family, stay, endTime) {
  if (!stay.start) return null;
  const startV = versionAt(family, stay.start);
  if (!startV) return null;
  const atEnd = versionAt(family, endTime);
  if (atEnd && atEnd.billing_basis !== startV.billing_basis) {
    return {
      fromVersion: startV,
      toVersion: atEnd,
      switchedAt: atEnd.effective_from,
      message: `协议口径在占用期间由「${BASIS_LABEL[startV.billing_basis]}」切换为「${BASIS_LABEL[atEnd.billing_basis]}」（${atEnd.agreement_id} 于 ${fmtDate(atEnd.effective_from)} 生效），同一段占用不得两种口径混算`,
    };
  }
  return null;
}

// 占用期间实际适用过的协议版本序列（供时间线展示）
export function versionsAcross(family, stay, endTime) {
  if (!stay.start) return [];
  const points = new Map();
  for (const a of family) points.set(a.agreement_id + '#' + a.version, a);
  const out = [];
  for (const a of points.values()) {
    const vStart = Math.max(a.effective_from.getTime(), stay.start.getTime());
    const vEnd = a.supersedes_at ? Math.min(a.supersedes_at.getTime(), endTime.getTime()) : endTime.getTime();
    if (vStart < vEnd) out.push({ agreement: a, from: new Date(vStart), to: new Date(vEnd) });
  }
  out.sort((a, b) => a.from - b.from);
  return out;
}

// 协议版本修订对比（同协议相邻版本）
export function diffAgreement(fromA, toA) {
  const changes = [];
  if (fromA.billing_basis !== toA.billing_basis) {
    changes.push({ field: '计费口径', from: BASIS_LABEL[fromA.billing_basis], to: BASIS_LABEL[toA.billing_basis] });
  }
  if (fromA.free_days !== toA.free_days) {
    changes.push({ field: '免费期（天）', from: String(fromA.free_days), to: String(toA.free_days) });
  }
  const key = (r) => `${r.type || '*'}@${r.from_day}`;
  const oldMap = new Map(fromA.rates.map(r => [key(r), r]));
  const newMap = new Map(toA.rates.map(r => [key(r), r]));
  for (const [k, nr] of newMap) {
    const old = oldMap.get(k);
    if (!old) changes.push({ field: `费率 ${k}`, from: '（无）', to: fmtMoney(nr.rate) + '/单位' });
    else if (old.rate !== nr.rate) changes.push({ field: `费率 ${k}`, from: fmtMoney(old.rate), to: fmtMoney(nr.rate) });
  }
  for (const [k, old] of oldMap) if (!newMap.has(k)) changes.push({ field: `费率 ${k}`, from: fmtMoney(old.rate), to: '（删除）' });
  if (fromA.scope_type !== toA.scope_type || fromA.scope_value !== toA.scope_value) {
    changes.push({ field: '适用范围', from: `${fromA.scope_type}:${fromA.scope_value}`, to: `${toA.scope_type}:${toA.scope_value}` });
  }
  return changes;
}

// 修订前后整段费用差额（由 billing 模块分别计算后传入两个结果）
export function revisionDelta(beforeBilling, afterBilling) {
  const d = afterBilling.netTotal - beforeBilling.netTotal;
  return {
    delta: Math.round(d * 100) / 100,
    before: beforeBilling.netTotal,
    after: afterBilling.netTotal,
  };
}
