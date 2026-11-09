// Asset readings: odometer, engine hours and PTO hours for each asset,
// plus a weekly round checklist that exports straight into the shared spreadsheet.

import * as store from '../store.js';
import {
  esc,
  todayStr,
  startOfWeek,
  addDays,
  fmtDate,
  fmtNum,
  parseNum,
  toTSV,
  toCSV,
  copyText,
  shareText,
  downloadFile,
  fmtDateFull,
} from '../util.js';
import { icon } from '../icons.js';
import { toast, confirmBox, periodNav, emptyState, on, formError } from '../ui.js';
import { openEditor } from './manage.js';

const METERS = [
  { key: 'odometer', label: 'Odometer', short: 'Odo', has: 'hasOdometer', step: '0.1' },
  { key: 'engine', label: 'Engine hours', short: 'Eng', has: 'hasEngine', step: '0.1' },
  { key: 'pto', label: 'PTO hours', short: 'PTO', has: 'hasPto', step: '0.1' },
];

let draft = null; // unsaved form contents survive switching tabs
let weekAnchor = null;
let historyAll = false;

// ---------------------------------------------------------------- data helpers

const sortReadings = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);

function readingsFor(assetId) {
  return store
    .data()
    .readings.filter((r) => r.assetId === assetId)
    .sort(sortReadings);
}

function weekRange(anchor) {
  const ws = startOfWeek(anchor, store.settings().weekStartsOn);
  return [ws, addDays(ws, 6)];
}

/** Latest reading per asset inside the week. */
function weekReadings(anchor) {
  const [from, to] = weekRange(anchor);
  const map = new Map();
  for (const r of [...store.data().readings].sort(sortReadings)) {
    if (r.date >= from && r.date <= to && !map.has(r.assetId)) map.set(r.assetId, r);
  }
  return map;
}

/** The asset after `afterId` (wrapping) that has no reading this week. */
function nextOutstanding(afterId) {
  const assets = store.list('assets');
  const done = weekReadings(todayStr());
  const start = Math.max(0, assets.findIndex((a) => a.id === afterId) + 1);
  for (let i = 0; i < assets.length; i++) {
    const a = assets[(start + i) % assets.length];
    if (!done.has(a.id)) return a.id;
  }
  return null;
}

/** Most recent earlier value of one meter for an asset (skipping N/A and the record being edited). */
function previousValue(assetId, key, date, excludeId) {
  return readingsFor(assetId).find(
    (r) => r.id !== excludeId && r.date <= date && !r[`${key}NA`] && r[key] != null,
  );
}

function freshDraft(assetId) {
  const a = store.get('assets', assetId);
  return {
    id: null,
    day: todayStr(),
    assetId: a?.id || '',
    date: todayStr(),
    odometer: '',
    engine: '',
    pto: '',
    odometerNA: a ? !a.hasOdometer : false,
    engineNA: a ? !a.hasEngine : false,
    ptoNA: a ? !a.hasPto : false,
    notes: '',
  };
}

const show = (r, key) => (r[`${key}NA`] ? 'N/A' : r[key] == null ? '—' : fmtNum(r[key], 1));

// ---------------------------------------------------------------- render

export function render(root) {
  const assets = store.list('assets');
  weekAnchor ??= todayStr();
  if (draft && !draft.id && draft.day !== todayStr()) draft = null; // new day, fresh form
  if (draft && draft.assetId && !store.get('assets', draft.assetId)) draft = null;
  if (!draft) draft = freshDraft(nextOutstanding() ?? assets[0]?.id);

  root.innerHTML = `
    <section class="card" id="r-card"></section>
    <section class="card" id="r-week"></section>
    <section class="card" id="r-history"></section>`;

  if (!assets.length && !draft.id) {
    root.querySelector('#r-card').innerHTML = emptyState({
      iconName: 'truck',
      title: 'Add your first asset',
      text: 'Add the trucks, plant and vacuum units you collect odometer, engine and PTO hours from.',
      action: `<button type="button" class="btn btn-primary" id="r-first">${icon('plus')} Add asset</button>`,
    });
    root.querySelector('#r-first').addEventListener('click', () =>
      openEditor('assets', null, (a) => {
        if (a) draft = freshDraft(a.id);
        render(root);
      }),
    );
    root.querySelector('#r-week').remove();
    root.querySelector('#r-history').remove();
    return;
  }

  renderForm(root);
  renderWeek(root);
  renderHistory(root);
}

