const focusMatrices = new Map();
let onBackHandler = null;
let focusIndex = 0;

export function resetFocusIndex() {
  focusIndex = 0;
}

function visibleScreen() {
  return document.querySelector('.screen:not(.hidden)');
}

function getFocusableInView(viewId) {
  const view = document.getElementById(viewId);
  if (!view || view.classList.contains('hidden')) return [];
  return Array.from(view.querySelectorAll('.focusable:not([disabled]):not(.hidden)'));
}

function clearFocusedClass() {
  document.querySelectorAll('.focusable.focused').forEach((el) => el.classList.remove('focused'));
}

function applyFocusedClass(el) {
  clearFocusedClass();
  if (el instanceof HTMLElement) el.classList.add('focused');
}

function focusAtIndex(viewId, index) {
  const items = getFocusableInView(viewId);
  if (!items.length) return;
  focusIndex = ((index % items.length) + items.length) % items.length;
  items[focusIndex].focus();
  items[focusIndex].scrollIntoView({ block: 'nearest' });
  applyFocusedClass(items[focusIndex]);
}

function moveByList(viewId, direction) {
  const items = getFocusableInView(viewId);
  if (!items.length) return;
  const delta = direction === 'up' ? -1 : 1;
  focusAtIndex(viewId, focusIndex + delta);
}

function activateFocused(viewId) {
  const items = getFocusableInView(viewId);
  if (!items.length) return;
  const active = items[focusIndex] || document.activeElement;
  if (active && active.classList.contains('focusable')) active.click();
}

function handleKeydown(event) {
  const handled = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'];
  if (!handled.includes(event.key)) return;
  event.preventDefault();

  const visible = visibleScreen();
  if (!visible) return;
  const viewId = visible.id;

  if (event.key === 'ArrowLeft' || event.key === 'Escape') {
    if (typeof onBackHandler === 'function') onBackHandler();
    return;
  }

  if (event.key === 'ArrowUp') {
    moveByList(viewId, 'up');
    return;
  }

  if (event.key === 'ArrowDown') {
    moveByList(viewId, 'down');
    return;
  }

  if (event.key === 'ArrowRight' || event.key === 'Enter') {
    activateFocused(viewId);
  }
}

export function registerFocusMatrix(viewId, matrix) {
  focusMatrices.set(viewId, matrix || []);
}

export function focusFirstInView(viewId) {
  resetFocusIndex();
  const matrix = focusMatrices.get(viewId);
  if (matrix && matrix.length) {
    for (const row of matrix) {
      for (const element of row) {
        if (element instanceof HTMLElement && !element.classList.contains('hidden') && !element.disabled) {
          element.focus();
          applyFocusedClass(element);
          return;
        }
      }
    }
  }

  focusAtIndex(viewId, 0);
}

export function initNavigation({ onBack }) {
  onBackHandler = onBack;
  document.addEventListener('keydown', handleKeydown);
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.classList.contains('focusable')) return;

    const visible = visibleScreen();
    if (!visible || !visible.contains(target)) return;

    const items = getFocusableInView(visible.id);
    const index = items.indexOf(target);
    if (index >= 0) focusIndex = index;
    applyFocusedClass(target);
  });
}
