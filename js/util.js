// Small, dependency-free helpers shared by every page.
// Dates are handled as local "YYYY-MM-DD" strings and times as "HH:MM" (24h)
// so nothing shifts when the phone's timezone is ahead of UTC.

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const pad2 = (n) => String(n).padStart(2, '0');
export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------------------------------------------------------------- dates

/** Local calendar date as YYYY-MM-DD. (Never toISOString(): that is UTC.) */
export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export const todayStr = () => dateStr(new Date());

export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(str, n) {
  const d = parseDate(str);
  d.setDate(d.getDate() + n);
  return dateStr(d);
}

/** First day of the week containing `str`. weekStartsOn: 0 = Sunday … 6 = Saturday. */
export function startOfWeek(str, weekStartsOn = 1) {
  const d = parseDate(str);
  const diff = (d.getDay() - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
  return dateStr(d);
}

export const weekDates = (startStr) => Array.from({ length: 7 }, (_, i) => addDays(startStr, i));

export const startOfMonth = (str) => str.slice(0, 8) + '01';

export function addMonths(str, n) {
  const d = parseDate(startOfMonth(str));
  d.setMonth(d.getMonth() + n);
  return dateStr(d);
}

/** Every date from `from` up to (not including) `to`. */
export function datesBetween(from, to) {
  const out = [];
  for (let d = from; d < to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------- times

export function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function minToTime(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/**
 * Minutes from start to finish. A finish earlier than the start is treated as
 * the next day (night shift). Identical times give 0.
 */
export function spanMinutes(start, finish) {
  const s = timeToMin(start);
  const f = timeToMin(finish);
  if (f === s) return 0;
  return f > s ? f - s : f + 1440 - s;
}

export const isOvernight = (start, finish) => timeToMin(finish) < timeToMin(start);

/** Timestamp (ms) for a local date + HH:MM. */
export function toTs(date, time = '00:00') {
  const d = parseDate(date);
  const m = timeToMin(time);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return d.getTime();
}

export const tsDate = (ts) => dateStr(new Date(ts));
export function tsTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export const nowTime = () => tsTime(Date.now());

// ---------------------------------------------------------------- formatting

/** 510 → "8h 30m" */
export function fmtHM(min) {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${pad2(m)}m` : `${h}h`;
}

/** 510 → "8.50" (decimal hours, the way payslips show them) */
export const fmtHours = (min) => (Math.round(min) / 60).toFixed(2);

/** Live running clock: "2:14:05", or "1d 3h 05m" once past a day. */
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h ${pad2(m)}m`;
  return `${h}:${pad2(m)}:${pad2(s % 60)}`;
}

export const fmtDur = (ms) => fmtHM(ms / 60000);
export const msToHours = (ms) => ms / 3600000;

const dtfCache = new Map();
function dtf(opts) {
  const key = JSON.stringify(opts);
  if (!dtfCache.has(key)) dtfCache.set(key, new Intl.DateTimeFormat(undefined, opts));
  return dtfCache.get(key);
}

/** "Mon 9 Nov" (order follows the phone's locale) */
export const fmtDate = (str, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  dtf(opts).format(parseDate(str));
export const fmtDateFull = (str) =>
  fmtDate(str, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const fmtDayName = (str) => fmtDate(str, { weekday: 'short' });
export const fmtMonth = (str) => fmtDate(str, { month: 'long', year: 'numeric' });

export function fmtTime(t, use12h = false) {
  if (!t) return '';
  if (!use12h) return t;
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad2(m)}${h < 12 ? 'am' : 'pm'}`;
}

export function fmtDateTime(ts, use12h = false) {
  const date = tsDate(ts);
  const time = fmtTime(tsTime(ts), use12h);
  return date === todayStr() ? time : `${fmtDate(date)} ${time}`;
}

export const fmtMoney = (n) =>
  '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtNum = (n, maxFrac = 1) =>
  Number(n).toLocaleString(undefined, { maximumFractionDigits: maxFrac });

export function fmtAgo(ts, now = Date.now()) {
  const min = Math.round((now - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

// ---------------------------------------------------------------- intervals

/**
 * Merge {start, end} intervals (ms). Gaps no bigger than `tolerance` are joined,
 * so swapping from one hose to another doesn't count as the vacuum stopping.
 */
export function mergeIntervals(list, tolerance = 0) {
  const sorted = list
    .filter((i) => i.end >= i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end + tolerance) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

/** Length of the overlap between [s, e) and [rs, re). */
export const overlap = (s, e, rs, re) => Math.max(0, Math.min(e, re) - Math.max(s, rs));

// ---------------------------------------------------------------- misc

export const byName = (a, b) =>
  String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' });

export const sum = (arr, fn = (x) => x) => arr.reduce((t, x) => t + (Number(fn(x)) || 0), 0);

export function parseNum(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

/** Tab-separated: pastes straight into Excel / Google Sheets cells. */
export const toTSV = (rows) =>
  rows.map((r) => r.map((v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');

export function downloadFile(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Opens the phone's share sheet. Returns false if sharing isn't available. */
export async function shareText(title, text) {
  if (!navigator.share) return false;
  try {
    await navigator.share({ title, text });
  } catch (e) {
    if (e?.name !== 'AbortError') return false;
  }
  return true;
}
