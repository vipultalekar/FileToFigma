import type { Effect } from '@web2figma/ir';
import { parseColor } from './color.js';
import { splitTopLevel } from './gradient.js';

/**
 * box-shadow, filter and backdrop-filter -> Figma effects (PRD section 10).
 *
 * Only blur maps from the filter properties. Anything else is a signal to
 * rasterise the subtree, which the caller does after reading `rasterise`.
 */

export interface FilterResult {
  effects: Effect[];
  /** Functions that have no Figma analogue; the subtree must be rasterised. */
  unsupported: string[];
}

function px(token: string | undefined): number {
  if (!token) return 0;
  const n = parseFloat(token);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse one CSS shadow. Computed styles put the colour first, authored CSS
 * usually puts it last, so both orders are accepted.
 */
export function parseShadow(value: string): Effect | null {
  let text = value.trim();
  if (text === '' || text.toLowerCase() === 'none') return null;

  const inset = /(^|\s)inset(\s|$)/i.test(text);
  text = text.replace(/(^|\s)inset(\s|$)/i, ' ').trim();

  // Pull the colour out wherever it sits, including functional notations.
  const colorMatch = /(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}|\b[a-z]+\b(?!\s*\())/i.exec(
    text,
  );
  let color = { r: 0, g: 0, b: 0, a: 1 };
  if (colorMatch) {
    const parsed = parseColor(colorMatch[0]);
    if (parsed) {
      color = parsed;
      text = text.replace(colorMatch[0], ' ').trim();
    }
  }

  const nums = text.split(/\s+/).filter((t) => /^-?[\d.]/.test(t));
  if (nums.length < 2) return null;

  return {
    type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
    color,
    offset: { x: px(nums[0]), y: px(nums[1]) },
    radius: Math.max(0, px(nums[2])),
    spread: px(nums[3]),
  };
}

/** A computed `box-shadow` may hold several comma-separated shadows. */
export function boxShadowToEffects(value: string | null): Effect[] {
  if (!value || value.trim().toLowerCase() === 'none') return [];
  const out: Effect[] = [];
  for (const part of splitTopLevel(value)) {
    const e = parseShadow(part);
    if (e) out.push(e);
  }
  return out;
}

const SUPPORTED_FILTERS = new Set(['blur', 'opacity', 'none']);

export function filterToEffects(
  value: string | null,
  kind: 'filter' | 'backdrop-filter',
): FilterResult {
  const result: FilterResult = { effects: [], unsupported: [] };
  if (!value || value.trim().toLowerCase() === 'none') return result;

  const fns = value.match(/[a-z-]+\([^)]*\)/gi) ?? [];
  for (const fn of fns) {
    const name = (/^([a-z-]+)\(/i.exec(fn)?.[1] ?? '').toLowerCase();
    const arg = /\(([^)]*)\)/.exec(fn)?.[1] ?? '';
    if (name === 'blur') {
      const radius = px(arg);
      if (radius > 0) {
        result.effects.push({
          type: kind === 'filter' ? 'LAYER_BLUR' : 'BACKGROUND_BLUR',
          radius,
        });
      }
      continue;
    }
    if (!SUPPORTED_FILTERS.has(name)) result.unsupported.push(name);
  }
  return result;
}
