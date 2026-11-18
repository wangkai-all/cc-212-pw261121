// 堆存费计费引擎。
// 两种口径严格分开，绝不混用：
//   calendar_day 自然日：进场当日计第 1 个自然日，出场当日不计；暂停覆盖的自然日不计费；
//                        免费期按自然日扣减；段内费率以"当日日首箱型 / 当日适用协议版本"判定。
//   rolling_24h 满24小时：从进场时刻起按 24h 切块，凑满一块才产生一个计费单位；
//                        免费期=若干个完整 24h 块；不足 24h 的零头不计；暂停区间内的块剔除后顺延。
// 未结束占用按 asOf 预提，结果标记 provisional，不输出最终账单。

import {
  DAY_MS, utcDayStart, eachUTCDay, monthKey, fmtDate, fmtDateTime, fmtMoney, round2,
} from './util.js';
import { agreementFamilyFor, versionAt, rateFor, detectBasisSwitch, BASIS_LABEL } from './agreements.js';
import { typeAt } from './reconstruction.js';

function pauseRanges(adjustments, containerNo) {
  return adjustments
    .filter(a => a.containerNo === containerNo && a.type === 'pause')
    .map(a => ({ start: a.start.getTime(), end: a.end.getTime(), adj: a }))
    .sort((a, b) => a.start - b.start);
}

function waiverList(adjustments, containerNo) {
  return adjustments
    .filter(a => a.containerNo === containerNo && a.type === 'waiver')
    .sort((a, b) => a.start - b.start);
}

