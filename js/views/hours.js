// Hours worked: log each day's start/finish with scroll wheels, add any
// allowances, and see a weekly breakdown to check against the payslip.

import * as store from '../store.js';
import {
  esc,
  todayStr,
  startOfWeek,
  weekDates,
  addDays,
  fmtDate,
  fmtDateFull,
  fmtHM,
  fmtHours,
  fmtMoney,
  fmtTime,
  spanMinutes,
  isOvernight,
  copyText,
  shareText,
  sum,
} from '../util.js';
import { shiftMinutes, allowanceValue, shiftAllowanceTotal, summariseShifts } from '../lib/calc.js';
import { createTimePicker } from '../components/timepicker.js';
import { icon } from '../icons.js';
import { toast, confirmBox, periodNav, on, formError } from '../ui.js';
import { openEditor } from './manage.js';

const BREAKS = [0, 10, 15, 20, 30, 45, 60, 90];

let draft = null;
let weekAnchor = null;

function freshDraft(date = todayStr()) {
  // Default to the times of the last shift logged – most days are the same.
  const last = [...store.data().shifts].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).at(-1);
  return {
    id: null,
    day: todayStr(),
    date,
    start: last?.start ?? '07:00',
    finish: last?.finish ?? '15:30',
    breakMin: last?.breakMin ?? 0,
    allowances: [],
    notes: '',
  };
}

const use12 = () => store.settings().timeFormat === '12';
const t = (x) => fmtTime(x, use12());
const shiftsOn = (date) =>
  store
    .data()
    .shifts.filter((s) => s.date === date)
    .sort((a, b) => a.start.localeCompare(b.start));

// ---------------------------------------------------------------- render

export function render(root) {
  weekAnchor ??= todayStr();
  if (draft && !draft.id && draft.day !== todayStr()) draft = null;
  draft ??= freshDraft();

  root.innerHTML = `
    <section class="card" id="h-card"></section>
    <section class="card" id="h-week"></section>
    <section class="card" id="h-recent"></section>`;
  renderForm(root);
  renderWeek(root);
  renderRecent(root);
}

