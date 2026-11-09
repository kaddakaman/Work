// Vacuum management: tap a hose to turn it on (green) or off (red), see how
// long each hose and each vacuum unit has been running, and review the stats.

import * as store from '../store.js';
import {
  esc,
  uid,
  todayStr,
  addDays,
  startOfWeek,
  startOfMonth,
  addMonths,
  datesBetween,
  toTs,
  tsDate,
  tsTime,
  fmtDate,
  fmtDateFull,
  fmtMonth,
  fmtDur,
  fmtClock,
  fmtTime,
  fmtAgo,
  fmtNum,
  msToHours,
} from '../util.js';
import { openSessionFor, vacuumRunStart, vacuumStats, dailyRunTime } from '../lib/calc.js';
import { createTimePicker } from '../components/timepicker.js';
import { icon } from '../icons.js';
import { toast, sheet, confirmBox, periodNav, emptyState, on, formError } from '../ui.js';
import { openEditor, openCopyHoses, assetOptions, setHoseTether, crewOf, hoseCrew } from './manage.js';

const stats = { gran: 'day', anchor: null, filter: '' };
const use12 = () => store.settings().timeFormat === '12';
const t = (hhmm) => fmtTime(hhmm, use12());
const tts = (ts) => t(tsTime(ts));

/** Runs shorter than this were probably a mis-press. */
const SHORT_RUN_MS = 60 * 1000;
const runLen = (s, now = Date.now()) => (s.end ?? now) - s.start;
const isShort = (s) => s.end != null && runLen(s) < SHORT_RUN_MS;
/** "8s" for very short runs, otherwise "3h 05m". */
const fmtRunLen = (ms) => (ms < 60000 ? `${Math.max(0, Math.round(ms / 1000))}s` : fmtDur(ms));

/** Remove runs from the log (so they no longer count in the stats), with Undo. */
function deleteRuns(ids, after) {
  const removed = store.data().vacSessions.filter((s) => ids.includes(s.id));
  if (!removed.length) return;
  store.mutate((d) => {
    d.vacSessions = d.vacSessions.filter((s) => !ids.includes(s.id));
  });
  const first = removed[0];
  toast(
    removed.length === 1
      ? `Deleted ${store.nameOf('hoses', first.hoseId, first.hoseName)} run (${fmtRunLen(runLen(first))})`
      : `Deleted ${removed.length} runs`,
    {
      actionLabel: 'Undo',
      timeout: 6000,
      onAction: () => {
        store.mutate((d) => {
          for (const r of removed) {
            if (d.vacSessions.some((x) => x.id === r.id)) continue;
            // A hose can only have one run going at a time.
            if (r.end == null && openSessionFor(d.vacSessions, r.hoseId)) continue;
            d.vacSessions.push(r);
          }
        });
        after();
      },
    },
  );
  after();
}

// ---------------------------------------------------------------- ground crews

/** The crew picked at the top of the page ('' = all crews). */
function currentCrew() {
  const crew = store.get('crews', store.settings().crewId);
  return crew && !crew.archived ? crew.id : '';
}

/** Is this vacuum unit part of the crew being viewed? Units with no crew show for every crew. */
function inCrew(assetId, crew = currentCrew()) {
  if (!crew) return true;
  const assigned = crewOf(store.get('assets', assetId));
  return !assigned || assigned.id === crew;
}

/** Is this hose one of the viewed crew's? Hoses with no crew show for every crew. */
function hoseInCrew(hose, crew = currentCrew()) {
  if (!crew) return true;
  const assigned = hoseCrew(hose);
  return !assigned || assigned.id === crew;
}

/** A run counts for the crew whose hose it was on. */
function runInCrew(run, crew = currentCrew()) {
  if (!crew) return true;
  const hose = store.get('hoses', run.hoseId);
  return hose ? hoseInCrew(hose, crew) : inCrew(run.assetId, crew);
}

/**
 * Hose names repeat between crews, so when viewing every crew, add the crew
 * to names that appear more than once: "Forward dry (Ground Crew 2)".
 */
