// Sentry log: timesheet-style log of sentry / tank cleaning (or any job type)
// at code-named locations, with a "start now" timer for jobs in progress.

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
  fmtTime,
  fmtClock,
  spanMinutes,
  isOvernight,
  toTs,
  nowTime,
  copyText,
  shareText,
  sum,
} from '../util.js';
import { jobMinutes, groupMinutes } from '../lib/calc.js';
import { createTimePicker } from '../components/timepicker.js';
import { icon } from '../icons.js';
import { toast, confirmBox, periodNav, on, formError } from '../ui.js';
import { openEditor } from './manage.js';

let draft = null;
let weekAnchor = null;

const use12 = () => store.settings().timeFormat === '12';
const t = (x) => fmtTime(x, use12());
const jobName = (e) => store.nameOf('jobTypes', e.jobTypeId, e.jobTypeName || 'Job');
const locName = (e) => (e.locationId ? store.nameOf('locations', e.locationId, e.locationName) : '');

function freshDraft() {
  const last = [...store.data().sentry].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).at(-1);
  const types = store.list('jobTypes');
  return {
    id: null,
    day: todayStr(),
    date: todayStr(),
    jobTypeId: (last && store.get('jobTypes', last.jobTypeId) ? last.jobTypeId : types[0]?.id) || '',
    locationId: last && store.get('locations', last.locationId) ? last.locationId : '',
    start: last?.start ?? '06:00',
    finish: last?.finish || '18:00',
    inProgress: false,
    notes: '',
  };
}

const activeJobs = () => store.data().sentry.filter((e) => !e.finish).sort((a, b) => toTs(a.date, a.start) - toTs(b.date, b.start));

// ---------------------------------------------------------------- render

export function render(root) {
  weekAnchor ??= todayStr();
  if (draft && !draft.id && draft.day !== todayStr()) draft = null;
  draft ??= freshDraft();

  root.innerHTML = `
    <div id="s-active"></div>
    <section class="card" id="s-card"></section>
    <section class="card" id="s-week"></section>`;
  renderActive(root);
  renderForm(root);
  renderWeek(root);
}

function renderActive(root) {
  const box = root.querySelector('#s-active');
  const jobs = activeJobs();
  const now = Date.now();
  box.innerHTML = jobs
    .map((e) => {
      const since = toTs(e.date, e.start);
      return `
      <section class="card active-job">
        <div class="active-head"><span class="pill pill-on">In progress</span><span class="active-clock" data-since="${since}">${fmtClock(now - since)}</span></div>
        <p class="active-title"><strong>${esc(jobName(e))}</strong>${locName(e) ? ` · ${esc(locName(e))}` : ''}</p>
        <p class="hint">Started ${t(e.start)}${e.date !== todayStr() ? ` on ${esc(fmtDate(e.date))}` : ''}</p>
        <div class="btn-row">
          <button type="button" class="btn" data-edit="${e.id}">${icon('pencil')} Edit</button>
          <button type="button" class="btn btn-primary grow" data-finish="${e.id}">${icon('stop')} Finish now</button>
        </div>
      </section>`;
    })
    .join('');

  on(box, '[data-finish]', 'click', (_, el) => {
    const e = store.get('sentry', el.dataset.finish);
    if (!e) return;
    const elapsed = Date.now() - toTs(e.date, e.start);
    if (elapsed >= 24 * 3600000) {
      toast('Over 24 hours — set the finish time manually.', { kind: 'error' });
      startEdit(root, e);
      return;
    }
    const saved = store.upsert('sentry', { id: e.id, finish: nowTime() });
    toast(`Finished ${jobName(saved)} — ${fmtHours(jobMinutes(saved))} h`);
    weekAnchor = saved.date;
    render(root);
  });
  on(box, '[data-edit]', 'click', (_, el) => {
    const e = store.get('sentry', el.dataset.edit);
    if (e) startEdit(root, e);
  });
}

