// Manage page: the editable lists that fill every dropdown in the app
// (assets, hoses, allowances, locations, job types) plus settings & backup.

import * as store from '../store.js';
import {
  esc,
  fmtMoney,
  fmtDateFull,
  fmtHours,
  fmtTime,
  tsDate,
  tsTime,
  todayStr,
  toCSV,
  downloadFile,
  fmtDayName,
} from '../util.js';
import { shiftMinutes, shiftAllowanceTotal, jobMinutes, openSessionFor } from '../lib/calc.js';
import { icon } from '../icons.js';
import { sheet, confirmBox, toast, emptyState, on, formError } from '../ui.js';

// ---------------------------------------------------------------- list definitions

export const assetOptions = () => {
  const all = store.list('assets');
  const vac = all.filter((a) => a.isVacuum);
  const other = all.filter((a) => !a.isVacuum);
  return [
    { value: '', label: '— Not tethered —' },
    ...(vac.length ? [{ group: 'Vacuum units', options: vac.map((a) => ({ value: a.id, label: a.name })) }] : []),
    ...(other.length
      ? [{ group: vac.length ? 'Other assets' : 'Assets', options: other.map((a) => ({ value: a.id, label: a.name })) }]
      : []),
  ];
};

export const ENTITIES = {
  assets: {
    title: 'Assets',
    one: 'asset',
    icon: 'truck',
    intro: 'Vehicles, plant and vacuum units you take weekly readings from.',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'e.g. Truck 12 or VAC-03' },
      { key: 'ref', label: 'Rego / fleet number (optional)', type: 'text' },
      {
        type: 'group',
        label: 'Meters this asset has',
        note: 'Anything unticked is set to N/A automatically when you record readings.',
        fields: [
          { key: 'hasOdometer', label: 'Odometer', type: 'checkbox', def: true },
          { key: 'hasEngine', label: 'Engine hours', type: 'checkbox', def: true },
          { key: 'hasPto', label: 'PTO hours', type: 'checkbox', def: false },
        ],
      },
      { key: 'isVacuum', label: 'This is a vacuum unit (hoses can run from it)', type: 'checkbox', def: false },
      { key: 'notes', label: 'Notes (optional)', type: 'textarea' },
    ],
    sub: (a) =>
      [
        a.ref,
        [a.hasOdometer && 'Odo', a.hasEngine && 'Engine', a.hasPto && 'PTO'].filter(Boolean).join(' · ') || 'No meters',
        a.isVacuum && 'Vacuum unit',
      ]
        .filter(Boolean)
        .join('  •  '),
    usage: (id) => {
      const d = store.data();
      return [
        [d.readings.filter((r) => r.assetId === id).length, 'reading'],
        [d.hoses.filter((h) => h.assetId === id).length, 'tethered hose'],
        [d.vacSessions.filter((s) => s.assetId === id).length, 'vacuum run'],
      ];
    },
  },
  hoses: {
    title: 'Hoses',
    one: 'hose',
    icon: 'wind',
    intro: 'Vacuum hoses and the areas they run to. Tether each one to the vacuum unit it runs from.',
    fields: [
      { key: 'name', label: 'Hose name', type: 'text', required: true, placeholder: 'e.g. Forward dry' },
      { key: 'area', label: 'Area / description (optional)', type: 'text' },
      {
        key: 'assetId',
        label: 'Runs from (vacuum unit)',
        type: 'select',
        options: assetOptions,
        note: 'Mark an asset as a vacuum unit in Assets to list it first.',
      },
    ],
    sub: (h) => [h.area, h.assetId ? `↳ ${store.nameOf('assets', h.assetId, 'deleted asset')}` : 'Not tethered'].filter(Boolean).join('  •  '),
    usage: (id) => [[store.data().vacSessions.filter((s) => s.hoseId === id).length, 'recorded run']],
    beforeSave: (item, prev) => {
      // Re-tethering a hose that's on corrects its current run too.
      if (prev && prev.assetId !== item.assetId) {
        store.mutate((d) => {
          const s = openSessionFor(d.vacSessions, item.id);
          if (s) {
            s.assetId = item.assetId || null;
            s.assetName = store.nameOf('assets', item.assetId, '');
          }
        });
      }
    },
    beforeRemove: (item) => stopHose(item.id),
  },
  allowances: {
    title: 'Allowances',
    one: 'allowance',
    icon: 'dollar',
    intro: 'Allowances you can tick on a shift. Amounts can still be changed on the day.',
    fields: [
      { key: 'name', label: 'Allowance name', type: 'text', required: true, placeholder: 'e.g. Meal, Height, Confined space' },
      {
        key: 'type',
        label: 'How it is paid',
        type: 'seg',
        def: 'fixed',
        options: [
          { value: 'fixed', label: 'One-off amount' },
          { value: 'hourly', label: 'Hourly rate for the day' },
        ],
      },
      { key: 'amount', label: 'Usual amount ($)', type: 'number', step: '0.01', placeholder: '0.00' },
    ],
    sub: (a) => (a.type === 'hourly' ? `${fmtMoney(a.amount)} per hour worked` : `${fmtMoney(a.amount)} one-off`),
    usage: (id) => [
      [store.data().shifts.filter((s) => (s.allowances || []).some((a) => a.allowanceId === id)).length, 'shift'],
    ],
  },
  locations: {
    title: 'Locations',
    one: 'location',
    icon: 'pin',
    intro: 'Tanks, vessels or sites you log sentry and tank cleaning jobs at.',
    fields: [
      { key: 'name', label: 'Location name', type: 'text', required: true, placeholder: 'e.g. Tank 3' },
      { key: 'notes', label: 'Notes (optional)', type: 'textarea' },
    ],
    sub: (l) => l.notes || '',
    usage: (id) => [[store.data().sentry.filter((s) => s.locationId === id).length, 'log entry']],
  },
  jobTypes: {
    title: 'Job types',
    one: 'job type',
    icon: 'tag',
    intro: 'Roles you can log in the Sentry log, e.g. Sentry, Tank cleaning.',
    fields: [{ key: 'name', label: 'Job type', type: 'text', required: true, placeholder: 'e.g. Sentry' }],
    sub: () => '',
    usage: (id) => [[store.data().sentry.filter((s) => s.jobTypeId === id).length, 'log entry']],
  },
};

