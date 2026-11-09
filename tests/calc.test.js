// Run with:  node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  spanMinutes,
  startOfWeek,
  addDays,
  mergeIntervals,
  fmtHM,
  fmtHours,
  toTs,
  minToTime,
  toCSV,
  parseNum,
} from '../js/util.js';
import {
  shiftMinutes,
  shiftAllowanceTotal,
  summariseShifts,
  jobMinutes,
  vacuumRunStart,
  vacuumStats,
  dailyRunTime,
} from '../js/lib/calc.js';

const H = 3600000;
const M = 60000;

test('spanMinutes handles normal, overnight and equal times', () => {
  assert.equal(spanMinutes('07:00', '15:30'), 510);
  assert.equal(spanMinutes('22:00', '06:00'), 480);
  assert.equal(spanMinutes('23:45', '00:15'), 30);
  assert.equal(spanMinutes('08:00', '08:00'), 0);
});

test('minToTime wraps around midnight', () => {
  assert.equal(minToTime(0), '00:00');
  assert.equal(minToTime(1439), '23:59');
  assert.equal(minToTime(1440 + 65), '01:05');
  assert.equal(minToTime(-30), '23:30');
});

test('startOfWeek respects the chosen first day', () => {
  // 2026-11-09 is a Monday
  assert.equal(startOfWeek('2026-11-09', 1), '2026-11-09');
  assert.equal(startOfWeek('2026-11-15', 1), '2026-11-09'); // Sunday → previous Monday
  assert.equal(startOfWeek('2026-11-15', 0), '2026-11-15'); // Sunday-start week
  assert.equal(startOfWeek('2026-11-11', 0), '2026-11-08');
  assert.equal(startOfWeek('2026-11-11', 3), '2026-11-11'); // Wednesday start
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('formatting of hours', () => {
  assert.equal(fmtHM(510), '8h 30m');
  assert.equal(fmtHM(480), '8h');
  assert.equal(fmtHM(45), '45m');
  assert.equal(fmtHours(510), '8.50');
  assert.equal(fmtHours(445), '7.42');
});

test('shift minutes subtract the unpaid break', () => {
  assert.equal(shiftMinutes({ start: '06:00', finish: '14:30', breakMin: 30 }), 480);
  assert.equal(shiftMinutes({ start: '18:00', finish: '02:00', breakMin: 0 }), 480);
  assert.equal(shiftMinutes({ start: '08:00', finish: '08:10', breakMin: 30 }), 0);
});

test('allowances: one-off and hourly-for-the-day', () => {
  const shift = {
    start: '07:00',
    finish: '15:30',
    breakMin: 30, // 8 paid hours
    allowances: [
      { name: 'Meal', type: 'fixed', amount: 20 },
      { name: 'Height', type: 'hourly', amount: 1.5 },
    ],
  };
  assert.equal(shiftAllowanceTotal(shift), 20 + 12);
  const sum = summariseShifts([shift, { ...shift, date: 'x' }]);
  assert.equal(sum.minutes, 960);
  assert.equal(sum.allowances, 64);
  assert.deepEqual(
    sum.byAllowance.map((r) => [r.name, r.count, r.total]),
    [
      ['Meal', 2, 40],
      ['Height', 2, 24],
    ],
  );
});

test('job minutes count running jobs up to now', () => {
  assert.equal(jobMinutes({ date: '2026-11-09', start: '20:00', finish: '04:00' }), 480);
  const now = toTs('2026-11-09', '09:15');
  assert.equal(jobMinutes({ date: '2026-11-09', start: '08:00', finish: null }, now), 75);
});

test('mergeIntervals joins overlaps and small gaps', () => {
  const out = mergeIntervals(
    [
      { start: 10, end: 20 },
      { start: 15, end: 30 },
      { start: 32, end: 40 },
      { start: 100, end: 110 },
    ],
    2,
  );
  assert.deepEqual(out, [
    { start: 10, end: 40 },
    { start: 100, end: 110 },
  ]);
});

test('vacuum consecutive run joins hoses on the same vacuum', () => {
  const t0 = toTs('2026-11-09', '06:00');
  const now = t0 + 5 * H;
  const sessions = [
    // Hose A 06:00–08:00, hose B 07:59 → still running: one unbroken run from 06:00
    { hoseId: 'a', assetId: 'vac1', start: t0, end: t0 + 2 * H },
    { hoseId: 'b', assetId: 'vac1', start: t0 + 2 * H - M, end: null },
    // Earlier run on vac1 that ended long before
    { hoseId: 'a', assetId: 'vac1', start: t0 - 10 * H, end: t0 - 8 * H },
    // vac2 not running
    { hoseId: 'c', assetId: 'vac2', start: t0, end: t0 + H },
  ];
  assert.equal(vacuumRunStart(sessions, 'vac1', now), t0);
  assert.equal(vacuumRunStart(sessions, 'vac2', now), null);

  // A gap longer than the tolerance starts a new run
  const gapped = [
    { hoseId: 'a', assetId: 'vac1', start: t0, end: t0 + H },
    { hoseId: 'b', assetId: 'vac1', start: t0 + H + 10 * M, end: null },
  ];
  assert.equal(vacuumRunStart(gapped, 'vac1', now), t0 + H + 10 * M);
});

test('vacuum stats clip to the range and count on/off', () => {
  const day = '2026-11-09';
  const rs = toTs(day);
  const re = toTs(addDays(day, 1));
  const sessions = [
    // Started the previous evening, off at 02:00 → 2h in range, off counted, on not
    { hoseId: 'a', hoseName: 'Fwd dry', assetId: 'v1', assetName: 'Vac 1', start: rs - 3 * H, end: rs + 2 * H },
    // 08:00–10:00 on hose a
    { hoseId: 'a', hoseName: 'Fwd dry', assetId: 'v1', assetName: 'Vac 1', start: rs + 8 * H, end: rs + 10 * H },
    // 09:00–12:00 on hose b, same vacuum (overlaps)
    { hoseId: 'b', hoseName: 'Aft wet', assetId: 'v1', assetName: 'Vac 1', start: rs + 9 * H, end: rs + 12 * H },
  ];
  const st = vacuumStats(sessions, rs, re, re);
  assert.equal(st.on, 2);
  assert.equal(st.off, 3);
  assert.equal(st.hoseMs, (2 + 2 + 3) * H);
  // Vacuum: 00:00–02:00 and 08:00–12:00 = 6h, 1 run started in range
  assert.equal(st.vacMs, 6 * H);
  assert.equal(st.vacuums[0].runs, 1);
  const a = st.hoses.find((h) => h.id === 'a');
  assert.equal(a.on, 1);
  assert.equal(a.off, 2);
  assert.equal(a.ms, 4 * H);

  const daily = dailyRunTime(sessions, ['2026-11-08', day], re);
  assert.equal(daily[0].ms, 3 * H);
  assert.equal(daily[1].ms, 7 * H);
});

test('handing over to night shift is not counted as turning off', () => {
  const day = '2026-11-09';
  const rs = toTs(day);
  const re = toTs(addDays(day, 1));
  const sessions = [
    { hoseId: 'a', hoseName: 'Fwd dry', assetId: 'v1', start: rs + 7 * H, end: rs + 9 * H },
    { hoseId: 'a', hoseName: 'Fwd dry', assetId: 'v1', start: rs + 10 * H, end: rs + 17 * H, endReason: 'handover' },
    { hoseId: 'b', hoseName: 'Aft wet', assetId: 'v1', start: rs + 12 * H, end: rs + 17 * H, endReason: 'handover' },
  ];
  const st = vacuumStats(sessions, rs, re, re);
  assert.equal(st.on, 3);
  assert.equal(st.off, 1);
  assert.equal(st.handover, 2);
  // Only the time up to the handover counts
  assert.equal(st.hoseMs, (2 + 7 + 5) * H);
  assert.equal(st.vacMs, (2 + 7) * H);
  assert.deepEqual(
    st.hoses.map((h) => [h.id, h.off, h.handover]),
    [
      ['a', 1, 1],
      ['b', 0, 1],
    ],
  );
});

test('CSV quoting and number parsing', () => {
  assert.equal(toCSV([['a', 'b,c', 'say "hi"']]), 'a,"b,c","say ""hi"""');
  assert.equal(parseNum('12,345.6'), 12345.6);
  assert.equal(parseNum(''), null);
  assert.equal(parseNum('abc'), null);
});