function hoseLabeller(crew = currentCrew()) {
  const seen = new Set();
  const dup = new Set();
  for (const h of store.data().hoses) {
    const k = h.name.trim().toLowerCase();
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return (hoseId, fallback = '') => {
    const name = store.nameOf('hoses', hoseId, fallback);
    if (crew || !dup.has(name.trim().toLowerCase())) return name;
    const c = hoseCrew(store.get('hoses', hoseId));
    return c ? `${name} (${c.name})` : name;
  };
}

function crewSwitchHTML() {
  const crews = store.list('crews');
  if (!crews.length) return '';
  const crew = currentCrew();
  const opts = [...crews.map((c) => ({ id: c.id, name: c.name })), { id: '', name: 'All' }];
  return `
    <div class="crew-switch" role="radiogroup" aria-label="Ground crew">
      ${icon('users')}
      ${opts
        .map(
          (o) => `<label class="chip-radio"><input type="radio" name="crew" value="${o.id}" ${o.id === crew ? 'checked' : ''}><span>${esc(o.name)}</span></label>`,
        )
        .join('')}
    </div>`;
}

export function render(root, [sub = '']) {
  const tab = sub === 'stats' ? 'stats' : 'hoses';
  root.innerHTML = `
    ${crewSwitchHTML()}
    <nav class="seg seg-tabs" aria-label="Vacuum views">
      <a href="#/vacuum" class="${tab === 'hoses' ? 'active' : ''}">${icon('wind')} Hoses</a>
      <a href="#/vacuum/stats" class="${tab === 'stats' ? 'active' : ''}">${icon('chart')} Stats</a>
    </nav>
    <div id="vac-body"></div>`;
  const body = root.querySelector('#vac-body');
  on(root, 'input[name="crew"]', 'change', (e) => {
    store.updateSettings({ crewId: e.target.value });
    stats.filter = '';
    render(root, [sub]);
  });
  if (tab === 'stats') renderStats(body);
  else renderHoses(body);
}

// ---------------------------------------------------------------- hoses board

function optionsHTML(opts, selected) {
  const one = (o) => `<option value="${esc(o.value)}" ${String(o.value) === String(selected ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`;
  return opts.map((o) => (o.group ? `<optgroup label="${esc(o.group)}">${o.options.map(one).join('')}</optgroup>` : one(o))).join('');
}

function renderHoses(body) {
  const allHoses = store.list('hoses');
  const crew = currentCrew();
  const hoses = allHoses.filter((h) => hoseInCrew(h, crew));
  const sessions = store.data().vacSessions;
  const now = Date.now();
  const addHose = () => openEditor('hoses', null, () => renderHoses(body), { crewId: crew });

  if (!hoses.length && allHoses.length) {
    const crewName = store.get('crews', crew)?.name;
    body.innerHTML = `<section class="card">${emptyState({
      iconName: 'users',
      title: `No hoses for ${crewName} yet`,
      text: `${crewName} has its own hoses, separate from the other crews’. Copy another crew’s hose setup (it’s usually near identical) or add them one by one. Set the ground crew on ${crewName}’s vacuum units in Manage → Assets too.`,
      action: `<div class="btn-row wrap center-row">
          <button type="button" class="btn btn-primary" id="v-copy">${icon('copy')} Copy hoses</button>
          <button type="button" class="btn" id="v-first">${icon('plus')} Add hose</button>
        </div>`,
    })}</section>`;
    body.querySelector('#v-copy').addEventListener('click', () => openCopyHoses(() => renderHoses(body), { to: crew }));
    body.querySelector('#v-first').addEventListener('click', addHose);
    return;
  }

  if (!hoses.length) {
    body.innerHTML = `<section class="card">${emptyState({
      iconName: 'wind',
      title: 'Add your hoses',
      text: 'Add each vacuum hose (e.g. “Forward dry”) and which vacuum unit it runs from. Then tap a hose to mark it on or off.',
      action: `<button type="button" class="btn btn-primary" id="v-first">${icon('plus')} Add hose</button>`,
    })}</section>`;
    body.querySelector('#v-first').addEventListener('click', addHose);
    return;
  }

  // Group hoses by the vacuum unit they're tethered to.
  const groups = new Map();
  for (const h of hoses) {
    const key = h.assetId && store.get('assets', h.assetId) ? h.assetId : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  // Vacuums with a hose on go to the top; untethered hoses go last in each half.
  const running = (key) => groups.get(key).some((h) => openSessionFor(sessions, h.id));
  const order = [...groups.keys()].sort(
    (a, b) =>
      running(b) - running(a) ||
      (a ? 0 : 1) - (b ? 0 : 1) ||
      store.nameOf('assets', a).localeCompare(store.nameOf('assets', b), undefined, { numeric: true }),
  );

  const onCount = hoses.filter((h) => openSessionFor(sessions, h.id)).length;
  const runningVacs = order.filter((id) => id && vacuumRunStart(sessions, id, now)).length;

  const tile = (h) => {
    const open = openSessionFor(sessions, h.id);
    const last = open
      ? null
      : sessions
          .filter((s) => s.hoseId === h.id && s.end)
          .sort((a, b) => b.end - a.end)[0];
    return `
      <div class="hose-tile ${open ? 'on' : 'off'}">
        <button type="button" class="hose-toggle" data-toggle="${h.id}" aria-pressed="${open ? 'true' : 'false'}" aria-label="${esc(h.name)}: ${open ? 'on, tap to turn off' : 'off, tap to turn on'}">
          <span class="hose-state">${icon('power')} ${open ? 'ON' : 'OFF'}</span>
          <span class="hose-name">${esc(h.name)}</span>
          ${h.area ? `<span class="hose-area">${esc(h.area)}</span>` : ''}
          <span class="hose-time">${
            open
              ? `<span data-since="${open.start}">${fmtClock(now - open.start)}</span>`
              : last
                ? `off ${fmtAgo(last.end, now)}`
                : 'not used yet'
          }</span>
        </button>
        <button type="button" class="hose-more" data-more="${h.id}" aria-label="Details for ${esc(h.name)}">${icon('more')}</button>
      </div>`;
  };

  body.innerHTML = `
    <div class="vac-summary">
      <span><strong>${onCount}</strong> hose${onCount === 1 ? '' : 's'} on</span>
      <span><strong>${runningVacs}</strong> vacuum${runningVacs === 1 ? '' : 's'} running</span>
    </div>
    ${order
      .map((id) => {
        const list = groups.get(id);
        const asset = id ? store.get('assets', id) : null;
        const runStart = id ? vacuumRunStart(sessions, id, now) : null;
        const on = list.filter((h) => openSessionFor(sessions, h.id)).length;
        return `
        <section class="card vac-group">
          <header class="vac-head ${runStart ? 'running' : ''}">
            <div class="vac-title">
              ${icon(asset ? 'truck' : 'link')}
              <div><strong>${asset ? esc(asset.name) : 'Not tethered'}</strong><small>${asset ? `${on} of ${list.length} hose${list.length === 1 ? '' : 's'} on` : 'Tether these to a vacuum unit via ⋯'}</small></div>
            </div>
            ${
              asset
                ? runStart
                  ? `<div class="vac-run"><span class="pill pill-on">Running</span><span class="vac-clock" data-since="${runStart}">${fmtClock(now - runStart)}</span><small>since ${tts(runStart)}</small></div>`
                  : '<div class="vac-run"><span class="pill pill-off">Off</span></div>'
                : ''
            }
          </header>
          <div class="hose-grid">${list.map(tile).join('')}</div>
        </section>`;
      })
      .join('')}
    <div class="btn-row wrap">
      <button type="button" class="btn" id="v-add">${icon('plus')} Add hose</button>
      <button type="button" class="btn btn-ghost btn-danger-text" id="v-alloff" ${onCount ? '' : 'disabled'}>${icon('power')} Turn all off</button>
    </div>
    <p class="hint center">Tap a hose to switch it on/off. Use ⋯ to tether it to a vacuum or fix a start time.</p>`;

  const rerender = () => renderHoses(body);
  on(body, '[data-toggle]', 'click', (_, el) => {
    const id = el.dataset.toggle;
    const turningOn = !openSessionFor(store.data().vacSessions, id);
    toggleHose(id, rerender);
    if (!turningOn) return;
    // Its vacuum has just moved to the top of the list: follow it there.
    const group = body.querySelector(`[data-toggle="${id}"]`)?.closest('.vac-group');
    const top = group?.getBoundingClientRect().top;
    if (group && (top < 70 || top > window.innerHeight * 0.5)) group.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  on(body, '[data-more]', 'click', (_, el) => openHoseSheet(el.dataset.more, rerender));
  body.querySelector('#v-add').addEventListener('click', addHose);
  body.querySelector('#v-alloff').addEventListener('click', async () => {
    const crewName = crew ? ` for ${store.get('crews', crew).name}` : '';
    if (!(await confirmBox(`Turn off all ${onCount} running hose${onCount === 1 ? '' : 's'}${crewName}?`, { ok: 'Turn all off', danger: true }))) return;
    const end = Date.now();
    const shown = new Set(hoses.map((h) => h.id)); // only this crew's hoses
    store.mutate((d) => d.vacSessions.forEach((s) => s.end == null && shown.has(s.hoseId) && (s.end = end)));
    toast('All hoses off');
    rerender();
  });
}

function toggleHose(hoseId, rerender) {
  const hose = store.get('hoses', hoseId);
  if (!hose) return;
  const open = openSessionFor(store.data().vacSessions, hoseId);
  navigator.vibrate?.(20);
  if (open) {
    const end = Date.now();
    store.mutate((d) => {
      d.vacSessions.find((s) => s.id === open.id).end = end;
    });
    const ran = end - open.start;
    if (ran < SHORT_RUN_MS) {
      // On-then-straight-off is usually a mis-press: offer to wipe it from the stats.
      toast(`${hose.name} OFF — only on ${fmtRunLen(ran)}. Turned on by mistake?`, {
        actionLabel: 'Delete run',
        timeout: 8000,
        onAction: () => deleteRuns([open.id], rerender),
      });
    } else {
      toast(`${hose.name} OFF — ran ${fmtDur(ran)}`, {
        actionLabel: 'Undo',
        timeout: 6000,
        onAction: () => {
          if (openSessionFor(store.data().vacSessions, hoseId)) return;
          store.mutate((d) => {
            const s = d.vacSessions.find((x) => x.id === open.id);
            if (s) s.end = null;
          });
          rerender();
        },
      });
    }
  } else {
    const s = {
      id: uid(),
      hoseId,
      hoseName: hose.name,
      assetId: hose.assetId || null,
      assetName: store.nameOf('assets', hose.assetId, ''),
      start: Date.now(),
      end: null,
    };
    store.mutate((d) => d.vacSessions.push(s));
    toast(`${hose.name} ON`, {
      actionLabel: 'Undo',
      timeout: 6000,
      onAction: () => {
        // Only undo if that run is still going (never delete a finished run).
        if (store.get('vacSessions', s.id)?.end != null) return;
        store.remove('vacSessions', s.id);
        rerender();
      },
    });
  }
  rerender();
}

/** Date + time-wheel block used for "started at" / "stopped at" edits. */
function dateTimeField(container, { ts, label }) {
  const st = store.settings();
  container.innerHTML = `<div class="row"><input type="date" class="grow" value="${tsDate(ts)}" max="${todayStr()}" aria-label="${esc(label)} date"></div><div class="dt-picker"></div>`;
  const dateInput = container.querySelector('input');
  const picker = createTimePicker({ value: tsTime(ts), use12h: st.timeFormat === '12', step: 1, label });
  container.querySelector('.dt-picker').append(picker.el);
  return { get value() { return dateInput.value ? toTs(dateInput.value, picker.value) : null; } };
}

function openHoseSheet(hoseId, rerender) {
  const hose = store.get('hoses', hoseId);
  if (!hose) return;
  const open = openSessionFor(store.data().vacSessions, hoseId);
  const now = Date.now();

  const runsHTML = () => {
    const at = Date.now();
    const recent = store
      .data()
      .vacSessions.filter((s) => s.hoseId === hoseId)
      .sort((a, b) => b.start - a.start)
      .slice(0, 8);
    if (!recent.length) return '<p class="hint">No runs recorded yet.</p>';
    return `<ul class="list compact">${recent
      .map(
        (s) => `
        <li class="row-with-action">
          <span class="list-static">
            <span>${esc(fmtDate(tsDate(s.start)))} · ${tts(s.start)} → ${s.end ? tts(s.end) : 'now'}${isShort(s) ? ' <span class="badge">short</span>' : ''}</span>
            <strong>${fmtRunLen(runLen(s, at))}</strong>
          </span>
          <button type="button" class="icon-btn" data-del-run="${s.id}" aria-label="Delete this run">${icon('trash')}</button>
        </li>`,
      )
      .join('')}</ul>
      <p class="hint">Turned it on by mistake? Tap ${icon('trash')} to delete that run so it doesn’t count in the stats.</p>`;
  };

  sheet({
    title: hose.name,
    content: `
      <div class="stack">
        <p class="hose-status ${open ? 'on' : 'off'}">${icon('power')} ${open ? `ON since ${tts(open.start)} · <span data-since="${open.start}">${fmtClock(now - open.start)}</span>` : 'OFF'}</p>
        <label class="field"><span>Runs from (vacuum unit)</span>
          <select id="hs-asset">${optionsHTML(assetOptions({ crewId: hoseCrew(hose)?.id, include: hose.assetId }), hose.assetId)}</select>
        </label>
        <details class="field">
          <summary>${open ? 'Fix the time it was turned on' : 'It’s already on — start it from an earlier time'}</summary>
          <div class="stack pad-top">
            <div id="hs-when"></div>
            <p class="form-error" hidden></p>
            <button type="button" class="btn btn-primary" id="hs-set">${open ? 'Update start time' : 'Turn on from this time'}</button>
          </div>
        </details>
        <div>
          <h3 class="sub-title">Recent runs</h3>
          <div id="hs-runs">${runsHTML()}</div>
        </div>
        <div class="btn-row">
          <a class="btn" href="#/vacuum/stats" data-close>${icon('chart')} Stats</a>
          <button type="button" class="btn" id="hs-edit">${icon('pencil')} Rename / delete</button>
        </div>
      </div>`,
    onMount: (b, close) => {
      const when = dateTimeField(b.querySelector('#hs-when'), { ts: open ? open.start : now, label: 'Turned on at' });
      const err = b.querySelector('.form-error');
      const runsBox = b.querySelector('#hs-runs');
      runsBox.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-del-run]');
        if (!btn) return;
        const id = btn.dataset.delRun;
        if (id === open?.id) {
          // Deleting the run that's going now switches the hose back off.
          close();
          deleteRuns([id], rerender);
        } else {
          deleteRuns([id], () => {
            runsBox.innerHTML = runsHTML();
            rerender();
          });
        }
      });
      b.querySelector('#hs-asset').addEventListener('change', (e) => {
        setHoseTether(hoseId, e.target.value);
        toast('Tether updated');
        rerender();
      });
      b.querySelector('#hs-set').addEventListener('click', () => {
        const ts = when.value;
        if (!ts) return formError(err, 'Pick a date.');
        if (ts > Date.now()) return formError(err, 'That time is in the future.');
        const prevEnd = store
          .data()
          .vacSessions.filter((s) => s.hoseId === hoseId && s.end && s.id !== open?.id)
          .reduce((m, s) => Math.max(m, s.end), 0);
        if (ts < prevEnd) return formError(err, `That overlaps the previous run (ended ${fmtDate(tsDate(prevEnd))} ${tts(prevEnd)}).`);
        if (open) {
          store.mutate((d) => {
            d.vacSessions.find((s) => s.id === open.id).start = ts;
          });
          toast('Start time updated');
        } else {
          const h = store.get('hoses', hoseId);
          store.mutate((d) =>
            d.vacSessions.push({
              id: uid(),
              hoseId,
              hoseName: h.name,
              assetId: h.assetId || null,
              assetName: store.nameOf('assets', h.assetId, ''),
              start: ts,
              end: null,
            }),
          );
          toast(`${h.name} ON from ${tts(ts)}`);
        }
        close();
        rerender();
      });
      b.querySelector('#hs-edit').addEventListener('click', () => {
        close();
        openEditor('hoses', store.get('hoses', hoseId), rerender);
      });
    },
  });
}

// ---------------------------------------------------------------- stats

function rangeFor(gran, anchor) {
  if (gran === 'day') return { from: anchor, to: addDays(anchor, 1), label: fmtDateFull(anchor) };
  if (gran === 'week') {
    const from = startOfWeek(anchor, store.settings().weekStartsOn);
    const to = addDays(from, 7);
    return {
      from,
      to,
      label: `${fmtDate(from, { day: 'numeric', month: 'short' })} – ${fmtDate(addDays(to, -1), { day: 'numeric', month: 'short', year: 'numeric' })}`,
    };
  }
  const from = startOfMonth(anchor);
  return { from, to: addMonths(anchor, 1), label: fmtMonth(from) };
}

/** Round an axis maximum up to a clean number of hours. */
function niceMax(h) {
  const steps = [1, 2, 4, 6, 8, 12, 16, 24, 36, 48, 72, 96, 120, 168, 240];
  return steps.find((s) => s >= h) ?? Math.ceil(h / 100) * 100;
}

function renderStats(body) {
  stats.anchor ??= todayStr();
  const now = Date.now();
  const { from, to, label } = rangeFor(stats.gran, stats.anchor);
  const rs = toTs(from);
  const re = toTs(to);
  const crew = currentCrew();
  const all = store.data().vacSessions.filter((s) => runInCrew(s, crew));
  const hoseLabel = hoseLabeller(crew);
  const [fKind, fId] = stats.filter.split(':');
  const sessions = fKind === 'hose' ? all.filter((s) => s.hoseId === fId) : fKind === 'asset' ? all.filter((s) => s.assetId === fId) : all;
  const st = vacuumStats(sessions, rs, re, now);
  const isCurrent = rangeFor(stats.gran, todayStr()).from === from;
  const vacRuns = st.vacuums.reduce((n, v) => n + v.runs, 0);

  // Filter choices: every hose / vacuum seen in the data or the lists.
  const hoseIds = new Map(store.list('hoses').filter((h) => hoseInCrew(h, crew)).map((h) => [h.id, hoseLabel(h.id)]));
  const assetIds = new Map(store.list('assets').filter((a) => a.isVacuum && inCrew(a.id, crew)).map((a) => [a.id, a.name]));
  for (const s of all) {
    if (!hoseIds.has(s.hoseId)) hoseIds.set(s.hoseId, hoseLabel(s.hoseId, s.hoseName));
    if (s.assetId && !assetIds.has(s.assetId)) assetIds.set(s.assetId, store.nameOf('assets', s.assetId, s.assetName));
  }
  const filterOpts = [
    { value: '', label: crew ? `All of ${store.get('crews', crew).name}` : 'All hoses & vacuums' },
    ...(assetIds.size ? [{ group: 'Vacuum unit', options: [...assetIds].map(([id, n]) => ({ value: `asset:${id}`, label: n })) }] : []),
    ...(hoseIds.size ? [{ group: 'Hose', options: [...hoseIds].map(([id, n]) => ({ value: `hose:${id}`, label: n })) }] : []),
  ];

  const inRange = sessions
    .filter((s) => s.start < re && (s.end ?? now) >= rs)
    .sort((a, b) => b.start - a.start);
  const shortRuns = inRange.filter(isShort);

  body.innerHTML = `
    <section class="card">
      <div class="seg seg-sm seg-full" role="radiogroup" aria-label="Period">
        ${['day', 'week', 'month']
          .map((g) => `<label><input type="radio" name="vs-gran" value="${g}" ${g === stats.gran ? 'checked' : ''}><span>${g[0].toUpperCase() + g.slice(1)}</span></label>`)
          .join('')}
      </div>
      ${periodNav({ label, sub: isCurrent ? { day: 'Today', week: 'This week', month: 'This month' }[stats.gran] : '' })}
      ${isCurrent ? '' : '<button type="button" class="btn btn-sm btn-ghost period-now" data-nav="0">Back to now</button>'}
      <label class="field"><span>Show</span><select id="vs-filter">${optionsHTML(filterOpts, stats.filter)}</select></label>
    </section>

    <section class="stat-grid stat-grid-4">
      <div class="stat"><span class="stat-label">Vacuum run time</span><span class="stat-value">${fmtNum(msToHours(st.vacMs), 1)} h</span><span class="stat-sub">${vacRuns} run${vacRuns === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="stat-label">Hose run time</span><span class="stat-value">${fmtNum(msToHours(st.hoseMs), 1)} h</span><span class="stat-sub">${st.hoses.length} hose${st.hoses.length === 1 ? '' : 's'} combined</span></div>
      <div class="stat"><span class="stat-label">Turned on</span><span class="stat-value">${st.on}</span><span class="stat-sub">time${st.on === 1 ? '' : 's'}</span></div>
      <div class="stat"><span class="stat-label">Turned off</span><span class="stat-value">${st.off}</span><span class="stat-sub">time${st.off === 1 ? '' : 's'}</span></div>
    </section>

    <section class="card" id="vs-chart"></section>

    <section class="card">
      <h2 class="card-title">${icon('truck')} Vacuum units</h2>
      ${
        st.vacuums.length
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Vacuum</th><th class="num">Runs</th><th class="num">Hours</th><th class="num">Longest</th></tr></thead>
              <tbody>${st.vacuums
                .map((v) => `<tr><td>${esc(store.nameOf('assets', v.id, v.name))}</td><td class="num">${v.runs}</td><td class="num">${fmtNum(msToHours(v.ms), 1)}</td><td class="num">${fmtDur(v.longest)}</td></tr>`)
                .join('')}</tbody></table></div>
             <p class="hint">A run is continuous time with at least one hose on (gaps under 2 minutes while swapping hoses are ignored).</p>`
          : '<p class="hint">No vacuum running time in this period. Tether hoses to a vacuum unit to see this.</p>'
      }
    </section>

    <section class="card">
      <h2 class="card-title">${icon('wind')} Hoses</h2>
      ${
        st.hoses.length
          ? `<div class="table-wrap"><table class="table">
              <thead><tr><th>Hose</th><th class="num">On</th><th class="num">Off</th><th class="num">Hours</th><th class="num">Longest</th></tr></thead>
              <tbody>${st.hoses
                .map((h) => `<tr><td>${esc(hoseLabel(h.id, h.name))}</td><td class="num">${h.on}</td><td class="num">${h.off}</td><td class="num">${fmtNum(msToHours(h.ms), 1)}</td><td class="num">${fmtDur(h.longest)}</td></tr>`)
                .join('')}</tbody></table></div>`
          : '<p class="hint">No hose activity in this period.</p>'
      }
    </section>

    <section class="card">
      <h2 class="card-title">${icon('list')} Run log</h2>
      ${
        shortRuns.length
          ? `<div class="cleanup">
              <p><strong>${shortRuns.length} run${shortRuns.length === 1 ? '' : 's'} under a minute</strong> in this period — probably hoses turned on by mistake.</p>
              <button type="button" class="btn btn-sm" id="vs-clean">${icon('trash')} Delete ${shortRuns.length === 1 ? 'it' : 'them'}</button>
            </div>`
          : ''
      }
      ${
        inRange.length
          ? `<ul class="list">${inRange
              .slice(0, 200)
              .map(
                (s) => `
            <li class="row-with-action"><button type="button" class="list-row" data-session="${s.id}">
              <span class="list-main">
                <strong>${esc(hoseLabel(s.hoseId, s.hoseName))}${s.assetId ? ` <small class="muted">↳ ${esc(store.nameOf('assets', s.assetId, s.assetName))}</small>` : ''}</strong>
                <small>${esc(fmtDate(tsDate(s.start)))} ${tts(s.start)} → ${s.end ? `${tsDate(s.end) !== tsDate(s.start) ? `${esc(fmtDate(tsDate(s.end)))} ` : ''}${tts(s.end)}` : '<span class="pill pill-on">running</span>'}</small>
              </span>
              <span class="list-end">${s.end ? `${isShort(s) ? '<span class="badge">short</span> ' : ''}${fmtRunLen(s.end - s.start)}` : `<span data-since="${s.start}">${fmtClock(now - s.start)}</span>`}</span>
            </button><button type="button" class="icon-btn" data-del-run="${s.id}" aria-label="Delete this run">${icon('trash')}</button></li>`,
              )
              .join('')}</ul>
            <p class="hint">Tap ${icon('trash')} to delete a run you didn’t mean to start — it comes off the stats. Tap a run to fix its times.</p>`
          : '<p class="hint">Nothing recorded in this period.</p>'
      }
    </section>`;

  const rerender = () => renderStats(body);
  on(body, 'input[name="vs-gran"]', 'change', (e) => {
    stats.gran = e.target.value;
    rerender();
  });
  on(body, '[data-nav]', 'click', (_, el) => {
    const step = Number(el.dataset.nav);
    if (step === 0) stats.anchor = todayStr();
    else if (stats.gran === 'day') stats.anchor = addDays(stats.anchor, step);
    else if (stats.gran === 'week') stats.anchor = addDays(stats.anchor, 7 * step);
    else stats.anchor = addMonths(stats.anchor, step);
    rerender();
  });
  body.querySelector('#vs-filter').addEventListener('change', (e) => {
    stats.filter = e.target.value;
    rerender();
  });
  on(body, '[data-session]', 'click', (_, el) => openSessionSheet(el.dataset.session, rerender));
  on(body, '[data-del-run]', 'click', (_, el) => deleteRuns([el.dataset.delRun], rerender));
  body.querySelector('#vs-clean')?.addEventListener('click', async () => {
    const n = shortRuns.length;
    const ok = await confirmBox(`Delete ${n} run${n === 1 ? '' : 's'} shorter than a minute? ${n === 1 ? 'It' : 'They'} will no longer count in the stats.`, {
      title: 'Clean up short runs?',
      ok: 'Delete',
      danger: true,
    });
    if (ok) deleteRuns(shortRuns.map((r) => r.id), rerender);
  });

  const chart = body.querySelector('#vs-chart');
  if (stats.gran === 'day') renderTimeline(chart, inRange, rs, re, now, hoseLabel);
  else renderDailyBars(chart, sessions, datesBetween(from, to), now);
}

// Tooltip shared by both charts: hover on desktop, tap on phones.
function wireTooltip(chart) {
  const tip = chart.querySelector('.chart-tip');
  const plot = chart.querySelector('.chart-plot');
  const show = (el) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const pr = plot.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const x = Math.min(Math.max(er.left + er.width / 2 - pr.left, 60), pr.width - 60);
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.max(er.top - pr.top - 8, 0)}px`;
  };
  chart.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('pointerenter', () => show(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('click', () => show(el));
    el.addEventListener('pointerleave', () => (tip.hidden = true));
    el.addEventListener('blur', () => (tip.hidden = true));
  });
}

