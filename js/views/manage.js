// Manage page: the editable lists that fill every dropdown in the app
// (assets, hoses, ground crews, allowances, job types, tanks, locations) plus settings & backup.

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
  uid,
  byName,
} from '../util.js';
import { shiftMinutes, shiftAllowanceTotal, jobMinutes, openSessionFor } from '../lib/calc.js';
import { icon } from '../icons.js';
import { sheet, confirmBox, toast, emptyState, on, formError } from '../ui.js';

// ---------------------------------------------------------------- list definitions

export const crewOptions = () => [
  { value: '', label: 'Not set (shows for every crew)' },
  ...store.list('crews').map((c) => ({ value: c.id, label: c.name })),
];

/** The crew an asset belongs to, ignoring deleted / archived crews. */
export function crewOf(asset) {
  const crew = asset?.crewId ? store.get('crews', asset.crewId) : null;
  return crew && !crew.archived ? crew : null;
}

/** A hose's crew: its own setting, otherwise the crew of the vacuum it runs from. */
export function hoseCrew(hose) {
  if (!hose) return null;
  const own = hose.crewId ? store.get('crews', hose.crewId) : null;
  if (own && !own.archived) return own;
  return crewOf(store.get('assets', hose.assetId));
}

/**
 * Choices for "runs from": vacuum units grouped by crew, then other assets.
 * With crewId, only that crew's (and crew-less) assets are listed, plus `include`.
 */
export function assetOptions({ crewId = '', include = '' } = {}) {
  const all = store.list('assets');
  const fits = (a) => !crewId || !crewOf(a) || crewOf(a).id === crewId || a.id === include;
  const opt = (a) => ({ value: a.id, label: a.name });
  const vac = all.filter((a) => a.isVacuum && fits(a));
  const groups = [];
  for (const c of store.list('crews')) {
    const list = vac.filter((a) => crewOf(a)?.id === c.id);
    if (list.length) groups.push({ group: `${c.name} vacuums`, options: list.map(opt) });
  }
  const noCrew = vac.filter((a) => !crewOf(a));
  if (noCrew.length) groups.push({ group: groups.length ? 'Vacuum units (no crew)' : 'Vacuum units', options: noCrew.map(opt) });
  const other = all.filter((a) => !a.isVacuum && fits(a));
  if (other.length) groups.push({ group: vac.length ? 'Other assets' : 'Assets', options: other.map(opt) });
  return [{ value: '', label: '— Not tethered —' }, ...groups];
}

