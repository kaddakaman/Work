// Scroll-wheel time picker: flick the hour column, then the minute column.
// Uses CSS scroll-snap so it feels like the phone's own picker, and also
// responds to taps, the mouse wheel and arrow keys.

import { pad2, clamp } from '../util.js';

export const ITEM_H = 40; // must match .wheel-item height in app.css
const SETTLE_MS = 100;

function wheel({ items, index, label, onSelect }) {
  const col = document.createElement('div');
  col.className = 'wheel';
  col.tabIndex = 0;
  col.setAttribute('role', 'spinbutton');
  col.setAttribute('aria-label', label);

  let current = index;
  let els = [];
  let settleTimer = 0;
  let painting = false;

  const build = (newItems) => {
    items = newItems;
    col.innerHTML =
      '<div class="wheel-pad"></div>' +
      items.map((it, i) => `<div class="wheel-item" data-i="${i}">${it.label}</div>`).join('') +
      '<div class="wheel-pad"></div>';
    els = [...col.querySelectorAll('.wheel-item')];
  };

  const paint = () => {
    painting = false;
    const centre = col.scrollTop / ITEM_H;
    for (let i = 0; i < els.length; i++) {
      const d = Math.abs(i - centre);
      if (d > 3) continue;
      els[i].style.opacity = String(Math.max(0.25, 1 - d * 0.32));
    }
  };

  const mark = () => {
    els.forEach((el, i) => el.classList.toggle('sel', i === current));
    col.setAttribute('aria-valuetext', items[current]?.label ?? '');
    col.setAttribute('aria-valuenow', String(current));
  };

  const select = (i, emit = true) => {
    i = clamp(i, 0, items.length - 1);
    const changed = i !== current;
    current = i;
    mark();
    if (changed && emit) onSelect(i);
  };

  const jump = (i) => {
    // Position without animation (initial load, external set).
    col.scrollTop = clamp(i, 0, items.length - 1) * ITEM_H;
    paint();
  };

  const go = (i) => {
    i = clamp(i, 0, items.length - 1);
    select(i);
    col.scrollTo({ top: i * ITEM_H, behavior: 'smooth' });
  };

  col.addEventListener(
    'scroll',
    () => {
      if (!painting) {
        painting = true;
        requestAnimationFrame(paint);
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => select(Math.round(col.scrollTop / ITEM_H)), SETTLE_MS);
    },
    { passive: true },
  );

  col.addEventListener('click', (e) => {
    const it = e.target.closest('.wheel-item');
    if (it) go(Number(it.dataset.i));
  });

  col.addEventListener('keydown', (e) => {
    const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[e.key];
    if (step) {
      e.preventDefault();
      go(current + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(items.length - 1);
    }
  });

  // Scroll position can only be set once the wheel is visible; this also
  // re-centres it whenever it's shown again (e.g. inside a sheet).
  const ro = new ResizeObserver(() => {
    if (col.clientHeight > 0 && Math.round(col.scrollTop / ITEM_H) !== current) jump(current);
  });
  ro.observe(col);

  build(items);
  mark();

  return {
    el: col,
    get index() {
      return current;
    },
    setIndex(i) {
      select(i, false);
      jump(current);
    },
    setItems(newItems, i) {
      build(newItems);
      current = clamp(i, 0, newItems.length - 1);
      mark();
      jump(current);
    },
  };
}

function minuteItems(step, include) {
  const list = [];
  for (let m = 0; m < 60; m += step) list.push(m);
  if (include != null && !list.includes(include)) {
    list.push(include);
    list.sort((a, b) => a - b);
  }
  return list;
}

/**
 * createTimePicker({ value: 'HH:MM', use12h, step, label, onChange })
 * → { el, value (getter), set('HH:MM') }
 */
export function createTimePicker({ value = '07:00', use12h = false, step = 1, label = 'Time', onChange = () => {} } = {}) {
  let [h, m] = value.split(':').map(Number);
  step = [1, 5, 10, 15, 30].includes(Number(step)) ? Number(step) : 1;

  const root = document.createElement('div');
  root.className = 'timepicker';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);

  const band = document.createElement('div');
  band.className = 'wheel-band';
  root.append(band);

  const emit = () => onChange(get());
  const get = () => `${pad2(h)}:${pad2(m)}`;

  // Hours
  const hourItems = use12h
    ? Array.from({ length: 12 }, (_, i) => ({ label: String(i + 1), v: i + 1 }))
    : Array.from({ length: 24 }, (_, i) => ({ label: pad2(i), v: i }));
  const hourIndex = (hh) => (use12h ? ((hh + 11) % 12) : hh);
  const hourWheel = wheel({
    items: hourItems,
    index: hourIndex(h),
    label: `${label} hour`,
    onSelect: (i) => {
      if (use12h) {
        const pm = h >= 12;
        h = ((i + 1) % 12) + (pm ? 12 : 0);
      } else h = i;
      emit();
    },
  });

  // Minutes
  let mins = minuteItems(step, m);
  const toMinItems = (list) => list.map((v) => ({ label: pad2(v), v }));
  const minWheel = wheel({
    items: toMinItems(mins),
    index: mins.indexOf(m),
    label: `${label} minute`,
    onSelect: (i) => {
      m = mins[i];
      emit();
    },
  });

  const sep = document.createElement('div');
  sep.className = 'wheel-sep';
  sep.textContent = ':';

  root.append(hourWheel.el, sep, minWheel.el);

  // AM / PM
  let ampmWheel = null;
  if (use12h) {
    ampmWheel = wheel({
      items: [
        { label: 'am', v: 0 },
        { label: 'pm', v: 1 },
      ],
      index: h >= 12 ? 1 : 0,
      label: `${label} am or pm`,
      onSelect: (i) => {
        h = (h % 12) + (i ? 12 : 0);
        emit();
      },
    });
    ampmWheel.el.classList.add('wheel-ampm');
    root.append(ampmWheel.el);
  }

  function set(v) {
    [h, m] = v.split(':').map(Number);
    hourWheel.setIndex(hourIndex(h));
    if (!mins.includes(m)) {
      mins = minuteItems(step, m);
      minWheel.setItems(toMinItems(mins), mins.indexOf(m));
    } else minWheel.setIndex(mins.indexOf(m));
    ampmWheel?.setIndex(h >= 12 ? 1 : 0);
  }

  return {
    el: root,
    get value() {
      return get();
    },
    set,
  };
}