function renderForm(root) {
  const card = root.querySelector('#s-card');
  const st = store.settings();
  const types = store.list('jobTypes');
  const locations = store.list('locations');
  // keep archived selections visible when editing
  const curType = store.get('jobTypes', draft.jobTypeId);
  if (curType?.archived) types.push(curType);
  const curLoc = store.get('locations', draft.locationId);
  if (curLoc?.archived) locations.push(curLoc);

  card.innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${icon('shield')} ${draft.id ? 'Edit job' : 'Log a job'}</h2>
      <a class="btn btn-sm btn-ghost" href="#/manage/locations">${icon('pencil')} Lists</a>
    </div>
    <form id="s-form" class="stack" novalidate>
      <fieldset class="field">
        <legend>Job type</legend>
        ${
          types.length
            ? `<div class="chips wrap" role="radiogroup">${types
                .map((jt) => `<label class="chip-radio"><input type="radio" name="s-type" value="${jt.id}" ${jt.id === draft.jobTypeId ? 'checked' : ''}><span>${esc(jt.name)}</span></label>`)
                .join('')}
               <button type="button" class="chip chip-add" id="s-type-new" aria-label="Add a job type">${icon('plus')}</button></div>`
            : `<button type="button" class="btn btn-sm" id="s-type-new">${icon('plus')} Add a job type</button>`
        }
      </fieldset>
      <div class="field">
        <label for="s-loc">Location</label>
        <div class="row">
          <select id="s-loc" class="grow">
            <option value="">${locations.length ? '— No location —' : 'No locations yet — tap +'}</option>
            ${locations.map((l) => `<option value="${l.id}" ${l.id === draft.locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
          </select>
          <button type="button" class="icon-btn outline" id="s-loc-new" aria-label="Add a location">${icon('plus')}</button>
        </div>
        <small class="hint">Use code names only. Everything stays on this phone.</small>
      </div>
      <div class="field">
        <label for="s-date">Date</label>
        <div class="row">
          <input type="date" id="s-date" class="grow" value="${draft.date}">
          <button type="button" class="btn btn-sm" id="s-today" ${draft.date === todayStr() ? 'disabled' : ''}>Today</button>
        </div>
      </div>
      <div class="time-pair">
        <div class="field"><span class="label">Start</span><div id="s-start"></div></div>
        <div class="field" id="s-finish-wrap" ${draft.inProgress ? 'hidden' : ''}><span class="label">Finish</span><div id="s-finish"></div></div>
      </div>
      <label class="check"><input type="checkbox" id="s-inprog" ${draft.inProgress ? 'checked' : ''}><span>Still going — I’ll finish it later</span></label>
      <div class="calc" id="s-calc" aria-live="polite"></div>
      <label class="field"><span>Notes (optional)</span><input type="text" id="s-notes" value="${esc(draft.notes)}" placeholder="e.g. handed over to night shift"></label>
      <p class="form-error" hidden></p>
      <div class="btn-row">
        ${
          draft.id
            ? '<button type="button" class="btn" id="s-cancel">Cancel</button>'
            : `<button type="button" class="btn" id="s-startnow">${icon('play')} Start now</button>`
        }
        <button type="submit" class="btn btn-primary grow">${icon('check')} ${draft.id ? 'Save changes' : 'Save job'}</button>
      </div>
      ${draft.id ? `<button type="button" class="btn btn-ghost btn-danger-text" id="s-delete">${icon('trash')} Delete this entry</button>` : ''}
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
    value: draft.finish || draft.start,
    use12h: st.timeFormat === '12',
    step: st.minuteStep,
    label: 'Finish',
    onChange: (v) => {
      draft.finish = v;
      updateCalc();
    },
  });
  $('#s-start').append(startPicker.el);
  $('#s-finish').append(finishPicker.el);
  if (!draft.finish) draft.finish = finishPicker.value;

  function updateCalc() {
    if (draft.inProgress) {
      const since = toTs(draft.date || todayStr(), draft.start);
      $('#s-calc').innerHTML =
        since > Date.now()
          ? `<div class="calc-sub">Starts ${t(draft.start)} — timer runs from then.</div>`
          : `<div class="calc-main"><strong data-since="${since}">${fmtClock(Date.now() - since)}</strong><span>so far</span></div>`;
      return;
    }
    const mins = spanMinutes(draft.start, draft.finish);
    $('#s-calc').innerHTML = mins
      ? `<div class="calc-main"><strong>${fmtHours(mins)} h</strong><span>${fmtHM(mins)}</span></div>
         <div class="calc-sub">${t(draft.start)} → ${t(draft.finish)}${isOvernight(draft.start, draft.finish) ? ' <span class="badge">next day</span>' : ''}</div>`
      : '<span class="warn-text">Start and finish are the same.</span>';
  }

  on(card, 'input[name="s-type"]', 'change', (e) => (draft.jobTypeId = e.target.value));
  $('#s-loc').addEventListener('change', (e) => (draft.locationId = e.target.value));
  $('#s-date').addEventListener('change', (e) => {
    draft.date = e.target.value;
    $('#s-today').disabled = draft.date === todayStr();
    updateCalc();
  });
  $('#s-today').addEventListener('click', () => {
    draft.date = todayStr();
    $('#s-date').value = draft.date;
    $('#s-today').disabled = true;
    updateCalc();
  });
  $('#s-inprog').addEventListener('change', (e) => {
    draft.inProgress = e.target.checked;
    $('#s-finish-wrap').hidden = draft.inProgress;
    updateCalc();
  });
  $('#s-notes').addEventListener('input', (e) => (draft.notes = e.target.value));

  $('#s-type-new').addEventListener('click', () =>
    openEditor('jobTypes', null, (jt) => {
      if (jt) draft.jobTypeId = jt.id;
      renderForm(root);
    }),
  );
  $('#s-loc-new').addEventListener('click', () =>
    openEditor('locations', null, (l) => {
      if (l) draft.locationId = l.id;
      renderForm(root);
    }),
  );

  const record = (overrides = {}) => {
    const jt = store.get('jobTypes', draft.jobTypeId);
    const loc = store.get('locations', draft.locationId);
    return {
      id: draft.id || undefined,
      date: draft.date,
      jobTypeId: jt?.id || null,
      jobTypeName: jt?.name || '',
      locationId: loc?.id || null,
      locationName: loc?.name || '',
      start: draft.start,
      finish: draft.inProgress ? null : draft.finish,
      notes: draft.notes.trim(),
      ...overrides,
    };
  };

  $('#s-startnow')?.addEventListener('click', () => {
    if (!store.get('jobTypes', draft.jobTypeId)) return formError(err, 'Pick a job type first.');
    const saved = store.upsert('sentry', record({ date: todayStr(), start: nowTime(), finish: null }));
    toast(`${jobName(saved)} started at ${t(saved.start)}`);
    draft = null;
    render(root);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#s-cancel')?.addEventListener('click', () => {
    draft = null;
    render(root);
  });
  $('#s-delete')?.addEventListener('click', async () => {
    if (!(await confirmBox('Delete this entry?', { ok: 'Delete', danger: true }))) return;
    store.remove('sentry', draft.id);
    toast('Entry deleted');
    draft = null;
    render(root);
  });

  $('#s-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!store.get('jobTypes', draft.jobTypeId)) return formError(err, 'Pick a job type.');
    if (!draft.date) return formError(err, 'Pick a date.');
    if (!draft.inProgress && spanMinutes(draft.start, draft.finish) === 0) return formError(err, 'Start and finish are the same — scroll the finish time.');
    formError(err, '');
    const saved = store.upsert('sentry', record());
    toast(saved.finish ? `Saved ${fmtHours(jobMinutes(saved))} h ${jobName(saved)}` : `${jobName(saved)} in progress`);
    weekAnchor = saved.date;
    draft = null;
    render(root);
    if (saved.finish) root.querySelector('#s-week').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  updateCalc();
}

function startEdit(root, e) {
  draft = {
    id: e.id,
    day: todayStr(),
    date: e.date,
    jobTypeId: e.jobTypeId || '',
    locationId: e.locationId || '',
    start: e.start,
    finish: e.finish || nowTime(),
    inProgress: !e.finish,
    notes: e.notes || '',
  };
  render(root);
  root.querySelector('#s-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- week summary

function renderWeek(root) {
  const card = root.querySelector('#s-week');
  const ws = startOfWeek(weekAnchor, store.settings().weekStartsOn);
  const days = weekDates(ws);
  const isThisWeek = ws === startOfWeek(todayStr(), store.settings().weekStartsOn);
  const entries = store.data().sentry.filter((e) => e.date >= days[0] && e.date <= days[6]);
  const now = Date.now();
  const total = sum(entries, (e) => jobMinutes(e, now));
  const byType = groupMinutes(entries, (e) => e.jobTypeId, jobName, now);
  const byLoc = groupMinutes(entries, (e) => e.locationId, (e) => locName(e) || 'No location', now);

  const text = () => {
    const lines = [`Job log — week of ${fmtDateFull(days[0])}`, ''];
    for (const d of days) {
      for (const e of entries.filter((x) => x.date === d).sort((a, b) => a.start.localeCompare(b.start))) {
        lines.push(`${fmtDate(d)}: ${jobName(e)}${locName(e) ? ` @ ${locName(e)}` : ''} ${t(e.start)}–${e.finish ? t(e.finish) : 'ongoing'} = ${fmtHours(jobMinutes(e, now))} h`);
      }
    }
    lines.push('', `Total: ${fmtHours(total)} h`, ...byType.map((r) => `  ${r.name}: ${fmtHours(r.minutes)} h`));
    return lines.join('\n');
  };

  card.innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${icon('calendar')} Week</h2>
      ${isThisWeek ? '' : '<button type="button" class="btn btn-sm btn-ghost" data-nav="0">This week</button>'}
    </div>
    ${periodNav({ label: `${fmtDate(days[0], { day: 'numeric', month: 'short' })} – ${fmtDate(days[6], { day: 'numeric', month: 'short', year: 'numeric' })}`, sub: isThisWeek ? 'This week' : '' })}
    <div class="stat-grid">
      <div class="stat stat-hero"><span class="stat-label">Total hours</span><span class="stat-value">${fmtHours(total)}</span><span class="stat-sub">${fmtHM(total)} · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}</span></div>
      ${byType
        .slice(0, 2)
        .map((r) => `<div class="stat"><span class="stat-label">${esc(r.name)}</span><span class="stat-value">${fmtHours(r.minutes)}</span><span class="stat-sub">hours</span></div>`)
        .join('')}
    </div>
    ${
      byType.length > 2 || byLoc.length
        ? `<details class="breakdown"><summary>Breakdown by job type & location</summary>
            <h3 class="sub-title">Job type</h3>${byType.map((r) => `<p class="kv"><span>${esc(r.name)} × ${r.count}</span><strong>${fmtHours(r.minutes)} h</strong></p>`).join('')}
            <h3 class="sub-title">Location</h3>${byLoc.map((r) => `<p class="kv"><span>${esc(r.name)} × ${r.count}</span><strong>${fmtHours(r.minutes)} h</strong></p>`).join('')}
          </details>`
        : ''
    }
    <ul class="day-list">
      ${days
        .map((d) => {
          const list = entries.filter((e) => e.date === d).sort((a, b) => a.start.localeCompare(b.start));
          const mins = sum(list, (e) => jobMinutes(e, now));
          return `
          <li class="day ${list.length ? '' : 'day-off'} ${d === todayStr() ? 'is-today' : ''}">
            <div class="day-name"><strong>${esc(fmtDate(d, { weekday: 'short' }))}</strong><small>${esc(fmtDate(d, { day: 'numeric', month: 'short' }))}</small></div>
            <div class="day-shifts">
              ${
                list.length
                  ? list
                      .map(
                        (e) => `
                <button type="button" class="shift-chip" data-id="${e.id}">
                  <span><strong>${esc(jobName(e))}</strong>${locName(e) ? ` · ${esc(locName(e))}` : ''}</span>
                  <small>${t(e.start)}–${e.finish ? t(e.finish) : '<span class="pill pill-on">ongoing</span>'}</small>
                  ${e.notes ? `<small class="muted">${esc(e.notes)}</small>` : ''}
                </button>`,
                      )
                      .join('')
                  : '<span class="muted">—</span>'
              }
            </div>
            <div class="day-total">${list.length ? `<strong>${fmtHours(mins)}</strong><small>h</small>` : ''}</div>
          </li>`;
        })
        .join('')}
    </ul>
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
    const e = store.get('sentry', el.dataset.id);
    if (e) startEdit(root, e);
  });
  on(card, '[data-act]', 'click', async (_, el) => {
    if (el.dataset.act === 'copy') toast((await copyText(text())) ? 'Week copied' : 'Copy failed');
    else if (!(await shareText('Job log', text()))) {
      await copyText(text());
      toast('Sharing not available — copied instead');
    }
  });
}