function renderDailyBars(chart, sessions, dates, now) {
  const days = dailyRunTime(sessions, dates, now);
  const maxH = niceMax(Math.max(...days.map((d) => msToHours(d.ms)), 1));
  const total = days.reduce((t, d) => t + d.ms, 0);
  const isMonth = dates.length > 7;
  const ticks = [maxH, maxH / 2, 0];
  const today = todayStr();

  chart.innerHTML = `
    <h2 class="card-title">${icon('chart')} Hose hours per day</h2>
    <p class="hint">Combined running time of the hoses shown, per day. Tap a bar for details.</p>
    <div class="chart">
      <div class="chart-y" aria-hidden="true">${ticks.map((v) => `<span>${fmtNum(v, 1)}h</span>`).join('')}</div>
      <div class="chart-plot">
        <div class="chart-grid" aria-hidden="true">${ticks.map(() => '<span></span>').join('')}</div>
        <div class="chart-bars ${isMonth ? 'dense' : ''}" role="list">
          ${days
            .map((d) => {
              const h = msToHours(d.ms);
              const pct = (h / maxH) * 100;
              const tipText = `${fmtDate(d.date)}: ${d.ms ? fmtDur(d.ms) : 'not used'}`;
              return `<button type="button" class="chart-col ${d.date === today ? 'today' : ''}" role="listitem" data-tip="${esc(tipText)}" aria-label="${esc(tipText)}">
                <span class="chart-bar ${d.ms ? '' : 'zero'}" style="height:${pct}%"></span>
              </button>`;
            })
            .join('')}
        </div>
        <div class="chart-tip" hidden></div>
      </div>
      <div class="chart-x" aria-hidden="true">
        ${days
          .map((d) => {
            const day = Number(d.date.slice(8));
            const show = !isMonth || (day - 1) % 7 === 0;
            return `<span>${show ? (isMonth ? day : esc(fmtDate(d.date, { weekday: 'narrow' }))) : ''}</span>`;
          })
          .join('')}
      </div>
    </div>
    <p class="chart-foot">Total ${fmtNum(msToHours(total), 1)} h · busiest day ${fmtNum(Math.max(...days.map((d) => msToHours(d.ms))), 1)} h</p>`;
  wireTooltip(chart);
}