function renderForm(root) {
  const card = root.querySelector('#r-card');
  const assets = store.list('assets');
  const current = store.get('assets', draft.assetId);
  // If editing a reading for an archived asset, still show it in the list.
  const options = current && current.archived ? [current, ...assets] : assets;

  card.innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${icon('gauge')} ${draft.id ? 'Edit reading' : 'Record readings'}</h2>
      <a class="btn btn-sm btn-ghost" href="#/manage/assets">${icon('pencil')} Assets</a>
    </div>
    <form id="r-form" class="stack" novalidate>
      <div class="field">
        <label for="r-asset">Asset</label>
        <div class="row">
          <select id="r-asset" class="grow">
            <option value="" ${draft.assetId ? '' : 'selected'} disabled>Choose an asset…</option>
            ${options
              .map((a) => `<option value="${a.id}" ${a.id === draft.assetId ? 'selected' : ''}>${esc(a.name)}${a.ref ? ` (${esc(a.ref)})` : ''}</option>`)
              .join('')}
          </select>
          <button type="button" class="icon-btn outline" id="r-new" aria-label="Add a new asset">${icon('plus')}</button>
        </div>
        <small class="hint" id="r-done"></small>
      </div>
      <label class="field"><span>Date</span><input type="date" id="r-date" value="${draft.date}" max="${todayStr()}"></label>
      ${METERS.map(
        (m) => `
        <div class="field meter" data-meter="${m.key}">
          <label for="r-${m.key}">${m.label}</label>
          <div class="row">
            <input id="r-${m.key}" class="grow" type="number" inputmode="decimal" step="${m.step}" min="0" value="${esc(draft[m.key])}" ${draft[`${m.key}NA`] ? 'disabled' : ''} placeholder="${draft[`${m.key}NA`] ? 'N/A' : 'Reading'}">
            <label class="na-toggle"><input type="checkbox" id="r-${m.key}-na" ${draft[`${m.key}NA`] ? 'checked' : ''}><span>N/A</span></label>
          </div>
          <small class="hint" id="r-${m.key}-last"></small>
        </div>`,
      ).join('')}
      <label class="field"><span>Notes (optional)</span><input type="text" id="r-notes" value="${esc(draft.notes)}" placeholder="e.g. gauge faulty, low fuel"></label>
      <p class="form-error" hidden></p>
      <div class="btn-row">
        ${draft.id ? `<button type="button" class="btn" id="r-cancel">Cancel</button>` : ''}
        <button type="submit" class="btn btn-primary grow">${icon('check')} ${draft.id ? 'Save changes' : 'Save readings'}</button>
      </div>
      ${draft.id ? `<button type="button" class="btn btn-ghost btn-danger-text" id="r-delete">${icon('trash')} Delete this reading</button>` : ''}
    </form>`;

  const form = card.querySelector('#r-form');
  const err = card.querySelector('.form-error');
  const $ = (id) => card.querySelector(id);

  const readInputs = () => {
    draft.assetId = $('#r-asset').value;
    draft.date = $('#r-date').value;
    draft.notes = $('#r-notes').value;
    for (const m of METERS) {
      draft[m.key] = $(`#r-${m.key}`).value;
      draft[`${m.key}NA`] = $(`#r-${m.key}-na`).checked;
    }
  };

  const updateHints = () => {
    for (const m of METERS) {
      const prev = draft.assetId ? previousValue(draft.assetId, m.key, draft.date || todayStr(), draft.id) : null;
      $(`#r-${m.key}-last`).textContent = prev ? `Last: ${fmtNum(prev[m.key], 1)} on ${fmtDate(prev.date)}` : '';
    }
    const done = $('#r-done');
    const existing = !draft.id && draft.assetId ? weekReadings(draft.date || todayStr()).get(draft.assetId) : null;
    if (existing) {
      done.innerHTML = `Already recorded this week (${esc(fmtDate(existing.date))}). <button type="button" class="link" id="r-edit-existing">Edit that instead</button>`;
      done.querySelector('#r-edit-existing').addEventListener('click', () => startEdit(root, existing));
    } else done.textContent = '';
  };

  const applyNA = () => {
    for (const m of METERS) {
      const input = $(`#r-${m.key}`);
      const na = $(`#r-${m.key}-na`).checked;
      input.disabled = na;
      input.placeholder = na ? 'N/A' : 'Reading';
      if (na) input.value = '';
    }
  };

  $('#r-asset').addEventListener('change', () => {
    const a = store.get('assets', $('#r-asset').value);
    if (!draft.id && a) {
      // New asset picked: start clean with its N/A defaults.
      for (const m of METERS) {
        $(`#r-${m.key}`).value = '';
        $(`#r-${m.key}-na`).checked = !a[m.has];
      }
      applyNA();
    }
    readInputs();
    updateHints();
    renderHistory(root);
    formError(err, '');
  });
  $('#r-date').addEventListener('change', () => {
    readInputs();
    updateHints();
  });
  for (const m of METERS) {
    $(`#r-${m.key}-na`).addEventListener('change', () => {
      applyNA();
      readInputs();
      if (!$(`#r-${m.key}-na`).checked) $(`#r-${m.key}`).focus();
    });
  }
  form.addEventListener('input', readInputs);

  $('#r-new').addEventListener('click', () =>
    openEditor('assets', null, (a) => {
      if (!a) return;
      draft = freshDraft(a.id);
      render(root);
    }),
  );

  $('#r-cancel')?.addEventListener('click', () => {
    draft = null;
    render(root);
  });

  $('#r-delete')?.addEventListener('click', async () => {
    if (!(await confirmBox('Delete this reading?', { ok: 'Delete', danger: true }))) return;
    store.remove('readings', draft.id);
    toast('Reading deleted');
    draft = null;
    render(root);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    readInputs();
    const asset = store.get('assets', draft.assetId);
    if (!asset) return formError(err, 'Choose an asset first.');
    if (!draft.date) return formError(err, 'Pick a date.');

    const rec = { id: draft.id || undefined, assetId: asset.id, assetName: asset.name, date: draft.date, notes: draft.notes.trim() };
    let anyValue = false;
    const lower = [];
    for (const m of METERS) {
      const na = draft[`${m.key}NA`];
      const val = na ? null : parseNum(draft[m.key]);
      if (!na && val == null) return formError(err, `Enter the ${m.label.toLowerCase()} or tick N/A.`);
      if (!na && val < 0) return formError(err, `${m.label} can't be negative.`);
      rec[m.key] = val;
      rec[`${m.key}NA`] = na;
      if (!na) {
        anyValue = true;
        const prev = previousValue(asset.id, m.key, draft.date, draft.id);
        if (prev && val < prev[m.key]) lower.push(`${m.label} ${fmtNum(val, 1)} is lower than the last reading (${fmtNum(prev[m.key], 1)} on ${fmtDate(prev.date)}).`);
      }
    }
    if (!anyValue) return formError(err, 'Every meter is N/A — enter at least one reading.');
    formError(err, '');
    if (lower.length && !(await confirmBox(`${lower.join(' ')} Save anyway?`, { title: 'Check the reading', ok: 'Save anyway' }))) return;

    const wasEdit = Boolean(draft.id);
    store.upsert('readings', rec);
    weekAnchor = draft.date;
    const next = wasEdit ? null : nextOutstanding(asset.id);
    draft = freshDraft(next ?? asset.id);
    render(root);
    const nextName = next ? store.get('assets', next)?.name : null;
    toast(wasEdit ? `Updated ${asset.name}` : `Saved ${asset.name}${nextName ? ` — next: ${nextName}` : ' — round complete'}`);
  });

  updateHints();
}