const SECTIONS = [...Object.keys(ENTITIES), 'settings'];
const SECTION_LABEL = { ...Object.fromEntries(Object.entries(ENTITIES).map(([k, v]) => [k, v.title])), settings: 'Settings & backup' };

/** Tether a hose to a vacuum unit (also corrects its current run if it's on). */
export function setHoseTether(hoseId, assetId) {
  const prev = store.get('hoses', hoseId);
  if (!prev) return;
  const next = { ...prev, assetId: assetId || null };
  ENTITIES.hoses.beforeSave(next, prev);
  store.upsert('hoses', next);
}

function stopHose(hoseId) {
  store.mutate((d) => {
    const s = openSessionFor(d.vacSessions, hoseId);
    if (s) s.end = Date.now();
  });
}

// ---------------------------------------------------------------- editor sheet

function fieldHTML(f, item) {
  const id = `f-${f.key}`;
  const val = item[f.key] ?? f.def ?? '';
  const note = f.note ? `<small class="hint">${esc(f.note)}</small>` : '';
  switch (f.type) {
    case 'group':
      return `<fieldset class="field"><legend>${esc(f.label)}</legend><div class="check-list">${f.fields
        .map((c) => fieldHTML(c, item))
        .join('')}</div>${note}</fieldset>`;
    case 'checkbox':
      return `<label class="check"><input type="checkbox" name="${f.key}" ${val ? 'checked' : ''}><span>${esc(f.label)}</span></label>${note}`;
    case 'textarea':
      return `<label class="field"><span>${esc(f.label)}</span><textarea id="${id}" name="${f.key}" rows="2">${esc(val)}</textarea>${note}</label>`;
    case 'select': {
      const opts = f.options();
      const optHTML = (o) =>
        `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${esc(o.label)}</option>`;
      return `<label class="field"><span>${esc(f.label)}</span><select id="${id}" name="${f.key}">${opts
        .map((o) => (o.group ? `<optgroup label="${esc(o.group)}">${o.options.map(optHTML).join('')}</optgroup>` : optHTML(o)))
        .join('')}</select>${note}</label>`;
    }
    case 'seg':
      return `<fieldset class="field"><legend>${esc(f.label)}</legend><div class="seg">${f.options
        .map(
          (o) =>
            `<label><input type="radio" name="${f.key}" value="${esc(o.value)}" ${o.value === val ? 'checked' : ''}><span>${esc(o.label)}</span></label>`,
        )
        .join('')}</div>${note}</fieldset>`;
    case 'number':
      return `<label class="field"><span>${esc(f.label)}</span><input id="${id}" name="${f.key}" type="number" inputmode="decimal" step="${f.step || 'any'}" min="0" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}">${note}</label>`;
    default:
      return `<label class="field"><span>${esc(f.label)}</span><input id="${id}" name="${f.key}" type="text" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} autocomplete="off">${note}</label>`;
  }
}

