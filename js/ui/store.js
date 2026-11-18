// 前端状态管理：原始数据 + 人工决定 + 审计日志，任何变化都整体重算（引擎是纯函数）

import { buildState } from '../engine/pipeline.js';
import { normalizeEvent, normalizeAdjustment, normalizeAgreement, eventToRow, adjToRow } from '../engine/models.js';
import { parseCSV, toCSV, toISO, uid } from '../engine/util.js';

const AS_OF = new Date('2026-11-18T12:00:00Z'); // 虚构数据的"当前时刻"，在场预提截止于此

export class AppStore {
  constructor() {
    this.events = [];
    this.adjustments = [];
    this.agreements = [];
    this.resolutions = {}; // 冲突 id -> { resolution, decidedAt, note }
    this.auditLog = [];
    this.state = null;
    this.listeners = new Set();
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.state); }

  log(action, detail) {
    this.auditLog.unshift({
      id: uid('LOG'),
      at: new Date(),
      action,
      detail,
    });
  }

  loadSample({ events: rawEvents, adjustments: rawAdj, agreements: rawAgs }) {
    this.events = rawEvents.map((row, i) => normalizeEvent(row, i + 2));
    this.adjustments = rawAdj.map((row, i) => normalizeAdjustment(row, i + 2));
    this.agreements = rawAgs.map(normalizeAgreement);
    this.resolutions = {};
    this.auditLog = [];
    this.log('载入样例数据', `事件 ${this.events.length} 条，调整 ${this.adjustments.length} 条，协议 ${this.agreements.length} 个版本`);
    this.recompute();
  }

  importEvents(csvText) {
    const rows = parseCSV(csvText);
    const incoming = rows.map((row, i) => normalizeEvent(row, i + 2));
    const before = this.events.length;
    this.events = this.events.concat(incoming);
    this.log('导入进场/出场/移箱/箱型变化', `新增 ${incoming.length} 条（原有 ${before} 条）`);
    this.recompute();
  }

  importAdjustments(csvText) {
    const rows = parseCSV(csvText);
    const incoming = rows.map((row, i) => normalizeAdjustment(row, i + 2));
    this.adjustments = this.adjustments.concat(incoming);
    this.log('导入暂停/减免', `新增 ${incoming.length} 条`);
    this.recompute();
  }

  importAgreements(jsonText) {
    const data = JSON.parse(jsonText);
    const list = Array.isArray(data) ? data : [data];
    const incoming = list.map(normalizeAgreement);
    this.agreements = this.agreements.concat(incoming);
    this.log('导入免费期协议', `新增 ${incoming.length} 个版本`);
    this.recompute();
  }

  resolveConflict(conflictId, action, note = '') {
    this.resolutions[conflictId] = {
      resolution: { action },
      decidedAt: toISO(new Date()),
      note,
    };
    this.log('人工处理冲突', `${conflictId} → ${action}${note ? '（' + note + '）' : ''}`);
    this.recompute();
  }

  resetResolution(conflictId) {
    if (this.resolutions[conflictId]) {
      delete this.resolutions[conflictId];
      this.log('撤销冲突处理', conflictId);
      this.recompute();
    }
  }

  recompute() {
    this.state = buildState(this.events, this.adjustments, this.agreements, {
      asOf: AS_OF,
      resolutions: this.resolutions,
      auditLog: this.auditLog,
    });
    this.emit();
  }

  // 导出账单明细（逐合并段，含月份/口径/箱型/费率/减免/净额/依据）
  billRows(filter = () => true) {
    const rows = [];
    for (const stay of this.state.stays) {
      const b = this.state.billings.get(stay.id);
      if (!filter(stay, b)) continue;
      if (b.feeHeld) {
        rows.push({
          箱号: stay.containerNo,
          占用段: `${toISO(stay.start || stay.end)} → ${stay.end ? toISO(stay.end) : '待补/在场'}`,
          状态: '费用挂起',
          月份: '',
          计费口径: '',
          计费单位标签: '',
          箱型: '',
          协议版本: '',
          费率: '',
          单位数: 0,
          原始金额: '',
          减免: '',
          应收金额: '',
          依据: b.holdReason,
        });
        continue;
      }
      for (const seg of b.segments) {
        rows.push({
          箱号: stay.containerNo,
          占用段: `${toISO(stay.start)} → ${stay.open ? '在场(预提)' : toISO(stay.end)}`,
          状态: b.provisional ? '预提(非最终账单)' : (b.status === 'zero_fee' ? '零费用' : '已结算'),
          月份: seg.month,
          计费口径: seg.basis === 'calendar_day' ? '自然日' : '满24小时',
          计费单位标签: seg.unitLabel,
          箱型: seg.containerType,
          协议版本: `${seg.agreementId} v${seg.agreementVersion}`,
          费率: seg.rate,
          单位数: seg.unitCount,
          原始金额: seg.gross,
          减免: seg.discount,
          应收金额: seg.net,
          依据: seg.rateBasisText + (seg.waiverPct ? `；减免${seg.waiverPct}%` : ''),
        });
      }
    }
    return rows;
  }

  exportBillCSV(filter) {
    return toCSV(this.billRows(filter));
  }

  exportEventsCSV() {
    return toCSV(this.events.map(eventToRow));
  }

  exportAdjustmentsCSV() {
    return toCSV(this.adjustments.map(adjToRow));
  }
}
