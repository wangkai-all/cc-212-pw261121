// 占用区间重建：按箱把事件流还原为一段段实际占用（stay）。
// 设计原则：冲突只登记、不猜测——绝不自动拼出数据里不存在的占用时段。
// 纯函数：输入原始事件 + 人工处理决定，输出 stays / conflicts / warnings。

import { uid } from './util.js';

// 确定性冲突 id：同一数据无论重算多少次，冲突 id 不变，人工决定才能稳定匹配
function conflictId(type, containerNo, eventId) {
  const key = `${type}|${containerNo}|${eventId || ''}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return 'C-' + (h >>> 0).toString(36);
}

export function reconstruct(allEvents, resolutions = {}, asOf = new Date()) {
  const byContainer = new Map();
  const conflicts = [];
  const seenEventIds = new Map();

  const addConflict = (c) => {
    const full = {
      id: conflictId(c.type, c.containerNo, c.eventId),
      severity: 'block',
      resolution: null,
      ...c,
    };
    conflicts.push(full);
    return full;
  };

  // 重复 event_id 检查
  for (const ev of allEvents) {
    if (seenEventIds.has(ev.id)) {
      addConflict({
        containerNo: ev.containerNo,
        type: 'duplicate_event_id',
        severity: 'warn',
        message: `事件编号 ${ev.id} 重复（${seenEventIds.get(ev.id).containerNo} 与 ${ev.containerNo}）`,
        eventId: ev.id,
        eventTime: ev.time,
      });
    } else seenEventIds.set(ev.id, ev);
  }

  for (const ev of allEvents) {
    if (!byContainer.has(ev.containerNo)) byContainer.set(ev.containerNo, []);
    byContainer.get(ev.containerNo).push(ev);
  }

  const stays = [];

  for (const [containerNo, events] of byContainer) {
    events.sort((a, b) => a.time - b.time || a.lineNo - b.lineNo);
    let open = null;

    for (const ev of events) {
      if (ev.type === 'gate_in') {
        if (open) {
          const c = addConflict({
            containerNo,
            type: 'dup_gate_in',
            message: `重复进场：${ev.time.toISOString()} 进场时上一次进场（${open.start.toISOString()}）尚未出场`,
            eventId: ev.id,
            eventTime: ev.time,
            options: [
              { value: 'ignore', label: '忽略该重复进场，保留原占用段' },
              { value: 'replace_start', label: '以本次进场作为占用开始（原进场留痕）' },
            ],
          });
          open.eventIds.push(ev.id);
          open.conflictIds.push(c.id);
          c.stayId = open.id;
          const r = resolutions[c.id]?.resolution;
          c.resolution = r || null;
          if (r?.action === 'replace_start') {
            // 人工裁定以本次进场作为占用开始，原进场仅留痕
            if (!open.replacedStarts) open.replacedStarts = [];
            open.replacedStarts.push({ from: new Date(open.start), to: new Date(ev.time), conflictId: c.id });
            open.start = ev.time;
            open.startEventId = ev.id;
            open.typeTimeline = [{ from: new Date(ev.time), type: ev.raw?.initial_type || '' }];
          }
          continue;
        }
        open = {
          id: uid('S'),
          containerNo,
          start: ev.time,
          startEventId: ev.id,
          end: null,
          endEventId: null,
          open: true,
          backfilled: false,
          needsManualStart: false,
          typeTimeline: [{ from: new Date(ev.time), type: ev.raw?.initial_type || '' }],
          moves: [],
          eventIds: [ev.id],
          conflictIds: [],
          warnings: [],
        };
        stays.push(open);
      } else if (ev.type === 'gate_out') {
        if (!open) {
          const c = addConflict({
            containerNo,
            type: 'orphan_gate_out',
            message: `先出后进：${ev.time.toISOString()} 出场找不到对应的进场事件`,
            eventId: ev.id,
            eventTime: ev.time,
            options: [
              { value: 'ignore', label: '忽略该出场事件' },
              { value: 'backfill_pending', label: '登记为补录出场，占位待人工补填进场时间（不计费）' },
            ],
          });
          const res = resolutions[c.id]?.resolution;
          if (res?.action === 'backfill_pending') {
            open = {
              id: uid('S'),
              containerNo,
              start: null,
              startEventId: null,
              end: ev.time,
              endEventId: ev.id,
              open: false,
              backfilled: true,
              needsManualStart: true,
              typeTimeline: [],
              moves: [],
              eventIds: [ev.id],
              conflictIds: [c.id],
              warnings: [],
            };
            stays.push(open);
          }
          continue;
        }
        const wasBackfilled = !!(ev.recordedAt && ev.recordedAt.getTime() > ev.time.getTime());
        open.end = ev.time;
        open.endEventId = ev.id;
        open.open = false;
        open.backfilled = wasBackfilled;
        if (wasBackfilled) {
          open.warnings.push({
            code: 'backfilled_gate_out',
            text: `补录出场：事件发生于 ${ev.time.toISOString()}，系统登记于 ${ev.recordedAt.toISOString()}`,
            eventId: ev.id,
          });
        }
        open.eventIds.push(ev.id);
        open = null;
      } else if (ev.type === 'move') {
        if (open) {
          open.moves.push({ time: ev.time, location: ev.location, eventId: ev.id });
          open.eventIds.push(ev.id);
        } else {
          addConflict({
            containerNo,
            type: 'event_outside_stay',
            severity: 'warn',
            message: `移箱事件 ${ev.time.toISOString()} 不处于任何占用区间内，已挂起不参与计费`,
            eventId: ev.id,
            eventTime: ev.time,
            options: [{ value: 'ignore', label: '知悉，忽略' }],
          });
        }
      } else if (ev.type === 'type_change') {
        if (open) {
          open.typeTimeline.push({ from: new Date(ev.time), type: ev.newType, eventId: ev.id });
          open.eventIds.push(ev.id);
        } else {
          addConflict({
            containerNo,
            type: 'event_outside_stay',
            severity: 'warn',
            message: `箱型变化事件 ${ev.time.toISOString()} 不处于任何占用区间内，已挂起不参与计费`,
            eventId: ev.id,
            eventTime: ev.time,
            options: [{ value: 'ignore', label: '知悉，忽略' }],
          });
        }
      }
    }
  }

  // 把人工决定同步到冲突对象（dup_gate_in / orphan 的动作已在状态机内即时生效）
  for (const c of conflicts) {
    c.resolution = resolutions[c.id]?.resolution || c.resolution || null;
  }

  // 未结束的占用：标记为在场，计费截止 asOf（预提，不是最终账单）
  for (const s of stays) {
    if (s.open) {
      s.provisionalAsOf = new Date(asOf);
    }
  }

  // 按容器、开始时间排序输出
  stays.sort((a, b) => {
    const ta = a.start ? a.start.getTime() : Infinity;
    const tb = b.start ? b.start.getTime() : Infinity;
    return ta - tb || a.containerNo.localeCompare(b.containerNo);
  });

  // 暂停/减免是否落在占用区间内的预警
  const warnings = [];
  return { stays, conflicts, warnings };
}

// 某一时刻生效的箱型（取 typeTimeline 中 from <= t 的最后一条）
export function typeAt(stay, t) {
  let cur = stay.typeTimeline[0]?.type || '';
  for (const tl of stay.typeTimeline) {
    if (tl.from.getTime() <= t.getTime()) cur = tl.type;
    else break;
  }
  return cur;
}