function startEdit(root, r) {
  draft = {
    id: r.id,
    day: todayStr(),
    assetId: r.assetId,
    date: r.date,
    notes: r.notes || '',
  };
  for (const m of METERS) {
    draft[m.key] = r[m.key] ?? '';
    draft[`${m.key}NA`] = Boolean(r[`${m.key}NA`]);
  }
  render(root);
  root.querySelector('#r-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------------------------------------------------------- weekly round

function weekTable(anchor) {
  const done = weekReadings(anchor);
  const assets = store.list('assets');
  // Include archived assets that do have a reading this week.
  for (const r of done.values()) {
    if (!assets.some((a) => a.id === r.assetId)) assets.push({ id: r.assetId, name: store.nameOf('assets', r.assetId, r.assetName) });
  }
  return assets.map((a) => ({ asset: a, reading: done.get(a.id) }));
}

function exportRows(anchor) {
  const rows = [['Asset', 'Rego / fleet no.', 'Date', 'Odometer', 'Engine hours', 'PTO hours', 'Notes']];
  for (const { asset, reading: r } of weekTable(anchor)) {
    const v = (key) => (!r ? '' : r[`${key}NA`] ? 'N/A' : r[key] ?? '');
    rows.push([asset.name, asset.ref || '', r ? r.date : 'not recorded', v('odometer'), v('engine'), v('pto'), r?.notes || '']);
  }
  return rows;
}

function renderWeek(root) {
  const card = root.querySelector('#r-week');
  const [from, to] = weekRange(weekAnchor);
  const isThisWeek = from === weekRange(todayStr())[0];
  const table = weekTable(weekAnchor);
  const doneCount = table.filter((t) => t.reading).length;
  const pct = table.length ? Math.round((doneCount / table.length) * 100) : 0;

  card.innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${icon('calendar')} Weekly round</h2>
      ${isThisWeek ? '' : '<button type="button" class="btn btn-sm btn-ghost" data-nav="0">This week</button>'}
    </div>
    ${periodNav({ label: `${fmtDate(from, { day: 'numeric', month: 'short' })} – ${fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}`, sub: isThisWeek ? 'This week' : '' })}
    <div class="progress" role="progressbar" aria-valuenow="${doneCount}" aria-valuemin="0" aria-valuemax="${table.length}" aria-label="Assets recorded">
      <div class="progress-bar" style="width:${pct}%"></div>
    </div>
    <p class="progress-label"><strong>${doneCount} of ${table.length}</strong> assets recorded</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Asset</th><th class="num">Odo</th><th class="num">Eng</th><th class="num">PTO</th></tr></thead>
        <tbody>
          ${table
            .map(
              ({ asset, reading: r }) => `
            <tr data-asset="${asset.id}" class="${r ? 'done' : 'todo'}">
              <td><span class="status-dot ${r ? 'ok' : ''}" aria-hidden="true">${r ? icon('check') : ''}</span>${esc(asset.name)}${r ? '' : '<span class="sr-only"> (not recorded)</span>'}</td>
              <td class="num">${r ? show(r, 'odometer') : '<span class="muted">—</span>'}</td>
              <td class="num">${r ? show(r, 'engine') : '<span class="muted">—</span>'}</td>
              <td class="num">${r ? show(r, 'pto') : '<span class="muted">—</span>'}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <p class="hint">Tap an asset to record or edit it. Copy pastes straight into the spreadsheet.</p>
    <div class="btn-row wrap">
      <button type="button" class="btn btn-sm" data-act="copy">${icon('copy')} Copy</button>
      <button type="button" class="btn btn-sm" data-act="share">${icon('share')} Share</button>
      <button type="button" class="btn btn-sm" data-act="csv">${icon('download')} CSV</button>
    </div>`;

  on(card, '[data-nav]', 'click', (_, el) => {
    const step = Number(el.dataset.nav);
    weekAnchor = step === 0 ? todayStr() : addDays(weekAnchor, step * 7);
    renderWeek(root);
  });

  on(card, 'tr[data-asset]', 'click', (_, el) => {
    const r = weekReadings(weekAnchor).get(el.dataset.asset);
    if (r) return startEdit(root, r);
    if (!store.get('assets', el.dataset.asset)) return;
    draft = freshDraft(el.dataset.asset);
    renderForm(root);
    renderHistory(root);
    root.querySelector('#r-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  on(card, '[data-act]', 'click', async (_, el) => {
    const rows = exportRows(weekAnchor);
    const title = `Asset readings — week of ${fmtDateFull(from)}`;
    if (el.dataset.act === 'copy') {
      toast((await copyText(toTSV(rows))) ? 'Copied — paste into the spreadsheet' : 'Copy failed', { kind: 'ok' });
    } else if (el.dataset.act === 'csv') {
      downloadFile(`asset-readings-week-${from}.csv`, '﻿' + toCSV(rows), 'text/csv');
    } else {
      const text =
        `${title}\n\n` +
        rows
          .slice(1)
          .map((r) => (r[2] === 'not recorded' ? `${r[0]}: not recorded` : `${r[0]}: Odo ${r[3] || '—'} · Eng ${r[4] || '—'} · PTO ${r[5] || '—'}${r[6] ? ` (${r[6]})` : ''}`))
          .join('\n');
      if (!(await shareText(title, text))) {
        await copyText(text);
        toast('Sharing not available — copied instead');
      }
    }
  });
}

// ---------------------------------------------------------------- history

function renderHistory(root) {
  const card = root.querySelector('#r-history');
  if (!card) return;
  const asset = store.get('assets', draft.assetId);
  const all = historyAll || !asset;
  const list = all ? [...store.data().readings].sort(sortReadings).slice(0, 50) : readingsFor(asset.id).slice(0, 50);

  // delta vs the previous reading of the same asset
  const delta = (r, key) => {
    if (r[`${key}NA`] || r[key] == null) return '';
    const prev = previousValue(r.assetId, key, r.date, r.id);
    if (!prev || (prev.date === r.date && (prev.createdAt || 0) > (r.createdAt || 0))) return '';
    const d = r[key] - prev[key];
    return d ? `<small class="${d < 0 ? 'warn-text' : 'muted'}">${d > 0 ? '+' : ''}${fmtNum(d, 1)}</small>` : '';
  };

  card.innerHTML = `
    <div class="card-head">
      <h2 class="card-title">${icon('list')} History</h2>
      <div class="seg seg-sm">
        <label><input type="radio" name="h-scope" value="one" ${all ? '' : 'checked'} ${asset ? '' : 'disabled'}><span>${esc(asset ? asset.name : 'This asset')}</span></label>
        <label><input type="radio" name="h-scope" value="all" ${all ? 'checked' : ''}><span>All</span></label>
      </div>
    </div>
    ${
      list.length
        ? `<ul class="list">${list
            .map(
              (r) => `
          <li><button type="button" class="list-row" data-id="${r.id}">
            <span class="list-main">
              <strong>${all ? `${esc(store.nameOf('assets', r.assetId, r.assetName))} · ` : ''}${esc(fmtDate(r.date, { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' }))}</strong>
              <span class="readings">${METERS.map((m) => `<span><em>${m.short}</em> ${show(r, m.key)} ${delta(r, m.key)}</span>`).join('')}</span>
              ${r.notes ? `<small>${esc(r.notes)}</small>` : ''}
            </span>
            ${icon('pencil', 'muted')}
          </button></li>`,
            )
            .join('')}</ul>`
        : `<p class="hint">No readings yet${asset && !all ? ` for ${esc(asset.name)}` : ''}.</p>`
    }`;

  on(card, 'input[name="h-scope"]', 'change', (e) => {
    historyAll = e.target.value === 'all';
    renderHistory(root);
  });
  on(card, '.list-row', 'click', (_, el) => {
    const r = store.get('readings', el.dataset.id);
    if (r) startEdit(root, r);
  });
}