function renderForm(root) {
  const card = root.querySelector('#h-card');
  const st = store.settings();
  const allowanceList = store.list('allowances');
  const breakOpts = BREAKS.includes(Number(draft.breakMin)) ? BREAKS : [...BREAKS, Number(draft.breakMin)].sort((a, b) => a - b);

  card.innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${icon('clock')} ${draft.id ? 'Edit shift' : 'Log a shift'}</h2>
    </div>
    <form id="h-form" class="stack" novalidate>
      <div class="field">
        <label for="h-date">Date</label>
        <div class="row">
          <input type="date" id="h-date" class="grow" value="${draft.date}">
          <button type="button" class="btn btn-sm" id="h-today" ${draft.date === todayStr() ? 'disabled' : ''}>Today</button>
        </div>
        <small class="hint" id="h-dayname"></small>
      </div>
      <div class="time-pair">
        <div class="field"><span class="label">Start</span><div id="h-start"></div></div>
        <div class="field"><span class="label">Finish</span><div id="h-finish"></div></div>
      </div>
      <label class="field"><span>Unpaid break</span>
        <select id="h-break">${breakOpts.map((b) => `<option value="${b}" ${b === Number(draft.breakMin) ? 'selected' : ''}>${b ? fmtHM(b) : 'No break'}</option>`).join('')}</select>
      </label>
      <div class="calc" id="h-calc" aria-live="polite"></div>

      <fieldset class="field">
        <legend>Allowances <span class="muted">(optional)</span></legend>
        <div id="h-allow-list" class="allow-list"></div>
        <div class="row">
          <select id="h-allow-add" class="grow" aria-label="Add an allowance">
            <option value="">${allowanceList.length ? '+ Add an allowance…' : 'No allowances set up yet'}</option>
            ${allowanceList.map((a) => `<option value="${a.id}">${esc(a.name)} — ${a.type === 'hourly' ? `${fmtMoney(a.amount)}/h` : fmtMoney(a.amount)}</option>`).join('')}
          </select>
          <button type="button" class="icon-btn outline" id="h-allow-new" aria-label="Create a new allowance">${icon('plus')}</button>
        </div>
        <small class="hint">Set up the list in <a href="#/manage/allowances">Manage → Allowances</a>. Hourly allowances are paid on the day’s hours.</small>
      </fieldset>

      <label class="field"><span>Notes (optional)</span><input type="text" id="h-notes" value="${esc(draft.notes)}" placeholder="e.g. overtime, call-out"></label>
      <p class="form-error" hidden></p>
      <div class="btn-row">
        ${draft.id ? '<button type="button" class="btn" id="h-cancel">Cancel</button>' : ''}
        <button type="submit" class="btn btn-primary grow">${icon('check')} ${draft.id ? 'Save changes' : 'Save shift'}</button>
      </div>
      ${draft.id ? `<button type="button" class="btn btn-ghost btn-danger-text" id="h-delete">${icon('trash')} Delete this shift</button>` : ''}
      <p class="hint" id="h-existing"></p>
    </form>`;

  const $ = (s) => card.querySelector(s);
  const err = $('.form-error');

  const startPicker = createTimePicker({
    value: draft.start,
    use12h: st.timeFormat === '12',
    step: st.minuteStep,
    label: 'Start',
    onChange: (v) => {
      draft.start = v;
      updateCalc();
    },
  });
  const finishPicker = createTimePicker({
    value: draft.finish,
    use12h: st.timeFormat === '12',
    step: st.minuteStep,
    label: 'Finish',
    onChange: (v) => {
      draft.finish = v;
      updateCalc();
    },
  });
  $('#h-start').append(startPicker.el);
  $('#h-finish').append(finishPicker.el);

  function updateCalc() {
    const span = spanMinutes(draft.start, draft.finish);
    const mins = shiftMinutes(draft);
    const overnight = isOvernight(draft.start, draft.finish);
    const allowTotal = shiftAllowanceTotal(draft);
    $('#h-calc').innerHTML =
      span === 0
        ? '<span class="warn-text">Start and finish are the same.</span>'
        : `<div class="calc-main"><strong>${fmtHours(mins)} h</strong><span>${fmtHM(mins)}</span></div>
           <div class="calc-sub">${t(draft.start)} → ${t(draft.finish)}${overnight ? ' <span class="badge">next day</span>' : ''}${
             Number(draft.breakMin) ? ` · ${fmtHM(draft.breakMin)} break` : ''
           }<span class="calc-allow">${allowTotal ? ` · allowances ${fmtMoney(allowTotal)}` : ''}</span></div>`;
    renderAllowances();
  }

  function renderAllowances() {
    const mins = shiftMinutes(draft);
    $('#h-allow-list').innerHTML = draft.allowances
      .map(
        (a, i) => `
      <div class="allow-row">
        <div class="allow-name"><strong>${esc(a.name)}</strong><small>${a.type === 'hourly' ? `per hour × ${fmtHours(mins)} h` : 'one-off'}</small></div>
        <label class="money"><span aria-hidden="true">$</span><input type="number" inputmode="decimal" step="0.01" min="0" value="${a.amount}" data-i="${i}" aria-label="${esc(a.name)} amount"></label>
        <span class="allow-total">${fmtMoney(allowanceValue(a, mins))}</span>
        <button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(a.name)}">${icon('x')}</button>
      </div>`,
      )
      .join('');
  }

  const updateDay = () => {
    $('#h-dayname').textContent = draft.date ? fmtDateFull(draft.date) : '';
    $('#h-today').disabled = draft.date === todayStr();
    const others = draft.date ? shiftsOn(draft.date).filter((s) => s.id !== draft.id) : [];
    $('#h-existing').innerHTML = others.length
      ? `${icon('info')} Already logged on this day: ${others
          .map((s) => `${t(s.start)}–${t(s.finish)} (${fmtHours(shiftMinutes(s))} h)`)
          .join(', ')}. ${draft.id ? '' : 'Saving adds another entry (e.g. a split shift).'}`
      : '';
  };

  $('#h-date').addEventListener('change', (e) => {
    draft.date = e.target.value;
    updateDay();
  });
  $('#h-today').addEventListener('click', () => {
    draft.date = todayStr();
    $('#h-date').value = draft.date;
    updateDay();
  });
  $('#h-break').addEventListener('change', (e) => {
    draft.breakMin = Number(e.target.value);
    updateCalc();
  });
  $('#h-notes').addEventListener('input', (e) => (draft.notes = e.target.value));

  const addAllowance = (a) => {
    if (!a) return;
    if (draft.allowances.some((x) => x.allowanceId === a.id)) {
      toast(`${a.name} is already on this shift`);
      return;
    }
    draft.allowances.push({ allowanceId: a.id, name: a.name, type: a.type, amount: Number(a.amount) || 0 });
    updateCalc();
  };
  $('#h-allow-add').addEventListener('change', (e) => {
    addAllowance(store.get('allowances', e.target.value));
    e.target.value = '';
  });
  $('#h-allow-new').addEventListener('click', () =>
    openEditor('allowances', null, (a) => {
      // Add the new allowance to this shift, then re-render to refresh the dropdown.
      if (a) draft.allowances.push({ allowanceId: a.id, name: a.name, type: a.type, amount: Number(a.amount) || 0 });
      renderForm(root);
    }),
  );
  $('#h-allow-list').addEventListener('input', (e) => {
    const i = e.target.dataset.i;
    if (i == null) return;
    draft.allowances[i].amount = Number(e.target.value) || 0;
    // Update totals without re-rendering the input being typed in.
    const mins = shiftMinutes(draft);
    e.target.closest('.allow-row').querySelector('.allow-total').textContent = fmtMoney(allowanceValue(draft.allowances[i], mins));
    const allowTotal = shiftAllowanceTotal(draft);
    const allowEl = $('#h-calc .calc-allow');
    if (allowEl) allowEl.textContent = allowTotal ? ` · allowances ${fmtMoney(allowTotal)}` : '';
  });
  $('#h-allow-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    draft.allowances.splice(Number(btn.dataset.remove), 1);
    updateCalc();
  });

  $('#h-cancel')?.addEventListener('click', () => {
    draft = null;
    render(root);
  });
  $('#h-delete')?.addEventListener('click', async () => {
    if (!(await confirmBox(`Delete the shift on ${fmtDateFull(draft.date)}?`, { ok: 'Delete', danger: true }))) return;
    store.remove('shifts', draft.id);
    toast('Shift deleted');
    draft = null;
    render(root);
  });

  $('#h-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!draft.date) return formError(err, 'Pick a date.');
    const span = spanMinutes(draft.start, draft.finish);
    if (span === 0) return formError(err, 'Start and finish are the same — scroll the finish time.');
    if (Number(draft.breakMin) >= span) return formError(err, 'The break is as long as the shift.');
    formError(err, '');
    const saved = store.upsert('shifts', {
      id: draft.id || undefined,
      date: draft.date,
      start: draft.start,
      finish: draft.finish,
      breakMin: Number(draft.breakMin) || 0,
      allowances: draft.allowances.map((a) => ({ ...a, amount: Number(a.amount) || 0 })),
      notes: draft.notes.trim(),
    });
    toast(`${draft.id ? 'Updated' : 'Saved'} ${fmtHours(shiftMinutes(saved))} h on ${fmtDate(saved.date)}`);
    weekAnchor = saved.date;
    draft = null;
    render(root);
    root.querySelector('#h-week').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  updateDay();
  updateCalc();
}

function startEdit(root, s) {
  draft = { ...s, day: todayStr(), allowances: (s.allowances || []).map((a) => ({ ...a })), notes: s.notes || '' };
  render(root);
  root.querySelector('#h-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- weekly breakdown

function weekData(anchor) {
  const ws = startOfWeek(anchor, store.settings().weekStartsOn);
  const days = weekDates(ws);
  const shifts = store.data().shifts.filter((s) => s.date >= days[0] && s.date <= days[6]);
  return { ws, days, shifts, summary: summariseShifts(shifts) };
}

function weekText({ days, shifts, summary }) {
  const lines = [`Hours worked — week of ${fmtDateFull(days[0])}`, ''];
  for (const d of days) {
    const list = shifts.filter((s) => s.date === d).sort((a, b) => a.start.localeCompare(b.start));
    if (!list.length) {
      lines.push(`${fmtDate(d)}: —`);
      continue;
    }
    for (const s of list) {
      const extras = [s.breakMin ? `${s.breakMin}m break` : '', ...(s.allowances || []).map((a) => a.name)].filter(Boolean).join(', ');
      lines.push(`${fmtDate(d)}: ${t(s.start)}–${t(s.finish)} = ${fmtHours(shiftMinutes(s))} h${extras ? ` (${extras})` : ''}`);
    }
  }
  lines.push('', `Total: ${fmtHours(summary.minutes)} h (${fmtHM(summary.minutes)}) over ${summary.days} day${summary.days === 1 ? '' : 's'}`);
  if (summary.byAllowance.length) {
    lines.push(`Allowances: ${summary.byAllowance.map((a) => `${a.name} ×${a.count} = ${fmtMoney(a.total)}`).join('; ')}`);
    lines.push(`Allowance total: ${fmtMoney(summary.allowances)}`);
  }
  return lines.join('\n');
}

function renderWeek(root) {
  const card = root.querySelector('#h-week');
  const wk = weekData(weekAnchor);
  const { days, shifts, summary } = wk;
  const isThisWeek = wk.ws === startOfWeek(todayStr(), store.settings().weekStartsOn);
  const today = todayStr();

  card.innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${icon('calendar')} Week</h2>
      ${isThisWeek ? '' : '<button type="button" class="btn btn-sm btn-ghost" data-nav="0">This week</button>'}
    </div>
    ${periodNav({ label: `${fmtDate(days[0], { day: 'numeric', month: 'short' })} – ${fmtDate(days[6], { day: 'numeric', month: 'short', year: 'numeric' })}`, sub: isThisWeek ? 'This week' : '' })}
    <div class="stat-grid">
      <div class="stat stat-hero"><span class="stat-label">Hours worked</span><span class="stat-value">${fmtHours(summary.minutes)}</span><span class="stat-sub">${fmtHM(summary.minutes)}</span></div>
      <div class="stat"><span class="stat-label">Days worked</span><span class="stat-value">${summary.days}</span></div>
      <div class="stat"><span class="stat-label">Allowances</span><span class="stat-value">${fmtMoney(summary.allowances)}</span></div>
    </div>
    <ul class="day-list">
      ${days
        .map((d) => {
          const list = shifts.filter((s) => s.date === d).sort((a, b) => a.start.localeCompare(b.start));
          const dayMin = sum(list, shiftMinutes);
          return `
          <li class="day ${list.length ? '' : 'day-off'} ${d === today ? 'is-today' : ''}">
            <div class="day-name"><strong>${esc(fmtDate(d, { weekday: 'short' }))}</strong><small>${esc(fmtDate(d, { day: 'numeric', month: 'short' }))}</small></div>
            <div class="day-shifts">
              ${
                list.length
                  ? list
                      .map(
                        (s) => `
                <button type="button" class="shift-chip" data-id="${s.id}">
                  <span>${t(s.start)}–${t(s.finish)}${s.breakMin ? ` <small>· ${fmtHM(s.breakMin)} break</small>` : ''}</span>
                  ${(s.allowances || []).length ? `<small class="allow-tags">${s.allowances.map((a) => esc(a.name)).join(', ')} · ${fmtMoney(shiftAllowanceTotal(s))}</small>` : ''}
                  ${s.notes ? `<small class="muted">${esc(s.notes)}</small>` : ''}
                </button>`,
                      )
                      .join('')
                  : d > today
                    ? ''
                    : `<button type="button" class="add-day" data-add="${d}" aria-label="Add a shift on ${esc(fmtDate(d))}">+ add</button>`
              }
            </div>
            <div class="day-total">${list.length ? `<strong>${fmtHours(dayMin)}</strong><small>h</small>` : '<span class="muted">—</span>'}</div>
          </li>`;
        })
        .join('')}
    </ul>
    ${
      summary.byAllowance.length
        ? `<div class="allow-summary"><h3>Allowances this week</h3>${summary.byAllowance
            .map((a) => `<p class="kv"><span>${esc(a.name)} × ${a.count}</span><strong>${fmtMoney(a.total)}</strong></p>`)
            .join('')}</div>`
        : ''
    }
    <div class="btn-row wrap">
      <button type="button" class="btn btn-sm" data-act="copy">${icon('copy')} Copy week</button>
      <button type="button" class="btn btn-sm" data-act="share">${icon('share')} Share</button>
    </div>`;

  on(card, '[data-nav]', 'click', (_, el) => {
    const step = Number(el.dataset.nav);
    weekAnchor = step === 0 ? todayStr() : addDays(weekAnchor, step * 7);
    renderWeek(root);
  });
  on(card, '.shift-chip', 'click', (_, el) => {
    const s = store.get('shifts', el.dataset.id);
    if (s) startEdit(root, s);
  });
  on(card, '[data-add]', 'click', (_, el) => {
    draft = { ...(draft?.id ? freshDraft() : draft || freshDraft()), date: el.dataset.add };
    renderForm(root);
    root.querySelector('#h-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  on(card, '[data-act]', 'click', async (_, el) => {
    const text = weekText(wk);
    if (el.dataset.act === 'copy') toast((await copyText(text)) ? 'Week copied' : 'Copy failed');
    else if (!(await shareText('Hours worked', text))) {
      await copyText(text);
      toast('Sharing not available — copied instead');
    }
  });
}

