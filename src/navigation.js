const focusMatrices = new Map();
let currentViewId = null;
let onBackHandler = null;

function visibleScreen() {
  return document.querySelector('.screen:not(.hidden)');
}

function getFocusableInView(viewId) {
  const view = document.getElementById(viewId);
  if (!view || view.classList.contains('hidden')) return [];
  return Array.from(view.querySelectorAll('.focusable:not([disabled]):not(.hidden)'));
}

function findActivePosition(matrix, activeEl) {
  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix[r].length; c += 1) {
      if (matrix[r][c] === activeEl) return { r, c };
    }
  }
  return null;
}

function moveByMatrix(viewId, direction) {
  const matrix = focusMatrices.get(viewId);
  if (!matrix || matrix.length === 0) return false;

  const active = document.activeElement;
  let position = findActivePosition(matrix, active);
  if (!position) {
    for (let r = 0; r < matrix.length; r += 1) {
      for (let c = 0; c < matrix[r].length; c += 1) {
        if (matrix[r][c] instanceof HTMLElement) {
          matrix[r][c].focus();
          return true;
        }
      }
    }
    return false;
  }

  let nr = position.r;
  let nc = position.c;
  const rowLen = matrix[position.r].length;

  if (direction === 'up') nr = (position.r - 1 + matrix.length) % matrix.length;
  if (direction === 'down') nr = (position.r + 1) % matrix.length;
  if (direction === 'left') nc = (position.c - 1 + rowLen) % rowLen;
  if (direction === 'right') nc = (position.c + 1) % rowLen;

  const target = matrix[nr]?.[nc];
  if (target instanceof HTMLElement && !target.disabled && !target.classList.contains('hidden')) {
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
    return true;
  }

  return false;
}

function moveByList(viewId, direction) {
  const items = getFocusableInView(viewId);
  if (items.length === 0) return;

  const active = document.activeElement;
  const idx = items.indexOf(active);
  const next = idx === -1
    ? 0
    : (direction === 'up' || direction === 'left'
      ? (idx - 1 + items.length) % items.length
      : (idx + 1) % items.length);

  items[next].focus();
  items[next].scrollIntoView({ block: 'nearest' });
}

function activateFocused() {
  const active = document.activeElement;
  if (active && active.classList.contains('focusable')) active.click();
}

function handleKeydown(event) {
  const handled = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'];
  if (!handled.includes(event.key)) return;
  event.preventDefault();

  const visible = visibleScreen();
  if (!visible) return;
  const viewId = visible.id;

  if (event.key === 'ArrowLeft') {
    if (!moveByMatrix(viewId, 'left') && typeof onBackHandler === 'function') onBackHandler();
    return;
  }

  if (event.key === 'ArrowUp') {
    if (!moveByMatrix(viewId, 'up')) moveByList(viewId, 'up');
    return;
  }

  if (event.key === 'ArrowDown') {
    if (!moveByMatrix(viewId, 'down')) moveByList(viewId, 'down');
    return;
  }

  if (event.key === 'ArrowRight') {
    if (!moveByMatrix(viewId, 'right')) activateFocused();
    return;
  }

  if (event.key === 'Enter') {
    activateFocused();
    return;
  }

  if (event.key === 'Escape' && typeof onBackHandler === 'function') {
    onBackHandler();
  }
}

export function registerFocusMatrix(viewId, matrix) {
  focusMatrices.set(viewId, matrix || []);
}

export function focusFirstInView(viewId) {
  currentViewId = viewId;
  const matrix = focusMatrices.get(viewId);
  if (matrix && matrix.length) {
    for (const row of matrix) {
      for (const element of row) {
        if (element instanceof HTMLElement && !element.classList.contains('hidden') && !element.disabled) {
          element.focus();
          return;
        }
      }
    }
  }

  const items = getFocusableInView(viewId);
  if (items[0]) items[0].focus();
}

export function initNavigation({ onBack }) {
  onBackHandler = onBack;
  document.addEventListener('keydown', handleKeydown);
}