function overlaps(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

function pausesOverlapping(pauses, s, e) {
  return pauses.filter(p => overlaps(s, e, p.start, p.end));
}

export function computeBilling(stay, allAdjustments, agreements, opts = {}) {
  const asOf = opts.asOf ? new Date(opts.asOf) : new Date();
  const adjustments = allAdjustments.filter(a => a.containerNo === stay.containerNo);
  const pauses = pauseRanges(allAdjustments, stay.containerNo);
  const waivers = waiverList(allAdjustments, stay.containerNo);

  const result = {
    stayId: stay.id,
    containerNo: stay.containerNo,
    status: 'final',
    provisional: !!stay.open,
    feeHeld: false,
    holdReason: '',
    basis: '',
    basisSource: '',
    agreementVersions: [],
    basisSwitch: null,
    segments: [],
    adjustmentsApplied: [],
    warnings: [...(stay.warnings || [])],
    months: {},
    grossTotal: 0,
    discountTotal: 0,
    netTotal: 0,
    freeUnitsUsed: 0,
    pauseUnits: 0,
    billableUnits: 0,
    chargeWindow: { from: stay.start, to: stay.end || (stay.open ? asOf : null) },
  };

  // 补录出场但进场时间待补：无法计算，挂起
  if (stay.needsManualStart || !stay.start) {
    result.status = 'fee_held';
    result.feeHeld = true;
    result.holdReason = '补录出场缺少进场时间，等待人工补填后才能计费';
    return result;
  }

  const endTime = stay.open ? asOf : stay.end;
  const family = agreementFamilyFor(agreements, stay.containerNo);
  if (!family.length) {
    result.status = 'fee_held';
    result.feeHeld = true;
    result.holdReason = '找不到适用的免费期协议';
    return result;
  }

  const basisSwitch = detectBasisSwitch(family, stay, endTime);
  result.basisSwitch = basisSwitch;
  const startVersion = versionAt(family, stay.start);
  result.agreementVersions = family;

  let basis;
  if (opts.basisOverride) {
    basis = opts.basisOverride;
    result.basisSource = '人工裁定（口径冲突处理）';
  } else if (basisSwitch) {
    // 口径冲突未裁定：费用挂起，绝不自动混算
    result.status = 'fee_held';
    result.feeHeld = true;
    result.holdReason = basisSwitch.message;
    result.basis = startVersion.billing_basis;
    return result;
  } else {
    basis = startVersion.billing_basis;
    result.basisSource = `协议 ${startVersion.agreement_id} v${startVersion.version}`;
  }
  result.basis = basis;

  // 暂停区间与占用区间不相交的预警（追溯用，不影响金额）
  for (const p of pauses) {
    if (!overlaps(stay.start.getTime(), endTime.getTime(), p.start, p.end)) {
      result.warnings.push({
        code: 'pause_outside_stay',
        text: `暂停区间 ${fmtDateTime(new Date(p.start))}~${fmtDateTime(new Date(p.end))} 与本占用段不相交，未生效`,
      });
    }
  }

  const units = basis === 'calendar_day'
    ? computeCalendarDay(stay, endTime, family, pauses, asOf)
    : computeRolling24h(stay, endTime, family, pauses, asOf);

  result.freeUnitsUsed = units.freeUnits;
  result.pauseUnits = units.pauseUnits;
  result.billableUnits = units.chargeable.length;

  // 逐计费单位落段
  const segments = [];
  for (const u of units.chargeable) {
    const agreement = opts.agreementIdForUnit
      ? family.find(a => a.agreement_id === opts.agreementIdForUnit(u)) || u.agreement
      : u.agreement;
    const type = u.type;
    const rate = rateFor(agreement, type, u.tierOrdinal);
    if (rate == null) {
      result.warnings.push({
        code: 'rate_missing',
        text: `${fmtDate(u.coverStart)} 箱型 ${type || '(未登记)'} 在协议 ${agreement.agreement_id} 中没有费率，该单位按 0 处理`,
      });
    }
    const unitRate = rate ?? 0;
    // 减免匹配：与计费单位覆盖区间相交且箱型匹配（空箱型=适用全部）
    const hitWaivers = waivers.filter(w =>
      overlaps(u.coverStart.getTime(), u.coverEnd.getTime(), w.start.getTime(), w.end.getTime()) &&
      (!w.containerType || w.containerType === type));
    const pct = hitWaivers.reduce((m, w) => Math.max(m, w.discountPct), 0);
    const gross = round2(unitRate);
    const discount = hitWaivers.length ? round2(gross * pct / 100) : 0;
    const net = round2(gross - discount);
    const mk = monthKey(u.billMoment);

    const seg = {
      id: 'SEG-' + (segments.length + 1),
      month: mk,
      basis,
      unitLabel: u.unitLabel,
      coverStart: u.coverStart,
      coverEnd: u.coverEnd,
      billMoment: u.billMoment,
      containerType: type,
      agreementId: agreement.agreement_id,
      agreementVersion: agreement.version,
      tierOrdinal: u.tierOrdinal,
      freeDays: agreement.free_days,
      rate: unitRate,
      rateBasisText: `${BASIS_LABEL[basis]} · 第 ${u.tierOrdinal} 计费单位 · ${type || '箱型未登记'} · 免费 ${agreement.free_days} 单位`,
      gross,
      waiverPct: pct,
      waiverIds: hitWaivers.map(w => w.id),
      waiverReasons: hitWaivers.map(w => w.reason).filter(Boolean),
      discount,
      net,
      pauseIds: u.pauseIds,
    };
    segments.push(seg);
    for (const w of hitWaivers) {
      if (!result.adjustmentsApplied.find(x => x.id === w.id)) {
        result.adjustmentsApplied.push({ id: w.id, type: w.type, reason: w.reason, discountPct: w.discountPct });
      }
    }
  }
  for (const p of pauses) {
    if (overlaps(stay.start.getTime(), endTime.getTime(), p.start, p.end)
      && !result.adjustmentsApplied.find(x => x.id === p.adj.id)) {
      result.adjustmentsApplied.push({ id: p.adj.id, type: 'pause', reason: p.adj.reason });
    }
  }

  // 合并展示段：同 月/箱型/协议版本/费率/减免比例/暂停 归并，保留每单位依据明细
  const merged = new Map();
  for (const s of segments) {
    const k = [s.month, s.containerType, s.agreementId, s.agreementVersion, s.tierOrdinal, s.rate, s.waiverPct, s.pauseIds.join('|')].join('§');
    if (!merged.has(k)) {
      // 金额字段从 0 起算，避免把首个单位的金额随展开复制进来后重复累计
      merged.set(k, { ...s, gross: 0, discount: 0, net: 0, unitCount: 0, unitDetails: [] });
    }
    const m = merged.get(k);
    m.unitCount += 1;
    m.gross = round2(m.gross + s.gross);
    m.discount = round2(m.discount + s.discount);
    m.net = round2(m.net + s.net);
    m.unitDetails.push({
      unitLabel: s.unitLabel,
      coverStart: s.coverStart,
      coverEnd: s.coverEnd,
      rate: s.rate,
      gross: s.gross,
      discount: s.discount,
      net: s.net,
      waiverIds: s.waiverIds,
      pauseIds: s.pauseIds,
    });
    m.coverEnd = s.coverEnd; // 保留最后一个单位的结束时刻
  }
  result.segments = [...merged.values()].sort((a, b) => a.coverStart - b.coverStart);

  // 按月汇总
  for (const s of result.segments) {
    if (!result.months[s.month]) result.months[s.month] = { gross: 0, discount: 0, net: 0, units: 0 };
    const m = result.months[s.month];
    m.gross = round2(m.gross + s.gross);
    m.discount = round2(m.discount + s.discount);
    m.net = round2(m.net + s.net);
    m.units += s.unitCount;
  }
  result.grossTotal = round2(result.segments.reduce((n, s) => n + s.gross, 0));
  result.discountTotal = round2(result.segments.reduce((n, s) => n + s.discount, 0));
  result.netTotal = round2(result.segments.reduce((n, s) => n + s.net, 0));

  if (result.feeHeld) result.status = 'fee_held';
  else if (result.netTotal === 0 && result.billableUnits === 0) result.status = 'zero_fee';
  else if (stay.open) result.status = 'provisional';
  else result.status = 'final';

  result.summaryLine = buildSummary(result);
  return result;
}

function buildSummary(r) {
  if (r.feeHeld) return `费用挂起：${r.holdReason}`;
  const parts = [
    `${BASIS_LABEL[r.basis]}口径`,
    `免费期内 ${r.freeUnitsUsed} 单位`,
    `暂停剔除 ${r.pauseUnits} 单位`,
    `计费 ${r.billableUnits} 单位`,
    `应收 ${fmtMoney(r.netTotal)}`,
  ];
  if (r.discountTotal > 0) parts.splice(4, 0, `减免 ${fmtMoney(r.discountTotal)}`);
  if (r.provisional) parts.push('在场预提，非最终账单');
  return parts.join(' · ');
}

// ---------------- 自然日口径 ----------------
// 规则（页面与 README 同步声明）：
// 1) 进场当日计第 1 个自然日，出场当日不计；暂停覆盖的自然日不计费且不消耗免费期，免费期顺延；
// 2) 免费期与费率档位均按"当日适用的协议版本"各自起算——占用期间协议修订，
//    新版本重新授予免费期、费率档位从 1 重新累计，旧版本已用免费期不回滚；
// 3) 当日费用取当日日首箱型对应的费率。
function computeCalendarDay(stay, endTime, family, pauses, asOf) {
  const startDay = utcDayStart(stay.start.getTime());
  let endExclusiveDay = utcDayStart(endTime.getTime()) + DAY_MS;
  if (!stay.open && endTime.getTime() < endExclusiveDay) {
    // 出场当日不计：截止时刻落在某自然日内时，该日整段移出枚举
    endExclusiveDay = utcDayStart(endTime.getTime());
  }
  if (stay.open) {
    // 在场预提：未走完的当天不计入，绝不把还没结束的堆存提前出账
    endExclusiveDay = utcDayStart(endTime.getTime());
  }
  const days = eachUTCDay(startDay, endExclusiveDay);
  const chargeable = [];
  let freeUnits = 0, pauseUnits = 0;
  let lastVersionKey = null;
  let versionFreeUsed = 0, billableOrdinal = 0;

  for (const dayStart of days) {
    const dayEnd = dayStart + DAY_MS;
    if (pausesOverlapping(pauses, dayStart, dayEnd).length) {
      pauseUnits += 1;
      continue;
    }
    const agreement = versionAt(family, new Date(dayStart)) || family[family.length - 1];
    const vk = agreement.agreement_id + '#v' + agreement.version;
    if (vk !== lastVersionKey) {
      // 进入新协议版本：免费期与档位重新起算（首个计费日即第 1 档）
      lastVersionKey = vk;
      versionFreeUsed = 0;
      billableOrdinal = 1;
    }
    const type = typeAt(stay, new Date(dayStart)); // 日首箱型决定当日费率
    if (versionFreeUsed < agreement.free_days) {
      versionFreeUsed += 1;
      freeUnits += 1;
      continue;
    }
    chargeable.push({
      coverStart: new Date(dayStart),
      coverEnd: new Date(dayEnd),
      billMoment: new Date(dayStart), // 自然日费用归属当日
      unitLabel: fmtDate(new Date(dayStart)),
      type,
      agreement,
      tierOrdinal: billableOrdinal,
      pauseIds: [],
    });
    billableOrdinal += 1;
  }
  return { chargeable, freeUnits, pauseUnits };
}

// ---------------- 满24小时口径 ----------------
// 从进场时刻起每 24h 切一块，凑满一块才产生一个计费单位，不足 24h 的零头不计；
// 暂停覆盖的整块剔除，时钟顺延、不消耗免费期；
// 块归属以块起始时刻适用的协议版本为准，跨版本时免费期与档位同样重新起算。
function computeRolling24h(stay, endTime, family, pauses, asOf) {
  const t0 = stay.start.getTime();
  const tEnd = endTime.getTime();
  const chargeable = [];
  let freeUnits = 0, pauseUnits = 0;
  let cursor = t0;
  let blockOrdinal = 0;
  let lastVersionKey = null;
  let versionFreeUsed = 0, tierOrdinal = 0;

  while (cursor < tEnd) {
    const blockEnd = cursor + DAY_MS;
    if (blockEnd > tEnd) break; // 不足 24h 的零头不计（在场箱同理，预提只认整块）
    blockOrdinal += 1;
    if (pausesOverlapping(pauses, cursor, blockEnd).length) {
      pauseUnits += 1;
      cursor = blockEnd;
      continue;
    }
    const agreement = versionAt(family, new Date(cursor)) || family[family.length - 1];
    const vk = agreement.agreement_id + '#v' + agreement.version;
    if (vk !== lastVersionKey) {
      lastVersionKey = vk;
      versionFreeUsed = 0;
      tierOrdinal = 1;
    }
    if (versionFreeUsed < agreement.free_days) {
      versionFreeUsed += 1;
      freeUnits += 1;
      cursor = blockEnd;
      continue;
    }
    chargeable.push({
      coverStart: new Date(cursor),
      coverEnd: new Date(blockEnd),
      billMoment: new Date(blockEnd), // 满 24h 的完成时刻确认费用并归属月份
      unitLabel: `${fmtDateTime(new Date(cursor))} → ${fmtDateTime(new Date(blockEnd))}`,
      type: typeAt(stay, new Date(blockEnd - 1)),
      agreement,
      tierOrdinal,
      pauseIds: [],
    });
    tierOrdinal += 1;
    cursor = blockEnd;
  }
  return { chargeable, freeUnits, pauseUnits };
}