function readFields(form, fields, out = {}) {
  for (const f of fields) {
    if (f.type === 'group') readFields(form, f.fields, out);
    else if (f.type === 'checkbox') out[f.key] = form.elements[f.key].checked;
    else if (f.type === 'seg') out[f.key] = form.querySelector(`input[name="${f.key}"]:checked`)?.value ?? f.def;
    else if (f.type === 'number') {
      const v = form.elements[f.key].value;
      out[f.key] = v === '' ? 0 : Number(v);
    } else if (f.type === 'select') out[f.key] = form.elements[f.key].value || null;
    else out[f.key] = form.elements[f.key].value.trim();
  }
  return out;
}

/**
 * Open the add/edit sheet for a list item.
 * kind: 'assets' | 'hoses' | 'allowances' | 'locations' | 'jobTypes'
 */
export function openEditor(kind, existing = null, onSaved = () => {}) {
  const def = ENTITIES[kind];
  const item = existing ? { ...existing } : {};
  const isNew = !existing;

  const usage = existing ? def.usage(existing.id).filter(([n]) => n > 0) : [];
  const usageText = usage.map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ');

  sheet({
    title: isNew ? `Add ${def.one}` : `Edit ${def.one}`,
    content: `
      <form class="stack" novalidate>
        ${def.fields.map((f) => fieldHTML(f, item)).join('')}
        <p class="form-error" hidden></p>
        <div class="btn-row">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${isNew ? 'Add' : 'Save'}</button>
        </div>
        ${
          isNew
            ? ''
            : `<div class="danger-zone">
            ${usageText ? `<small class="hint">Used by ${esc(usageText)}. Records keep the saved name.</small>` : ''}
            <div class="btn-row">
              <button type="button" class="btn btn-ghost" data-archive>${existing.archived ? 'Restore' : 'Archive (hide from lists)'}</button>
              <button type="button" class="btn btn-ghost btn-danger-text" data-delete>${icon('trash')} Delete</button>
            </div>
          </div>`
        }
      </form>`,
    onMount: (body, close) => {
      const form = body.querySelector('form');
      const err = body.querySelector('.form-error');
      if (isNew) setTimeout(() => form.elements.name?.focus(), 50);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const values = readFields(form, def.fields);
        if (!values.name) return formError(err, 'Please enter a name.');
        const clash = store
          .data()
          [kind].find((x) => x.id !== existing?.id && x.name.trim().toLowerCase() === values.name.toLowerCase());
        if (clash) return formError(err, `There's already ${def.one === 'asset' ? 'an' : 'a'} ${def.one} called “${clash.name}”.`);
        const next = { ...item, ...values };
        def.beforeSave?.(next, existing);
        const saved = store.upsert(kind, next);
        close();
        toast(isNew ? `Added ${saved.name}` : `Saved ${saved.name}`);
        onSaved(saved);
      });

      body.querySelector('[data-archive]')?.addEventListener('click', () => {
        const archived = !existing.archived;
        if (archived) def.beforeRemove?.(existing);
        const saved = store.upsert(kind, { id: existing.id, archived });
        close();
        toast(archived ? `${saved.name} archived` : `${saved.name} restored`);
        onSaved(saved);
      });

      body.querySelector('[data-delete]')?.addEventListener('click', async () => {
        const ok = await confirmBox(
          usageText
            ? `Delete “${existing.name}”? It is used by ${usageText}. Those records are kept and show the saved name. Archiving just hides it instead.`
            : `Delete “${existing.name}”?`,
          { title: `Delete ${def.one}?`, ok: 'Delete', danger: true },
        );
        if (!ok) return;
        def.beforeRemove?.(existing);
        store.remove(kind, existing.id);
        close();
        toast(`Deleted ${existing.name}`);
        onSaved(null);
      });
    },
  });
}

