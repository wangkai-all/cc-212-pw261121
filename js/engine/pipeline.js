// 编排层：装载数据 -> 重建占用 -> 逐段计费 -> 汇总；并支持人工裁定后的重算与修订差额

import { reconstruct } from './reconstruction.js';
import { computeBilling } from './billing.js';
import { agreementFamilyFor, versionAt, diffAgreement, revisionDelta } from './agreements.js';
import { uid, round2, fmtMoney } from './util.js';

export function buildState(events, adjustments, agreements, opts = {}) {
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const resolutions = opts.resolutions || {};
  const auditLog = opts.auditLog || [];

  const { stays, conflicts, warnings } = reconstruct(events, resolutions, asOf);

  const billings = new Map();

  // 先对每段占用做一次试算，暴露口径切换冲突（冲突持久化在 conflicts 中，可被人工裁定）
  for (const stay of stays) {
    const probe = computeBilling(stay, adjustments, agreements, { asOf });
    if (probe.feeHeld && probe.basisSwitch) {
      let c = conflicts.find(x => x.type === 'basis_switch' && x.stayId === stay.id);
      if (!c) {
        c = {
          id: 'C-basis-' + stay.containerNo,
          containerNo: stay.containerNo,
          stayId: stay.id,
          type: 'basis_switch',
          severity: 'block',
          message: probe.holdReason,
          eventTime: stay.start,
          options: [
            { value: 'use_calendar_day', label: '全段按「自然日」口径重算' },
            { value: 'use_rolling_24h', label: '全段按「满 24 小时」口径重算' },
          ],
          resolution: null,
        };
        conflicts.push(c);
      }
    }
  }

  // 正式计费：应用口径冲突的人工裁定
  for (const stay of stays) {
    const c = conflicts.find(x => x.type === 'basis_switch' && x.stayId === stay.id);
    let b;
    if (c) {
      const r = resolutions[c.id]?.resolution;
      c.resolution = r || null;
      if (r?.action === 'use_calendar_day' || r?.action === 'use_rolling_24h') {
        b = computeBilling(stay, adjustments, agreements, {
          asOf,
          basisOverride: r.action === 'use_calendar_day' ? 'calendar_day' : 'rolling_24h',
        });
      } else {
        b = computeBilling(stay, adjustments, agreements, { asOf });
      }
    } else {
      b = computeBilling(stay, adjustments, agreements, { asOf });
    }
    billings.set(stay.id, b);
  }

  // 汇总
  const containerSummaries = summarizeContainers(stays, billings, events, conflicts);
  const totals = aggregateTotals(stays, billings);
  const monthTotals = aggregateMonths(stays, billings);

  return {
    asOf,
    events,
    adjustments,
    agreements,
    stays,
    conflicts,
    warnings,
    billings,
    containerSummaries,
    totals,
    monthTotals,
    auditLog,
  };
}

function summarizeContainers(stays, billings, events = [], conflicts = []) {
  const map = new Map();
  const ensure = (containerNo) => {
    if (!map.has(containerNo)) {
      map.set(containerNo, {
        containerNo,
        stayCount: 0,
        gross: 0, discount: 0, net: 0,
        provisionalNet: 0,
        heldCount: 0,
        conflictIds: new Set(),
        open: false,
        backfilled: false,
      });
    }
    return map.get(containerNo);
  };

  // 先确保"只有冲突事件、没有占用段"的箱也出现在列表里
  for (const ev of events) ensure(ev.containerNo);
  for (const c of conflicts) {
    const s = ensure(c.containerNo);
    s.conflictIds.add(c.id);
  }

  for (const stay of stays) {
    const b = billings.get(stay.id);
    const s = ensure(stay.containerNo);
    s.stayCount += 1;
    if (b) {
      s.gross = round2(s.gross + b.grossTotal);
      s.discount = round2(s.discount + b.discountTotal);
      s.net = round2(s.net + b.netTotal);
      if (b.provisional) s.provisionalNet = round2(s.provisionalNet + b.netTotal);
      if (b.feeHeld) s.heldCount += 1;
    }
    if (stay.open) s.open = true;
    if (stay.backfilled) s.backfilled = true;
    for (const cid of stay.conflictIds) s.conflictIds.add(cid);
  }
  return [...map.values()].map(s => ({ ...s, conflictCount: s.conflictIds.size, conflictIds: [...s.conflictIds] }))
    .sort((a, b) => a.containerNo.localeCompare(b.containerNo));
}

function aggregateTotals(stays, billings) {
  const t = { gross: 0, discount: 0, netFinal: 0, netProvisional: 0, heldStays: 0, openContainers: new Set(), finalStays: 0, zeroFeeStays: 0 };
  for (const stay of stays) {
    const b = billings.get(stay.id);
    if (!b) continue;
    if (b.feeHeld) { t.heldStays += 1; continue; }
    t.gross = round2(t.gross + b.grossTotal);
    t.discount = round2(t.discount + b.discountTotal);
    if (b.provisional) {
      t.netProvisional = round2(t.netProvisional + b.netTotal);
      t.openContainers.add(stay.containerNo);
    } else {
      t.netFinal = round2(t.netFinal + b.netTotal);
      t.finalStays += 1;
      if (b.status === 'zero_fee') t.zeroFeeStays += 1;
    }
  }
  t.openContainerCount = t.openContainers.size;
  delete t.openContainers;
  return t;
}

function aggregateMonths(stays, billings) {
  const out = {};
  for (const stay of stays) {
    const b = billings.get(stay.id);
    if (!b || b.feeHeld) continue;
    for (const [mk, v] of Object.entries(b.months)) {
      if (!out[mk]) out[mk] = { gross: 0, discount: 0, net: 0, units: 0, provisionalNet: 0 };
      const m = out[mk];
      m.gross = round2(m.gross + v.gross);
      m.discount = round2(m.discount + v.discount);
      m.net = round2(m.net + v.net);
      m.units += v.units;
      if (b.provisional) m.provisionalNet = round2(m.provisionalNet + v.net);
    }
  }
  return out;
}

// 协议版本修订差额：对受影响的已关闭占用段，用指定旧版/新版协议分别试算
export function compareRevision(state, stayId, oldAgreement, newAgreement) {
  const stay = state.stays.find(s => s.id === stayId);
  if (!stay || stay.open || stay.needsManualStart) return null;
  const swap = (target) => state.agreements.map(a =>
    a.agreement_id === target.agreement_id && a.version === target.version ? target : a);
  const before = computeBilling(stay, state.adjustments, swap(oldAgreement), { asOf: state.asOf });
  const after = computeBilling(stay, state.adjustments, swap(newAgreement), { asOf: state.asOf });
  return {
    changes: diffAgreement(oldAgreement, newAgreement),
    amounts: revisionDelta(before, after),
    beforeBilling: before,
    afterBilling: after,
  };
}

// 列出协议的全部版本（含字段差异）
export function agreementHistory(state) {
  const groups = new Map();
  for (const a of state.agreements) {
    if (!groups.has(a.agreement_id)) groups.set(a.agreement_id, []);
    groups.get(a.agreement_id).push(a);
  }
  const out = [];
  for (const [id, versions] of groups) {
    versions.sort((a, b) => a.version - b.version);
    const rows = versions.map((v, i) => ({
      agreement: v,
      diffFromPrev: i === 0 ? null : diffAgreement(versions[i - 1], v),
    }));
    out.push({ agreementId: id, scope: `${versions[0].scope_type}:${versions[0].scope_value}`, rows });
  }
  return out.sort((a, b) => a.agreementId.localeCompare(b.agreementId));
}

export { fmtMoney };
