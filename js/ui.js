// Shared UI pieces: toasts, bottom sheets, confirm dialogs.
import { esc } from './util.js';
import { icon } from './icons.js';

let closeCurrentToast = null;

/** One toast at a time: a new one replaces the old (so a stale "Undo" can't be tapped). */
export function toast(message, { actionLabel, onAction, timeout = 4000, kind = '' } = {}) {
  closeCurrentToast?.();
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind ? `toast-${kind}` : ''}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span>${esc(message)}</span>${
    actionLabel ? `<button type="button" class="toast-action">${esc(actionLabel)}</button>` : ''
  }`;
  host.append(el);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (closeCurrentToast === close) closeCurrentToast = null;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  closeCurrentToast = close;
  el.querySelector('.toast-action')?.addEventListener('click', () => {
    close();
    onAction?.();
  });
  setTimeout(close, timeout);
  return close;
}

/**
 * Bottom sheet (modal). `content` is HTML; `onMount(body, close)` wires it up.
 * Returns a close() function.
 */
export function sheet({ title, content, onMount, onClose }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `
    <div class="sheet-inner">
      <header class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button>
      </header>
      <div class="sheet-body">${content}</div>
    </div>`;
  document.body.append(dlg);
  const close = () => {
    if (dlg.open) dlg.close();
  };
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.();
  });
  // Tap outside the sheet, or on any [data-close], closes it.
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) close();
  });
  dlg.showModal();
  onMount?.(dlg.querySelector('.sheet-body'), close);
  return close;
}

export function confirmBox(message, { title = 'Are you sure?', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    sheet({
      title,
      content: `<p class="confirm-msg">${esc(message)}</p>
        <div class="btn-row">
          <button type="button" class="btn" data-close>${esc(cancel)}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(ok)}</button>
        </div>`,
      onMount: (body, close) => {
        const okBtn = body.querySelector('[data-ok]');
        okBtn.focus();
        okBtn.addEventListener('click', () => {
          result = true;
          close();
        });
      },
      onClose: () => resolve(result),
    });
  });
}

/** Week / period navigator: ‹ label ›  (+ optional "Now" button) */
export function periodNav({ label, sub = '', showNow = false, nowLabel = 'This week' }) {
  return `
    <div class="period-nav">
      <button type="button" class="icon-btn" data-nav="-1" aria-label="Previous">${icon('left')}</button>
      <div class="period-label"><strong>${esc(label)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      <button type="button" class="icon-btn" data-nav="1" aria-label="Next">${icon('right')}</button>
    </div>
    ${showNow ? `<button type="button" class="btn btn-sm btn-ghost period-now" data-nav="0">${esc(nowLabel)}</button>` : ''}`;
}

export function emptyState({ iconName = 'info', title, text = '', action = '' }) {
  return `<div class="empty">${icon(iconName, 'empty-ico')}<h3>${esc(title)}</h3>${
    text ? `<p>${esc(text)}</p>` : ''
  }${action}</div>`;
}

/** Bind a handler to every element matching selector inside root. */
export function on(root, selector, event, fn) {
  root.querySelectorAll(selector).forEach((el) => el.addEventListener(event, (e) => fn(e, el)));
}

/** Show a one-line form error under the form. */
export function formError(el, message) {
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
  if (message) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