function renderRecent(root) {
  const card = root.querySelector('#h-recent');
  const ws = store.settings().weekStartsOn;
  const thisWeek = startOfWeek(todayStr(), ws);
  const shifts = store.data().shifts;
  if (!shifts.length) {
    card.innerHTML = `<h2 class="card-title">${icon('chart')} Recent weeks</h2><p class="hint">Your weekly totals will appear here once you log some shifts.</p>`;
    return;
  }
  const weeks = Array.from({ length: 8 }, (_, i) => addDays(thisWeek, -7 * i));
  const rows = weeks.map((w) => {
    const end = addDays(w, 6);
    const list = shifts.filter((s) => s.date >= w && s.date <= end);
    return { w, ...summariseShifts(list) };
  });
  const max = Math.max(...rows.map((r) => r.minutes), 1);
  card.innerHTML = `
    <h2 class="card-title">${icon('chart')} Recent weeks</h2>
    <p class="hint">Compare these with the hours on your payslips. Tap a week to see it.</p>
    <ul class="week-bars">
      ${rows
        .map(
          (r) => `
        <li><button type="button" data-week="${r.w}" class="${r.w === startOfWeek(weekAnchor, ws) ? 'active' : ''}" aria-label="Week of ${esc(fmtDate(r.w))}: ${fmtHours(r.minutes)} hours">
          <span class="wb-label">${esc(fmtDate(r.w, { day: 'numeric', month: 'short' }))}</span>
          <span class="wb-track"><span class="wb-bar" style="width:${(r.minutes / max) * 100}%"></span></span>
          <span class="wb-value">${fmtHours(r.minutes)} h${r.allowances ? `<small>${fmtMoney(r.allowances)}</small>` : ''}</span>
        </button></li>`,
        )
        .join('')}
    </ul>`;
  on(card, '[data-week]', 'click', (_, el) => {
    weekAnchor = el.dataset.week;
    renderWeek(root);
    renderRecent(root);
    root.querySelector('#h-week').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