function renderTimeline(chart, sessions, rs, re, now, hoseLabel) {
  const span = re - rs;
  const lanes = new Map();
  for (const s of [...sessions].sort((a, b) => a.start - b.start)) {
    if (!lanes.has(s.hoseId)) lanes.set(s.hoseId, { name: hoseLabel(s.hoseId, s.hoseName), segs: [] });
    lanes.get(s.hoseId).segs.push(s);
  }
  const nowPct = now >= rs && now < re ? ((now - rs) / span) * 100 : null;
  const hourTicks = [0, 6, 12, 18, 24];

  chart.innerHTML = `
    <h2 class="card-title">${icon('clock')} Timeline</h2>
    ${
      lanes.size
        ? `<div class="timeline">
        <div class="chart-plot">
          ${[...lanes.values()]
            .map(
              (lane) => `
            <div class="tl-lane">
              <span class="tl-name">${esc(lane.name)}</span>
              <span class="tl-track">
                ${hourTicks.slice(1, -1).map((h) => `<i class="tl-grid" style="left:${(h / 24) * 100}%"></i>`).join('')}
                ${lane.segs
                  .map((s) => {
                    const a = Math.max(s.start, rs);
                    const b = Math.min(s.end ?? now, re);
                    const left = ((a - rs) / span) * 100;
                    const width = Math.max(((b - a) / span) * 100, 0.6);
                    const tipText = `${lane.name}: ${tts(s.start)} → ${s.end ? tts(s.end) : 'now'} (${fmtDur((s.end ?? now) - s.start)})`;
                    return `<button type="button" class="tl-seg ${s.end ? '' : 'live'}" style="left:${left}%;width:${width}%" data-tip="${esc(tipText)}" aria-label="${esc(tipText)}"></button>`;
                  })
                  .join('')}
                ${nowPct != null ? `<i class="tl-now" style="left:${nowPct}%"></i>` : ''}
              </span>
            </div>`,
            )
            .join('')}
          <div class="chart-tip" hidden></div>
        </div>
        <div class="tl-axis" aria-hidden="true"><span></span><span class="tl-ticks">${hourTicks
          .map((h) => `<span style="left:${(h / 24) * 100}%">${use12() ? (h % 12 || 12) + (h < 12 || h === 24 ? 'a' : 'p') : String(h).padStart(2, '0')}</span>`)
          .join('')}</span></div>
      </div>`
        : '<p class="hint">No hoses ran on this day.</p>'
    }`;
  if (lanes.size) wireTooltip(chart);
}