/** Group list rows under their crew (crew order, then "No crew"). */
function byCrewGroup(crew) {
  const crews = store.list('crews');
  return crew
    ? { key: crew.id, label: crew.name, order: crews.findIndex((c) => c.id === crew.id) }
    : { key: '', label: 'No crew (shows for every crew)', order: 999 };
}

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
      {
        key: 'crewId',
        label: 'Ground crew',
        type: 'select',
        options: crewOptions,
        note: 'The Vacuum page only shows the vacuums for the crew you choose there.',
      },
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
    groupBy: (a) => byCrewGroup(crewOf(a)),
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
    intro: 'Vacuum hoses and the areas they run to. Each crew has its own hoses, so the same names can be used on both. Tether each hose to the vacuum unit it runs from.',
    fields: [
      { key: 'name', label: 'Hose name', type: 'text', required: true, placeholder: 'e.g. Forward dry' },
      { key: 'area', label: 'Area / description (optional)', type: 'text' },
      {
        key: 'crewId',
        label: 'Ground crew',
        type: 'select',
        options: crewOptions,
        note: 'A separate hose from any other crew’s, even with the same name.',
      },
      {
        key: 'assetId',
        label: 'Runs from (vacuum unit)',
        type: 'select',
        options: () => assetOptions(),
        note: 'Mark an asset as a vacuum unit in Assets to list it first.',
      },
    ],
    sub: (h) => [h.area, h.assetId ? `↳ ${store.nameOf('assets', h.assetId, 'deleted asset')}` : 'Not tethered'].filter(Boolean).join('  •  '),
    groupBy: (h) => byCrewGroup(hoseCrew(h)),
    // Older hoses took their crew from their vacuum: show that in the editor.
    prepare: (item) => {
      if (!item.crewId) item.crewId = hoseCrew(item)?.id || '';
    },
    // Picking a vacuum that belongs to a crew sets the hose's crew to match.
    wire: (form) => {
      form.elements.assetId.addEventListener('change', () => {
        const crew = crewOf(store.get('assets', form.elements.assetId.value));
        if (crew) form.elements.crewId.value = crew.id;
      });
    },
    validate: (v) => {
      const vacCrew = crewOf(store.get('assets', v.assetId));
      if (vacCrew && v.crewId && vacCrew.id !== v.crewId) {
        return `${store.nameOf('assets', v.assetId)} belongs to ${vacCrew.name}. Pick one of ${store.nameOf('crews', v.crewId)}’s vacuums, or change the crew.`;
      }
      return '';
    },
    // Names only need to be unique within a crew.
    clashScope: (other, v) => (hoseCrew(other)?.id || '') === (v.crewId || crewOf(store.get('assets', v.assetId))?.id || ''),
    scopeName: (v) => store.nameOf('crews', v.crewId || crewOf(store.get('assets', v.assetId))?.id, ''),
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
  crews: {
    title: 'Ground crews',
    one: 'crew',
    icon: 'users',
    intro: 'One crew per vessel. Give assets and hoses a crew and the Vacuum page will only show your crew’s.',
    fields: [{ key: 'name', label: 'Crew name', type: 'text', required: true, placeholder: 'e.g. Ground Crew 1' }],
    sub: (c) => {
      const d = store.data();
      const a = d.assets.filter((x) => x.crewId === c.id && !x.archived).length;
      const h = d.hoses.filter((x) => !x.archived && hoseCrew(x)?.id === c.id).length;
      return `${a} asset${a === 1 ? '' : 's'} · ${h} hose${h === 1 ? '' : 's'}`;
    },
    usage: (id) => [
      [store.data().assets.filter((a) => a.crewId === id).length, 'asset'],
      [store.data().hoses.filter((h) => h.crewId === id).length, 'hose'],
    ],
    beforeRemove: (item) => {
      if (store.settings().crewId === item.id) store.updateSettings({ crewId: '' });
    },
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
  tanks: {
    title: 'Tanks',
    one: 'tank',
    icon: 'tank',
    intro: 'Tanks you can pick on a job (optional on each job).',
    fields: [
      { key: 'name', label: 'Tank name', type: 'text', required: true, placeholder: 'e.g. 3P' },
      { key: 'notes', label: 'Notes (optional)', type: 'textarea' },
    ],
    sub: (x) => x.notes || '',
    usage: (id) => [[store.data().sentry.filter((s) => s.tankId === id).length, 'job']],
  },
  locations: {
    title: 'Locations',
    one: 'location',
    icon: 'pin',
    intro: 'Places you can pick on a job, e.g. a vessel, deck or wharf (optional on each job).',
    fields: [
      { key: 'name', label: 'Location name', type: 'text', required: true, placeholder: 'e.g. Main deck' },
      { key: 'notes', label: 'Notes (optional)', type: 'textarea' },
    ],
    sub: (l) => l.notes || '',
    usage: (id) => [[store.data().sentry.filter((s) => s.locationId === id).length, 'job']],
  },
  jobTypes: {
    title: 'Job types',
    one: 'job type',
    icon: 'tag',
    intro: 'Kinds of job you can log on the Jobs tab, e.g. Sentry, Tank cleaning.',
    fields: [{ key: 'name', label: 'Job type', type: 'text', required: true, placeholder: 'e.g. Sentry' }],
    sub: () => '',
    usage: (id) => [[store.data().sentry.filter((s) => s.jobTypeId === id).length, 'job']],
  },
};

const SECTIONS = ['assets', 'hoses', 'crews', 'allowances', 'jobTypes', 'tanks', 'locations', 'settings'];
const SECTION_LABEL = { ...Object.fromEntries(Object.entries(ENTITIES).map(([k, v]) => [k, v.title])), settings: 'Settings & backup' };