// ---------------------------------------------------------------- page

export function render(root, [section = 'assets']) {
  if (!SECTIONS.includes(section)) section = 'assets';
  root.innerHTML = `
    <nav class="chips chips-scroll" aria-label="Manage sections">
      ${SECTIONS.map(
        (s) =>
          `<a class="chip ${s === section ? 'active' : ''}" href="#/manage/${s}" ${s === section ? 'aria-current="page"' : ''}>${esc(SECTION_LABEL[s])}</a>`,
      ).join('')}
    </nav>
    <div id="manage-body"></div>`;
  const body = root.querySelector('#manage-body');
  if (section === 'settings') renderSettings(body);
  else renderList(body, section);
  root.querySelector('.chip.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function renderList(body, kind) {
  const def = ENTITIES[kind];
  const active = store.list(kind);
  const archived = store.list(kind, { archived: true }).filter((x) => x.archived);

  const row = (x) => `
    <li><button type="button" class="list-row" data-id="${x.id}">
      <span class="list-main"><strong>${esc(x.name)}</strong>${def.sub(x) ? `<small>${esc(def.sub(x))}</small>` : ''}</span>
      ${icon('pencil', 'muted')}
    </button></li>`;

  body.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">${icon(def.icon)} ${esc(def.title)}</h2>
        <button type="button" class="btn btn-primary btn-sm" data-add>${icon('plus')} Add</button>
      </div>
      <p class="hint">${esc(def.intro)}</p>
      ${
        active.length
          ? `<ul class="list">${active.map(row).join('')}</ul>`
          : emptyState({ iconName: def.icon, title: `No ${def.title.toLowerCase()} yet`, text: `Tap Add to create your first ${def.one}.` })
      }
      ${
        archived.length
          ? `<details class="archived"><summary>Archived (${archived.length})</summary><ul class="list">${archived.map(row).join('')}</ul></details>`
          : ''
      }
    </section>`;

  const rerender = () => renderList(body, kind);
  body.querySelector('[data-add]').addEventListener('click', () => openEditor(kind, null, rerender));
  on(body, '.list-row', 'click', (_, el) => openEditor(kind, store.get(kind, el.dataset.id), rerender));
}

// ---------------------------------------------------------------- settings

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderSettings(body) {
  const st = store.settings();
  const d = store.data();
  const counts = `${d.readings.length} readings · ${d.shifts.length} shifts · ${d.vacSessions.length} vacuum runs · ${d.sentry.length} sentry entries`;
  const lastBackup = st.lastBackupAt ? fmtDateFull(tsDate(st.lastBackupAt)) : 'never';
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  body.innerHTML = `
    <section class="card">
      <h2 class="card-title">${icon('settings')} Preferences</h2>
      <label class="field"><span>Week starts on</span>
        <select id="s-week">${DAYS.map((n, i) => `<option value="${i}" ${i === st.weekStartsOn ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <small class="hint">Used for weekly hours totals and the weekly asset round. Match your pay week.</small>
      </label>
      <fieldset class="field"><legend>Time format</legend>
        <div class="seg">
          <label><input type="radio" name="s-fmt" value="24" ${st.timeFormat !== '12' ? 'checked' : ''}><span>24-hour (15:30)</span></label>
          <label><input type="radio" name="s-fmt" value="12" ${st.timeFormat === '12' ? 'checked' : ''}><span>12-hour (3:30pm)</span></label>
        </div>
      </fieldset>
      <label class="field"><span>Minute wheel steps</span>
        <select id="s-step">${[1, 5, 10, 15]
          .map((n) => `<option value="${n}" ${n === Number(st.minuteStep) ? 'selected' : ''}>Every ${n} minute${n > 1 ? 's' : ''}</option>`)
          .join('')}</select>
      </label>
    </section>

    <section class="card">
      <h2 class="card-title">${icon('download')} Backup</h2>
      <p class="hint">Everything is stored only on this phone — nothing is uploaded anywhere. If the phone is lost or the app is removed, the data goes with it, so download a backup now and then (e.g. to your email or cloud drive).</p>
      <p class="kv"><span>Last backup</span><strong>${esc(lastBackup)}</strong></p>
      <p class="kv"><span>Stored</span><strong>${esc(counts)}</strong></p>
      <div class="btn-row wrap">
        <button type="button" class="btn btn-primary" id="s-backup">${icon('download')} Download backup</button>
        <label class="btn">${icon('upload')} Restore backup<input type="file" id="s-restore" accept="application/json,.json" hidden></label>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">${icon('list')} Export to spreadsheet (CSV)</h2>
      <p class="hint">Opens in Excel, Numbers or Google Sheets.</p>
      <div class="btn-col">
        <button type="button" class="btn" data-csv="readings">${icon('gauge')} Asset readings</button>
        <button type="button" class="btn" data-csv="shifts">${icon('clock')} Hours worked</button>
        <button type="button" class="btn" data-csv="sentry">${icon('shield')} Sentry log</button>
        <button type="button" class="btn" data-csv="vacuum">${icon('wind')} Vacuum runs</button>
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">${icon('info')} Install on your phone</h2>
      ${
        isStandalone
          ? '<p class="hint">Installed — you’re running the app from your home screen. It works without signal.</p>'
          : `<p class="hint"><strong>iPhone:</strong> open this page in Safari → Share → <em>Add to Home Screen</em>.<br>
             <strong>Android:</strong> Chrome menu ⋮ → <em>Install app</em> (or <em>Add to Home screen</em>).</p>
             <button type="button" class="btn btn-primary" id="s-install" hidden>${icon('download')} Install app</button>`
      }
      <p class="hint" id="s-persist"></p>
    </section>

    <section class="card danger-card">
      <h2 class="card-title">${icon('trash')} Erase everything</h2>
      <p class="hint">Deletes all lists and records from this phone. Download a backup first.</p>
      <button type="button" class="btn btn-danger" id="s-erase">Erase all data</button>
    </section>
    <p class="about">Work Mate · data stays on this device</p>`;

  body.querySelector('#s-week').addEventListener('change', (e) => {
    store.updateSettings({ weekStartsOn: Number(e.target.value) });
    toast('Week start updated');
  });
  on(body, 'input[name="s-fmt"]', 'change', (e) => store.updateSettings({ timeFormat: e.target.value }));
  body.querySelector('#s-step').addEventListener('change', (e) => store.updateSettings({ minuteStep: Number(e.target.value) }));

  body.querySelector('#s-backup').addEventListener('click', () => {
    downloadFile(`work-mate-backup-${todayStr()}.json`, store.exportJSON(), 'application/json');
    store.updateSettings({ lastBackupAt: Date.now() });
    toast('Backup downloaded');
    renderSettings(body);
  });

  body.querySelector('#s-restore').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast('That file is not a Work Mate backup.', { kind: 'error' });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.assets) || !Array.isArray(parsed.shifts)) {
      toast('That file is not a Work Mate backup.', { kind: 'error' });
      return;
    }
    const when = parsed.exportedAt ? ` from ${fmtDateFull(tsDate(Date.parse(parsed.exportedAt)))}` : '';
    const ok = await confirmBox(`Replace everything on this phone with the backup${when}? Current data will be overwritten.`, {
      title: 'Restore backup?',
      ok: 'Restore',
      danger: true,
    });
    if (!ok) return;
    store.replaceAll(parsed);
    toast('Backup restored');
    renderSettings(body);
  });

  on(body, '[data-csv]', 'click', (_, el) => exportCSV(el.dataset.csv));

  const installBtn = body.querySelector('#s-install');
  if (installBtn && window.__installPrompt) {
    installBtn.hidden = false;
    installBtn.addEventListener('click', async () => {
      const p = window.__installPrompt;
      window.__installPrompt = null;
      p.prompt();
      await p.userChoice;
      installBtn.hidden = true;
    });
  }

  const persistEl = body.querySelector('#s-persist');
  navigator.storage?.persisted?.().then((p) => {
    persistEl.textContent = p
      ? 'Storage is set to persistent — the phone won’t clear it to free space.'
      : 'Tip: installing the app to your home screen keeps the phone from clearing its storage.';
  });

  body.querySelector('#s-erase').addEventListener('click', async () => {
    const ok = await confirmBox('This permanently deletes every asset, reading, shift, hose, vacuum run and sentry entry on this phone.', {
      title: 'Erase all data?',
      ok: 'Erase everything',
      danger: true,
    });
    if (!ok) return;
    const ok2 = await confirmBox('Last check — this cannot be undone.', { title: 'Really erase?', ok: 'Yes, erase', danger: true });
    if (!ok2) return;
    store.replaceAll({});
    toast('All data erased');
    renderSettings(body);
  });
}

