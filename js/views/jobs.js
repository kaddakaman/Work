// Jobs: timesheet-style log of sentry, tank cleaning or any job type, with an
// optional tank and location, and a "start now" timer for jobs in progress.
// (Entries are stored in the "sentry" list, from when this tab was the Sentry log.)

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
import { openEditor, openMoveSheet } from './manage.js';

let draft = null;
let weekAnchor = null;

const use12 = () => store.settings().timeFormat === '12';
const t = (x) => fmtTime(x, use12());
const jobName = (e) => store.nameOf('jobTypes', e.jobTypeId, e.jobTypeName || 'Job');

// The two optional "where" dropdowns on a job.
const PLACES = [
  { key: 'tank', coll: 'tanks', label: 'Tank', none: '— No tank —', empty: 'No tanks yet — tap +' },
  { key: 'location', coll: 'locations', label: 'Location', none: '— No location —', empty: 'No locations yet — tap +' },
];
const placeName = (e, p) => (e[`${p.key}Id`] ? store.nameOf(p.coll, e[`${p.key}Id`], e[`${p.key}Name`]) : '');
/** "Tank 3P · Main deck" (whichever are set) */
const where = (e) => PLACES.map((p) => placeName(e, p)).filter(Boolean).join(' · ');

function freshDraft() {
  const last = [...store.data().sentry].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).at(-1);
  const types = store.list('jobTypes');
  return {
    id: null,
    day: todayStr(),
    date: todayStr(),
    jobTypeId: (last && store.get('jobTypes', last.jobTypeId) ? last.jobTypeId : types[0]?.id) || '',
    tankId: last && store.get('tanks', last.tankId) ? last.tankId : '',
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
        <p class="active-title"><strong>${esc(jobName(e))}</strong>${where(e) ? ` · ${esc(where(e))}` : ''}</p>
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
  // keep archived selections visible when editing
  const curType = store.get('jobTypes', draft.jobTypeId);
  if (curType?.archived) types.push(curType);
  const placeOptions = (p) => {
    const list = store.list(p.coll);
    const cur = store.get(p.coll, draft[`${p.key}Id`]);
    if (cur?.archived) list.push(cur);
    return list;
  };
  // Tanks used to be entered as locations: offer to move them into the new Tanks list.
  const showTankTip = !st.tankTipDone && !store.list('tanks').length && store.list('locations').length > 0;

  card.innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${icon('clipboard')} ${draft.id ? 'Edit job' : 'Log a job'}</h2>
      <a class="btn btn-sm btn-ghost" href="#/manage/tanks">${icon('pencil')} Lists</a>
    </div>
    ${
      showTankTip
        ? `<div class="cleanup">
            <p><strong>Tanks now have their own list.</strong> If you added tanks as locations, move them across — jobs that used them move too.</p>
            <div class="btn-row wrap">
              <button type="button" class="btn btn-sm" id="s-tank-move">${icon('tank')} Move tanks</button>
              <button type="button" class="btn btn-sm btn-ghost" id="s-tank-tip-hide">Not needed</button>
            </div>
          </div>`
        : ''
    }
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
      ${PLACES.map((p) => {
        const list = placeOptions(p);
        return `
        <div class="field">
          <label for="s-${p.key}">${p.label} <span class="muted">(optional)</span></label>
          <div class="row">
            <select id="s-${p.key}" class="grow" data-place="${p.key}">
              <option value="">${list.length ? p.none : p.empty}</option>
              ${list.map((x) => `<option value="${x.id}" ${x.id === draft[`${p.key}Id`] ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
            </select>
            <button type="button" class="icon-btn outline" data-place-new="${p.key}" aria-label="Add a ${p.label.toLowerCase()}">${icon('plus')}</button>
          </div>
        </div>`;
      }).join('')}
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
  on(card, '[data-place]', 'change', (e, el) => (draft[`${el.dataset.place}Id`] = e.target.value));
  on(card, '[data-place-new]', 'click', (_, el) => {
    const p = PLACES.find((x) => x.key === el.dataset.placeNew);
    openEditor(p.coll, null, (item) => {
      if (item) draft[`${p.key}Id`] = item.id;
      renderForm(root);
    });
  });
  $('#s-tank-move')?.addEventListener('click', () => openMoveSheet('locations', () => renderForm(root)));
  $('#s-tank-tip-hide')?.addEventListener('click', () => {
    store.updateSettings({ tankTipDone: true });
    renderForm(root);
  });
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

  const record = (overrides = {}) => {
    const jt = store.get('jobTypes', draft.jobTypeId);
    const tank = store.get('tanks', draft.tankId);
    const loc = store.get('locations', draft.locationId);
    return {
      id: draft.id || undefined,
      date: draft.date,
      jobTypeId: jt?.id || null,
      jobTypeName: jt?.name || '',
      tankId: tank?.id || null,
      tankName: tank?.name || '',
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
    tankId: e.tankId || '',
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
  const byTank = groupMinutes(entries.filter((e) => e.tankId), (e) => e.tankId, (e) => placeName(e, PLACES[0]), now);
  const byLoc = groupMinutes(entries.filter((e) => e.locationId), (e) => e.locationId, (e) => placeName(e, PLACES[1]), now);

  const text = () => {
    const lines = [`Jobs — week of ${fmtDateFull(days[0])}`, ''];
    for (const d of days) {
      for (const e of entries.filter((x) => x.date === d).sort((a, b) => a.start.localeCompare(b.start))) {
        lines.push(`${fmtDate(d)}: ${jobName(e)}${where(e) ? ` @ ${where(e)}` : ''} ${t(e.start)}–${e.finish ? t(e.finish) : 'ongoing'} = ${fmtHours(jobMinutes(e, now))} h`);
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
      byType.length > 2 || byTank.length || byLoc.length
        ? `<details class="breakdown"><summary>Breakdown by job type, tank & location</summary>
            ${[
              ['Job type', byType],
              ['Tank', byTank],
              ['Location', byLoc],
            ]
              .filter(([, rows]) => rows.length)
              .map(
                ([title, rows]) =>
                  `<h3 class="sub-title">${title}</h3>${rows.map((r) => `<p class="kv"><span>${esc(r.name)} × ${r.count}</span><strong>${fmtHours(r.minutes)} h</strong></p>`).join('')}`,
              )
              .join('')}
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
                  <span><strong>${esc(jobName(e))}</strong>${where(e) ? ` · ${esc(where(e))}` : ''}</span>
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
    else if (!(await shareText('Jobs', text()))) {
      await copyText(text());
      toast('Sharing not available — copied instead');
    }
  });
}