/** Tether a hose to a vacuum unit (also corrects its current run if it's on). */
export function setHoseTether(hoseId, assetId) {
  const prev = store.get('hoses', hoseId);
  if (!prev) return;
  const next = { ...prev, assetId: assetId || null };
  if (!next.crewId) next.crewId = crewOf(store.get('assets', assetId))?.id || '';
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
 * kind: 'assets' | 'hoses' | 'crews' | 'allowances' | 'locations' | 'jobTypes'
 * defaults: starting values for a new item (e.g. { crewId }).
 */
export function openEditor(kind, existing = null, onSaved = () => {}, defaults = {}) {
  const def = ENTITIES[kind];
  const item = existing ? { ...existing } : { ...defaults };
  def.prepare?.(item);
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
      def.wire?.(form);

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const values = readFields(form, def.fields);
        if (!values.name) return formError(err, 'Please enter a name.');
        const problem = def.validate?.(values);
        if (problem) return formError(err, problem);
        const clash = store
          .data()
          [kind].find(
            (x) =>
              x.id !== existing?.id &&
              x.name.trim().toLowerCase() === values.name.toLowerCase() &&
              (!def.clashScope || def.clashScope(x, values)),
          );
        if (clash) {
          const scope = def.scopeName?.(values);
          return formError(err, `There's already ${def.one === 'asset' ? 'an' : 'a'} ${def.one} called “${clash.name}”${scope ? ` in ${scope}` : ''}.`);
        }
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

  const listHTML = (items) => {
    const groups = new Map();
    for (const x of items) {
      const g = def.groupBy ? def.groupBy(x) : { key: '', label: '', order: 0 };
      if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
      groups.get(g.key).items.push(x);
    }
    // No crews in use: just a plain list.
    if (groups.size === 1 && groups.has('')) return `<ul class="list">${items.map(row).join('')}</ul>`;
    return [...groups.values()]
      .sort((a, b) => a.order - b.order)
      .map((g) => `<h3 class="sub-title list-group-title">${icon('users')} ${esc(g.label)} <span class="muted">(${g.items.length})</span></h3><ul class="list">${g.items.map(row).join('')}</ul>`)
      .join('');
  };
  const canCopy = kind === 'hoses' && store.list('crews').length >= 2 && active.length > 0;
  const move = MOVES[kind];

  body.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2 class="card-title">${icon(def.icon)} ${esc(def.title)}</h2>
        <button type="button" class="btn btn-primary btn-sm" data-add>${icon('plus')} Add</button>
      </div>
      <p class="hint">${esc(def.intro)}</p>
      ${canCopy ? `<button type="button" class="btn btn-sm" id="copy-hoses">${icon('copy')} Copy hoses to another crew</button>` : ''}
      ${move && active.length ? `<button type="button" class="btn btn-sm" id="move-list">${icon(ENTITIES[move.to].icon)} Move some to ${ENTITIES[move.to].title}…</button>` : ''}
      ${
        active.length
          ? listHTML(active)
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
  body.querySelector('#copy-hoses')?.addEventListener('click', () => openCopyHoses(rerender));
  body.querySelector('#move-list')?.addEventListener('click', () => openMoveSheet(kind, rerender));
}

// ---------------------------------------------------------------- move tanks <-> locations

const MOVES = {
  locations: { to: 'tanks', from: ['locationId', 'locationName'], dest: ['tankId', 'tankName'] },
  tanks: { to: 'locations', from: ['tankId', 'tankName'], dest: ['locationId', 'locationName'] },
};

/**
 * Move list items between Locations and Tanks. Jobs that used them move
 * with them (their location becomes their tank, or the other way round).
 */
export function openMoveSheet(kind, onDone = () => {}) {
  const move = MOVES[kind];
  const src = ENTITIES[kind];
  const dst = ENTITIES[move.to];
  const items = store.list(kind);
  const uses = (id) => store.data().sentry.filter((e) => e[move.from[0]] === id).length;

  sheet({
    title: `Move ${src.title.toLowerCase()} to ${dst.title}`,
    content: `
      <div class="stack">
        <p class="hint">Tick the ones that should be ${dst.title.toLowerCase()}. Jobs that used them move across too.</p>
        <div class="check-list">${items
          .map((x) => {
            const n = uses(x.id);
            return `<label class="check"><input type="checkbox" value="${x.id}"><span>${esc(x.name)}${n ? ` <small class="muted">(${n} job${n === 1 ? '' : 's'})</small>` : ''}</span></label>`;
          })
          .join('')}</div>
        <div class="btn-row">
          <button type="button" class="btn" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" id="mv-go" disabled>Move</button>
        </div>
      </div>`,
    onMount: (b, close) => {
      const go = b.querySelector('#mv-go');
      const picked = () => [...b.querySelectorAll('input:checked')].map((i) => i.value);
      b.addEventListener('change', () => {
        const n = picked().length;
        go.disabled = !n;
        go.textContent = n ? `Move ${n} to ${dst.title}` : 'Move';
      });
      go.addEventListener('click', () => {
        const ids = new Set(picked());
        let moved = 0;
        store.mutate((d) => {
          for (const id of ids) {
            const item = d[kind].find((x) => x.id === id);
            if (!item) continue;
            // Already in the other list under the same name? Use that one.
            const same = d[move.to].find((x) => x.name.trim().toLowerCase() === item.name.trim().toLowerCase());
            const targetId = same ? same.id : item.id;
            if (!same) d[move.to].push({ ...item });
            let stuck = 0;
            for (const e of d.sentry) {
              if (e[move.from[0]] !== id) continue;
              if (e[move.dest[0]] && e[move.dest[0]] !== targetId) {
                stuck += 1; // that job already has a different one: leave it as it is
                continue;
              }
              e[move.dest[0]] = targetId;
              e[move.dest[1]] = item.name;
              e[move.from[0]] = null;
              e[move.from[1]] = '';
            }
            if (!stuck) d[kind] = d[kind].filter((x) => x.id !== id);
            moved += 1;
          }
        });
        close();
        toast(`Moved ${moved} to ${dst.title}`);
        onDone();
      });
    },
  });
}

// ---------------------------------------------------------------- copy hoses between crews

/**
 * Both vessels have near-identical hose setups: copy one crew's hoses to
 * another as brand-new, separate hoses (no runs are shared).
 */
export function openCopyHoses(onDone = () => {}, { to: wantTo = '' } = {}) {
  const crews = store.list('crews');
  const hosesOf = (crewId) => store.list('hoses').filter((h) => (hoseCrew(h)?.id || '') === crewId);
  const sources = [...crews, { id: '', name: 'No crew set' }].filter((c) => hosesOf(c.id).length);
  let to = crews.some((c) => c.id === wantTo) ? wantTo : '';
  let from = sources.find((c) => c.id !== to)?.id ?? '';
  if (!to) to = crews.find((c) => c.id !== from)?.id ?? '';
  const nameOf = (id) => store.nameOf('crews', id, 'No crew set');
  const key = (h) => h.name.trim().toLowerCase();

  sheet({
    title: 'Copy hoses to another crew',
    content: '<div class="stack" id="cp"></div>',
    onMount: (b, close) => {
      const box = b.querySelector('#cp');
      const paint = () => {
        const src = hosesOf(from);
        const have = new Set(hosesOf(to).map(key));
        const toCopy = src.filter((h) => !have.has(key(h)));
        const srcVacs = [...new Set(toCopy.map((h) => h.assetId).filter((id) => store.get('assets', id)))]
          .map((id) => store.get('assets', id))
          .sort(byName);
        const targetVacs = store.list('assets').filter((a) => a.isVacuum && crewOf(a)?.id === to);
        const n = toCopy.length;
        box.innerHTML = `
          <div class="row2">
            <label class="field"><span>From</span><select id="cp-from">${sources
              .map((c) => `<option value="${c.id}" ${c.id === from ? 'selected' : ''}>${esc(c.name)}</option>`)
              .join('')}</select></label>
            <label class="field"><span>To</span><select id="cp-to">${crews
              .filter((c) => c.id !== from)
              .map((c) => `<option value="${c.id}" ${c.id === to ? 'selected' : ''}>${esc(c.name)}</option>`)
              .join('')}</select></label>
          </div>
          <p class="hint">Makes a new, separate hose in ${esc(nameOf(to))} for each one (same name and area). Runs and stats stay separate.</p>
          ${
            srcVacs.length
              ? `<fieldset class="field"><legend>Tether the copies to</legend>
                  ${srcVacs
                    .map(
                      (a, i) => `<label class="map-row"><span>${esc(a.name)} hoses →</span>
                        <select data-map="${a.id}"><option value="">Not tethered</option>${targetVacs
                          .map((t, j) => `<option value="${t.id}" ${j === i ? 'selected' : ''}>${esc(t.name)}</option>`)
                          .join('')}</select></label>`,
                    )
                    .join('')}
                  ${targetVacs.length ? '' : `<small class="hint">No vacuum units are set to ${esc(nameOf(to))} yet. Set their crew in Assets to choose them here, or tether the hoses later via ⋯.</small>`}
                </fieldset>`
              : ''
          }
          <p class="kv"><span>Hoses to copy</span><strong>${n}</strong></p>
          ${src.length - n ? `<p class="hint">${src.length - n} already exist${src.length - n === 1 ? 's' : ''} in ${esc(nameOf(to))} and will be skipped.</p>` : ''}
          <div class="btn-row">
            <button type="button" class="btn" data-close>Cancel</button>
            <button type="button" class="btn btn-primary" id="cp-go" ${n && to ? '' : 'disabled'}>${icon('copy')} Copy ${n} hose${n === 1 ? '' : 's'}</button>
          </div>`;

        box.querySelector('#cp-from').addEventListener('change', (e) => {
          from = e.target.value;
          if (to === from) to = crews.find((c) => c.id !== from)?.id ?? '';
          paint();
        });
        box.querySelector('#cp-to').addEventListener('change', (e) => {
          to = e.target.value;
          paint();
        });
        box.querySelector('#cp-go').addEventListener('click', () => {
          const map = {};
          box.querySelectorAll('[data-map]').forEach((s) => (map[s.dataset.map] = s.value || null));
          store.mutate((d) => {
            for (const h of toCopy) {
              d.hoses.push({ id: uid(), name: h.name, area: h.area || '', crewId: to, assetId: map[h.assetId] ?? null, createdAt: Date.now() });
            }
          });
          close();
          toast(`Copied ${n} hose${n === 1 ? '' : 's'} to ${nameOf(to)}`);
          onDone();
        });
      };
      paint();
    },
  });
}

// ---------------------------------------------------------------- settings

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderSettings(body) {
  const st = store.settings();
  const d = store.data();
  const counts = `${d.readings.length} readings · ${d.shifts.length} shifts · ${d.vacSessions.length} vacuum runs · ${d.sentry.length} jobs`;
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
        <button type="button" class="btn" data-csv="sentry">${icon('clipboard')} Jobs</button>
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
    <p class="about">Work Mate <span id="s-version"></span> · data stays on this device</p>
    <div class="center"><button type="button" class="btn btn-sm btn-ghost" id="s-update">Check for updates</button></div>`;

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

  window.caches
    ?.keys()
    .then((keys) => {
      const v = keys.find((k) => k.startsWith('work-mate-'));
      if (v) body.querySelector('#s-version').textContent = v.replace('work-mate-', '');
    })
    .catch(() => {});

  body.querySelector('#s-update').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) {
      toast('Updates apply automatically when the page is reloaded.');
      return;
    }
    btn.disabled = true;
    window.__reloadOnUpdate = true; // the app reloads itself once the new version is in
    try {
      await reg.update();
      if (reg.installing || reg.waiting) toast('Downloading the new version…');
      else toast('You have the latest version');
    } catch {
      toast('Couldn’t check for updates — no signal?', { kind: 'error' });
    }
    btn.disabled = false;
  });

  const persistEl = body.querySelector('#s-persist');
  navigator.storage?.persisted?.().then((p) => {
    persistEl.textContent = p
      ? 'Storage is set to persistent — the phone won’t clear it to free space.'
      : 'Tip: installing the app to your home screen keeps the phone from clearing its storage.';
  });

  body.querySelector('#s-erase').addEventListener('click', async () => {
    const ok = await confirmBox('This permanently deletes every asset, reading, shift, hose, vacuum run and job on this phone.', {
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
    name = 'jobs';
    rows = [['Date', 'Job type', 'Tank', 'Location', 'Start', 'Finish', 'Hours', 'Notes']];
    [...d.sentry]
      .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
      .forEach((e) =>
        rows.push([
          e.date,
          store.nameOf('jobTypes', e.jobTypeId, e.jobTypeName),
          e.tankId ? store.nameOf('tanks', e.tankId, e.tankName) : '',
          e.locationId ? store.nameOf('locations', e.locationId, e.locationName) : '',
          t(e.start),
          e.finish ? t(e.finish) : 'in progress',
          fmtHours(jobMinutes(e)),
          e.notes || '',
        ]),
      );
  } else {
    name = 'vacuum-runs';
    rows = [['Hose', 'Crew', 'Vacuum unit', 'On date', 'On time', 'Off date', 'Off time', 'Hours', 'Ended by']];
    [...d.vacSessions]
      .sort((a, b) => a.start - b.start)
      .forEach((s) =>
        rows.push([
          store.nameOf('hoses', s.hoseId, s.hoseName),
          hoseCrew(store.get('hoses', s.hoseId))?.name ?? '',
          s.assetId ? store.nameOf('assets', s.assetId, s.assetName) : '',
          tsDate(s.start),
          t(tsTime(s.start)),
          s.end ? tsDate(s.end) : 'still on',
          s.end ? t(tsTime(s.end)) : '',
          (((s.end ?? Date.now()) - s.start) / 3600000).toFixed(2),
          !s.end ? '' : s.endReason === 'handover' ? 'handed over to night shift' : 'turned off',
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