function exportCSV(kind) {
  const d = store.data();
  const use12 = store.settings().timeFormat === '12';
  const t = (x) => fmtTime(x, use12);
  const stamp = todayStr();
  let rows;
  let name;
  if (kind === 'readings') {
    name = 'asset-readings';
    rows = [['Date', 'Asset', 'Rego / fleet no.', 'Odometer', 'Engine hours', 'PTO hours', 'Notes']];
    [...d.readings]
      .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0))
      .forEach((r) => {
        const a = store.get('assets', r.assetId);
        const v = (val, na) => (na ? 'N/A' : val ?? '');
        rows.push([r.date, a?.name ?? r.assetName, a?.ref ?? '', v(r.odometer, r.odometerNA), v(r.engine, r.engineNA), v(r.pto, r.ptoNA), r.notes || '']);
      });
  } else if (kind === 'shifts') {
    name = 'hours-worked';
    rows = [['Date', 'Day', 'Start', 'Finish', 'Unpaid break (min)', 'Hours', 'Allowances', 'Allowance total ($)', 'Notes']];
    [...d.shifts]
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
      .forEach((s) =>
        rows.push([
          s.date,
          fmtDayName(s.date),
          t(s.start),
          t(s.finish),
          s.breakMin || 0,
          fmtHours(shiftMinutes(s)),
          (s.allowances || []).map((a) => `${a.name} (${a.type === 'hourly' ? `$${a.amount}/h` : `$${a.amount}`})`).join('; '),
          shiftAllowanceTotal(s).toFixed(2),
          s.notes || '',
        ]),
      );
  } else if (kind === 'sentry') {
    name = 'sentry-log';
    rows = [['Date', 'Job type', 'Location', 'Start', 'Finish', 'Hours', 'Notes']];
    [...d.sentry]
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
      .forEach((e) =>
        rows.push([
          e.date,
          store.nameOf('jobTypes', e.jobTypeId, e.jobTypeName),
          store.nameOf('locations', e.locationId, e.locationName),
          t(e.start),
          e.finish ? t(e.finish) : 'in progress',
          fmtHours(jobMinutes(e)),
          e.notes || '',
        ]),
      );
  } else {
    name = 'vacuum-runs';
    rows = [['Hose', 'Vacuum unit', 'On date', 'On time', 'Off date', 'Off time', 'Hours']];
    [...d.vacSessions]
      .sort((a, b) => a.start - b.start)
      .forEach((s) =>
        rows.push([
          store.nameOf('hoses', s.hoseId, s.hoseName),
          s.assetId ? store.nameOf('assets', s.assetId, s.assetName) : '',
          tsDate(s.start),
          t(tsTime(s.start)),
          s.end ? tsDate(s.end) : 'still on',
          s.end ? t(tsTime(s.end)) : '',
          (((s.end ?? Date.now()) - s.start) / 3600000).toFixed(2),
        ]),
      );
  }
  if (rows.length === 1) {
    toast('Nothing to export yet');
    return;
  }
  downloadFile(`work-mate-${name}-${stamp}.csv`, '﻿' + toCSV(rows), 'text/csv');
  toast(`Exported ${rows.length - 1} rows`);
}

