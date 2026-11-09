// Pure calculations (no DOM, no storage) so they can be unit tested.
import { spanMinutes, mergeIntervals, overlap, toTs, addDays, sum } from '../util.js';

// ---------------------------------------------------------------- shifts

/** Paid minutes for a shift: finish − start (overnight aware) − unpaid break. */
export function shiftMinutes(shift) {
  return Math.max(0, spanMinutes(shift.start, shift.finish) - (Number(shift.breakMin) || 0));
}

/** Dollar value of one allowance line on a shift. Hourly = rate × paid hours that day. */
export function allowanceValue(allowance, minutes) {
  const amount = Number(allowance.amount) || 0;
  return allowance.type === 'hourly' ? (amount * minutes) / 60 : amount;
}

export function shiftAllowanceTotal(shift) {
  const minutes = shiftMinutes(shift);
  return sum(shift.allowances || [], (a) => allowanceValue(a, minutes));
}

/** Totals for a set of shifts (e.g. one week). */
export function summariseShifts(shifts) {
  const minutes = sum(shifts, shiftMinutes);
  const allowances = sum(shifts, shiftAllowanceTotal);
  const days = new Set(shifts.map((s) => s.date)).size;
  // Allowance totals grouped by name
  const byAllowance = new Map();
  for (const s of shifts) {
    const mins = shiftMinutes(s);
    for (const a of s.allowances || []) {
      const row = byAllowance.get(a.name) || { name: a.name, type: a.type, count: 0, total: 0 };
      row.count += 1;
      row.total += allowanceValue(a, mins);
      byAllowance.set(a.name, row);
    }
  }
  return { minutes, allowances, days, byAllowance: [...byAllowance.values()] };
}

// ---------------------------------------------------------------- sentry

/** Minutes for a sentry/job entry; an unfinished one counts up to `now`. */
export function jobMinutes(entry, now = Date.now()) {
  if (!entry.finish) return Math.max(0, (now - toTs(entry.date, entry.start)) / 60000);
  return spanMinutes(entry.start, entry.finish);
}

export function groupMinutes(entries, keyFn, nameFn, now = Date.now()) {
  const map = new Map();
  for (const e of entries) {
    const key = keyFn(e) ?? '';
    const row = map.get(key) || { key, name: nameFn(e), minutes: 0, count: 0 };
    row.minutes += jobMinutes(e, now);
    row.count += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.minutes - a.minutes);
}

// ---------------------------------------------------------------- vacuum

/** Gaps shorter than this between hoses on one vacuum still count as "running". */
export const VAC_GAP_MS = 2 * 60 * 1000;

export const openSessionFor = (sessions, hoseId) =>
  sessions.find((s) => s.hoseId === hoseId && s.end == null);

/**
 * When the vacuum (asset) started its current unbroken run, or null if none of
 * its hoses is on. Overlapping / back-to-back hose sessions are joined.
 */
export function vacuumRunStart(sessions, assetId, now = Date.now(), gap = VAC_GAP_MS) {
  const mine = sessions.filter((s) => s.assetId === assetId);
  if (!mine.some((s) => s.end == null)) return null;
  const blocks = mergeIntervals(
    mine.map((s) => ({ start: s.start, end: s.end ?? now })),
    gap,
  );
  const live = blocks.filter((b) => b.end >= now - 1);
  return live.length ? live[live.length - 1].start : null;
}

/** Day / week / month range → [startTs, endTs) */
export function rangeBounds(from, to) {
  return [toTs(from), toTs(to)];
}

/**
 * Stats for hose sessions within [rs, re).
 * - on / off: how many times hoses were turned on / off inside the range
 * - handover: runs ended by handing over to night shift (not counted as "off")
 * - ms: running time inside the range (sessions are clipped to the range)
 */
export function vacuumStats(sessions, rs, re, now = Date.now(), gap = VAC_GAP_MS) {
  const hoses = new Map();
  let on = 0;
  let off = 0;
  let handover = 0;
  let hoseMs = 0;

  for (const s of sessions) {
    const end = s.end ?? now;
    const ms = overlap(s.start, end, rs, re);
    const turnedOn = s.start >= rs && s.start < re;
    const endedInRange = s.end != null && s.end >= rs && s.end < re;
    const handedOver = endedInRange && s.endReason === 'handover';
    const turnedOff = endedInRange && !handedOver;
    if (!ms && !turnedOn && !endedInRange) continue;
    const row = hoses.get(s.hoseId) || {
      id: s.hoseId,
      name: s.hoseName,
      on: 0,
      off: 0,
      handover: 0,
      ms: 0,
      longest: 0,
    };
    row.on += turnedOn ? 1 : 0;
    row.off += turnedOff ? 1 : 0;
    row.handover += handedOver ? 1 : 0;
    row.ms += ms;
    row.longest = Math.max(row.longest, ms);
    hoses.set(s.hoseId, row);
    on += turnedOn ? 1 : 0;
    off += turnedOff ? 1 : 0;
    handover += handedOver ? 1 : 0;
    hoseMs += ms;
  }

  // Vacuum units: union of their hoses' running time.
  const byAsset = new Map();
  for (const s of sessions) {
    if (!s.assetId) continue;
    const arr = byAsset.get(s.assetId) || { id: s.assetId, name: s.assetName, iv: [] };
    arr.iv.push({ start: s.start, end: s.end ?? now });
    byAsset.set(s.assetId, arr);
  }
  const vacuums = [];
  let vacMs = 0;
  for (const a of byAsset.values()) {
    const blocks = mergeIntervals(a.iv, gap);
    let ms = 0;
    let runs = 0;
    let longest = 0;
    for (const b of blocks) {
      const d = overlap(b.start, b.end, rs, re);
      ms += d;
      longest = Math.max(longest, d);
      if (b.start >= rs && b.start < re) runs += 1;
    }
    if (ms || runs) {
      vacuums.push({ id: a.id, name: a.name, ms, runs, longest });
      vacMs += ms;
    }
  }

  const byMs = (a, b) => b.ms - a.ms;
  return {
    on,
    off,
    handover,
    hoseMs,
    vacMs,
    hoses: [...hoses.values()].sort(byMs),
    vacuums: vacuums.sort(byMs),
  };
}

/** Running time per calendar day for the given dates. */
export function dailyRunTime(sessions, dates, now = Date.now()) {
  return dates.map((date) => {
    const rs = toTs(date);
    const re = toTs(addDays(date, 1));
    const ms = sum(sessions, (s) => overlap(s.start, s.end ?? now, rs, re));
    return { date, ms };
  });
}
