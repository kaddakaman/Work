// All app data lives in one JSON document in this phone's localStorage.
// Nothing is sent anywhere. Use Manage → Settings → Backup to keep a copy.

import { uid, byName } from './util.js';

const KEY = 'workmate:data';
export const SCHEMA = 1;

const listeners = new Set();
let storageOk = true;

function seed() {
  return {
    schema: SCHEMA,
    settings: {
      weekStartsOn: 1, // Monday
      timeFormat: '24', // '24' | '12'
      minuteStep: 1, // time wheel minute increments
      lastBackupAt: null,
      crewId: '', // ground crew shown on the Vacuum page ('' = all crews)
    },
    crews: [
      { id: uid(), name: 'Ground Crew 1', createdAt: Date.now() },
      { id: uid(), name: 'Ground Crew 2', createdAt: Date.now() },
    ],
    assets: [],
    readings: [],
    allowances: [],
    shifts: [],
    hoses: [],
    vacSessions: [],
    locations: [],
    jobTypes: [
      { id: uid(), name: 'Sentry', createdAt: Date.now() },
      { id: uid(), name: 'Tank cleaning', createdAt: Date.now() },
    ],
    sentry: [],
  };
}

/** Fill in anything missing so older backups / saves still load. */
export function normalise(input) {
  const base = seed();
  const src = input && typeof input === 'object' ? input : {};
  const out = { ...base, ...src, schema: SCHEMA };
  out.settings = { ...base.settings, ...(src.settings || {}) };
  for (const key of Object.keys(base)) {
    if (Array.isArray(base[key]) && !Array.isArray(out[key])) out[key] = base[key];
  }
  return out;
}

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    storageOk = false;
    return seed();
  }
  if (!raw) return seed();
  try {
    return normalise(JSON.parse(raw));
  } catch (e) {
    // Never silently throw away data we couldn't read: park it under another key.
    console.error('Saved data could not be read', e);
    try {
      localStorage.setItem(`${KEY}:unreadable:${Date.now()}`, raw);
    } catch {
      /* ignore */
    }
    return seed();
  }
}

let db = load();

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
    storageOk = true;
  } catch (e) {
    console.error('Could not save', e);
    storageOk = false;
  }
}
// Save straight away so anything added by normalise() (e.g. a new list in an
// update) keeps the same ids next time the app opens.
if (storageOk) write();

function changed() {
  write();
  listeners.forEach((fn) => fn());
}

// ---------------------------------------------------------------- reading

export const data = () => db;
export const settings = () => db.settings;
export const storageWorking = () => storageOk;

/** Named lists (assets, hoses, …) sorted by name. Archived items hidden unless asked. */
export function list(coll, { archived = false } = {}) {
  return db[coll].filter((x) => archived || !x.archived).sort(byName);
}

export const get = (coll, id) => (id ? db[coll].find((x) => x.id === id) : undefined);

/** Current name of a list item, falling back to the name saved on the record. */
export function nameOf(coll, id, fallback = '') {
  return get(coll, id)?.name ?? fallback;
}

// ---------------------------------------------------------------- writing

/** Insert or update. Returns the saved item. */
export function upsert(coll, item) {
  const arr = db[coll];
  const i = item.id ? arr.findIndex((x) => x.id === item.id) : -1;
  let saved;
  if (i >= 0) {
    saved = { ...arr[i], ...item, updatedAt: Date.now() };
    arr[i] = saved;
  } else {
    saved = { ...item, id: item.id || uid(), createdAt: Date.now() };
    arr.push(saved);
  }
  changed();
  return saved;
}

export function remove(coll, id) {
  db[coll] = db[coll].filter((x) => x.id !== id);
  changed();
}

/** Make several changes and save once. */
export function mutate(fn) {
  fn(db);
  changed();
}

export function updateSettings(patch) {
  db.settings = { ...db.settings, ...patch };
  changed();
}

export function replaceAll(next) {
  db = normalise(next);
  changed();
}

export function exportJSON() {
  return JSON.stringify({ app: 'work-mate', exportedAt: new Date().toISOString(), ...db }, null, 2);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Another tab/window changed the data: reload it and tell the app. */
export function onExternalChange(fn) {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    db = load();
    fn();
  });
}
