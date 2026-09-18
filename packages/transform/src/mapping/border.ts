import type { Stroke } from '@web2figma/ir';
import { solidFromCss } from './color.js';

/**
 * Borders and corner radii (PRD section 10).
 *
 * Figma has one stroke per frame; CSS has four independent sides. When the
 * sides differ the caller is told to synthesise edge frames instead, which is
 * why `borderToStroke` reports `nonUniform` rather than guessing.
 */

export interface BorderSide {
  width: number;
  style: string;
  color: string;
}

export interface BorderInput {
  top: BorderSide;
  right: BorderSide;
  bottom: BorderSide;
  left: BorderSide;
}

export interface BorderResult {
  stroke: Stroke | null;
  /** Sides that must become their own frames because CSS is non-uniform. */
  nonUniform: boolean;
  /** Present when nonUniform: the visible sides, for edge-frame synthesis. */
  sides: { side: 'top' | 'right' | 'bottom' | 'left'; border: BorderSide }[];
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

export function dashPattern(style: string, weight: number): number[] | undefined {
  const s = style.toLowerCase();
  const w = Math.max(1, weight);
  if (s === 'dotted') return [w, w];
  if (s === 'dashed') return [3 * w, 2 * w];
  return undefined;
}

function visible(b: BorderSide): boolean {
  const s = b.style.toLowerCase();
  if (b.width <= 0) return false;
  if (s === 'none' || s === 'hidden') return false;
  return solidFromCss(b.color) !== null;
}

function sameSide(a: BorderSide, b: BorderSide): boolean {
  return (
    Math.abs(a.width - b.width) < 0.01 &&
    a.style.toLowerCase() === b.style.toLowerCase() &&
    a.color === b.color
  );
}

export function borderToStroke(input: BorderInput): BorderResult {
  const present = SIDES.filter((s) => visible(input[s]));
  if (present.length === 0) return { stroke: null, nonUniform: false, sides: [] };

  const first = input[present[0] as (typeof SIDES)[number]];
  const uniform =
    present.length === 4 && SIDES.every((s) => sameSide(input[s], first));

  if (uniform) {
    const paint = solidFromCss(first.color);
    if (!paint) return { stroke: null, nonUniform: false, sides: [] };
    const stroke: Stroke = {
      paint,
      weight: first.width,
      align: 'INSIDE',
    };
    const dash = dashPattern(first.style, first.width);
    if (dash) stroke.dash = dash;
    return { stroke, nonUniform: false, sides: [] };
  }

  return {
    stroke: null,
    nonUniform: true,
    sides: present.map((side) => ({ side, border: input[side] })),
  };
}

/**
 * Corner radii. Percentages resolve against the box; every radius is clamped to
 * half the shorter side, which is what browsers do when radii overlap.
 */
export function cornerRadius(
  values: [string, string, string, string],
  w: number,
  h: number,
): [number, number, number, number] {
  const limit = Math.min(w, h) / 2;
  const resolve = (v: string, axis: number): number => {
    const t = (v ?? '').trim();
    if (t === '' || t === 'none') return 0;
    // Elliptical radii ("10px 20px") collapse to the horizontal component:
    // Figma has no elliptical corners.
    const firstToken = t.split(/\s+/)[0] as string;
    const n = firstToken.endsWith('%')
      ? (parseFloat(firstToken) / 100) * axis
      : parseFloat(firstToken);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, limit);
  };
  return [
    resolve(values[0], w),
    resolve(values[1], w),
    resolve(values[2], w),
    resolve(values[3], w),
  ];
}
