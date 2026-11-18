// 通用工具：时间（统一 UTC 口径）、数值、CSV 解析/序列化
// 所有样例时间戳均带 Z，按 UTC 自然日切分，保证测试与展示结果确定。

export const DAY_MS = 24 * 60 * 60 * 1000;

export function parseTime(s) {
  if (s instanceof Date) return new Date(s.getTime());
  if (typeof s !== 'string') throw new Error('时间格式非法: ' + String(s));
  const t = s.trim();
  if (!t) throw new Error('时间为空');
  const ms = Date.parse(t.endsWith('Z') || t.includes('+') ? t : t + 'Z');
  if (Number.isNaN(ms)) throw new Error('时间格式非法: ' + s);
  return new Date(ms);
}

export function toISO(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function utcDayStart(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function addUTCDays(dayStart, n) {
  return dayStart + n * DAY_MS;
}

export function diffCalendarDays(aTime, bTime) {
  // 两个时刻之间跨越的 UTC 自然日天数（b 的日历日 - a 的日历日）
  return Math.round((utcDayStart(bTime) - utcDayStart(aTime)) / DAY_MS);
}

export function eachUTCDay(dayStartA, dayStartExclusiveB) {
  const out = [];
  for (let t = dayStartA; t < dayStartExclusiveB; t += DAY_MS) out.push(t);
  return out;
}

export function fmtDate(t) {
  if (t == null) return '';
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function fmtDateTime(t) {
  if (t == null) return '';
  const d = new Date(t);
  return `${fmtDate(t)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function monthKey(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return '';
  return '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

// ---------- CSV ----------
// 支持引号包裹、引号转义("")、CRLF、UTF-8 BOM；返回对象数组（键取表头）。
export function parseCSV(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(v => v !== '')) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

export function toCSV(objs, headers) {
  const keys = headers || Object.keys(objs[0] || {});
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [keys.join(',')];
  for (const o of objs) lines.push(keys.map(k => esc(o[k])).join(','));
  return '﻿' + lines.join('\r\n');
}

export function download(filename, content, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
