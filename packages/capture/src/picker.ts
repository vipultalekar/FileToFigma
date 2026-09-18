/**
 * Element picker overlay (PRD section 5).
 *
 * Highlights the hovered element's border box with its tag, size and classes.
 * Click captures that element; shift-click adds to a multi-select, which the
 * caller wraps in a synthetic frame.
 */

export interface PickerHandle {
  cancel: () => void;
}

export interface PickerOptions {
  onPick: (elements: Element[]) => void;
  onCancel?: () => void;
  doc?: Document;
}

const OVERLAY_ID = 'web2figma-picker-overlay';

export function startPicker(options: PickerOptions): PickerHandle {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;
  const selected: Element[] = [];

  const overlay = doc.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483647',
    'border:2px solid #3b82f6',
    'background:rgba(59,130,246,0.12)',
    'border-radius:2px',
    'transition:all 60ms ease-out',
    'display:none',
  ].join(';');

  const label = doc.createElement('div');
  label.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483647',
    'background:#1e293b',
    'color:#fff',
    'font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
    'padding:4px 6px',
    'border-radius:4px',
    'white-space:nowrap',
    'display:none',
  ].join(';');

  const marks: HTMLElement[] = [];
  doc.body.append(overlay, label);

  let current: Element | null = null;

  const describe = (el: Element): string => {
    const box = el.getBoundingClientRect();
    const classes = typeof el.className === 'string'
      ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join('')
      : '';
    return `${el.tagName.toLowerCase()}${classes}  ${Math.round(box.width)} x ${Math.round(box.height)}`;
  };

  const place = (el: Element): void => {
    const box = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = `${box.left}px`;
    overlay.style.top = `${box.top}px`;
    overlay.style.width = `${box.width}px`;
    overlay.style.height = `${box.height}px`;
    label.style.display = 'block';
    label.textContent = describe(el);
    const above = box.top > 24;
    label.style.left = `${Math.max(4, box.left)}px`;
    label.style.top = above ? `${box.top - 22}px` : `${box.bottom + 4}px`;
  };

  const markSelected = (el: Element): void => {
    const box = el.getBoundingClientRect();
    const mark = doc.createElement('div');
    mark.style.cssText = [
      'position:fixed',
      'pointer-events:none',
      'z-index:2147483646',
      'border:2px solid #10b981',
      'background:rgba(16,185,129,0.12)',
      `left:${box.left}px`,
      `top:${box.top}px`,
      `width:${box.width}px`,
      `height:${box.height}px`,
    ].join(';');
    doc.body.appendChild(mark);
    marks.push(mark);
  };

  const onMove = (e: MouseEvent): void => {
    const el = doc.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label || el.id === OVERLAY_ID) return;
    current = el;
    place(el);
  };

  const onClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!current) return;
    if (e.shiftKey) {
      selected.push(current);
      markSelected(current);
      return;
    }
    const picks = selected.length > 0 ? [...selected, current] : [current];
    teardown();
    options.onPick(picks);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    teardown();
    options.onCancel?.();
  };

  function teardown(): void {
    overlay.remove();
    label.remove();
    for (const m of marks) m.remove();
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    win.removeEventListener('scroll', onScroll, true);
  }

  const onScroll = (): void => {
    if (current) place(current);
  };

  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  win.addEventListener('scroll', onScroll, true);

  return { cancel: () => { teardown(); options.onCancel?.(); } };
}