function openSessionSheet(id, rerender) {
  const s = store.get('vacSessions', id);
  if (!s) return;
  const otherOpen = store.data().vacSessions.some((x) => x.hoseId === s.hoseId && x.end == null && x.id !== s.id);
  sheet({
    title: `Edit run — ${store.nameOf('hoses', s.hoseId, s.hoseName)}`,
    content: `
      <div class="stack">
        <label class="field"><span>Vacuum unit</span><select id="ss-asset">${optionsHTML(assetOptions(), s.assetId)}</select></label>
        <div class="field"><span class="label">Turned on</span><div id="ss-start"></div></div>
        <div class="field">
          <span class="label">Turned off</span>
          <label class="check"><input type="checkbox" id="ss-running" ${s.end ? '' : 'checked'} ${otherOpen ? 'disabled' : ''}><span>Still running</span></label>
          <div id="ss-end" ${s.end ? '' : 'hidden'}></div>
        </div>
        <p class="form-error" hidden></p>
        <div class="btn-row">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" id="ss-save">Save</button>
        </div>
        <button type="button" class="btn btn-ghost btn-danger-text" id="ss-del">${icon('trash')} Delete this run</button>
      </div>`,
    onMount: (b, close) => {
      const startF = dateTimeField(b.querySelector('#ss-start'), { ts: s.start, label: 'Turned on' });
      const endF = dateTimeField(b.querySelector('#ss-end'), { ts: s.end ?? Date.now(), label: 'Turned off' });
      const running = b.querySelector('#ss-running');
      const err = b.querySelector('.form-error');
      running.addEventListener('change', () => (b.querySelector('#ss-end').hidden = running.checked));
      b.querySelector('#ss-save').addEventListener('click', () => {
        const start = startF.value;
        const end = running.checked ? null : endF.value;
        if (!start || (!running.checked && !end)) return formError(err, 'Pick the dates.');
        if (start > Date.now()) return formError(err, 'The start is in the future.');
        if (end != null && end <= start) return formError(err, 'Turned off must be after turned on.');
        if (end != null && end > Date.now() + 60000) return formError(err, 'Turned off is in the future.');
        const assetId = b.querySelector('#ss-asset').value || null;
        store.upsert('vacSessions', { id: s.id, start, end, assetId, assetName: store.nameOf('assets', assetId, '') });
        toast('Run updated');
        close();
        rerender();
      });
      b.querySelector('#ss-del').addEventListener('click', () => {
        close();
        deleteRuns([s.id], rerender);
      });
    },
  });
}
