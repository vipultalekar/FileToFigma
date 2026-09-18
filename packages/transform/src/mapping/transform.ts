/**
 * transform / blend-mode / overflow mapping (PRD section 10).
 *
 * getBoundingClientRect already reflects scale and translate, so the only thing
 * worth extracting from a 2D matrix is the rotation. Anything 3D, skewed or
 * perspective-bearing is reported as unsupported and the caller rasterises.
 */

import type { BlendMode } from '@web2figma/ir';

export interface DecomposedTransform {
  rotationDeg: number;
  scaleX: number;
  scaleY: number;
  skewXDeg: number;
  translate: { x: number; y: number };
  is3d: boolean;
  hasSkew: boolean;
}

export function parseMatrix(value: string | null): number[] | null {
  if (!value) return null;
  const t = value.trim();
  if (t === '' || t === 'none') return null;
  const m = /^matrix(3d)?\(([^)]*)\)$/i.exec(t);
  if (!m) return null;
  const nums = (m[2] as string).split(',').map((n) => parseFloat(n.trim()));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

export function decomposeTransform(value: string | null): DecomposedTransform | null {
  const nums = parseMatrix(value);
  if (!nums) return null;

  if (nums.length === 16) {
    // matrix3d: only a pure Z rotation is safe to keep.
    const flat =
      Math.abs(nums[2] ?? 0) < 1e-6 &&
      Math.abs(nums[6] ?? 0) < 1e-6 &&
      Math.abs(nums[8] ?? 0) < 1e-6 &&
      Math.abs(nums[9] ?? 0) < 1e-6 &&
      Math.abs((nums[10] ?? 1) - 1) < 1e-6 &&
      Math.abs(nums[11] ?? 0) < 1e-6;
    if (!flat) {
      return {
        rotationDeg: 0,
        scaleX: 1,
        scaleY: 1,
        skewXDeg: 0,
        translate: { x: nums[12] ?? 0, y: nums[13] ?? 0 },
        is3d: true,
        hasSkew: false,
      };
    }
    return decompose2d([
      nums[0] ?? 1,
      nums[1] ?? 0,
      nums[4] ?? 0,
      nums[5] ?? 1,
      nums[12] ?? 0,
      nums[13] ?? 0,
    ]);
  }

  if (nums.length === 6) return decompose2d(nums);
  return null;
}

function decompose2d(n: number[]): DecomposedTransform {
  const a = n[0] ?? 1;
  const b = n[1] ?? 0;
  const c = n[2] ?? 0;
  const d = n[3] ?? 1;
  const e = n[4] ?? 0;
  const f = n[5] ?? 0;

  const scaleX = Math.hypot(a, b);
  const shear = scaleX === 0 ? 0 : (a * c + b * d) / (scaleX * scaleX);
  const scaleY = Math.hypot(c - a * shear, d - b * shear);
  const rotationRad = Math.atan2(b, a);

  return {
    rotationDeg: (rotationRad * 180) / Math.PI,
    scaleX,
    scaleY,
    skewXDeg: (Math.atan(shear) * 180) / Math.PI,
    translate: { x: e, y: f },
    is3d: false,
    hasSkew: Math.abs(shear) > 1e-4,
  };
}

/**
 * Figma rotates counter-clockwise; CSS clockwise. Negate (PRD section 10).
 * Returns undefined for a rotation small enough to be noise.
 */
export function toFigmaRotation(cssDegrees: number): number | undefined {
  const r = -cssDegrees;
  return Math.abs(r) < 0.01 ? undefined : Number(r.toFixed(3));
}

const BLEND: Record<string, BlendMode> = {
  normal: 'NORMAL',
  multiply: 'MULTIPLY',
  screen: 'SCREEN',
  overlay: 'OVERLAY',
  darken: 'DARKEN',
  lighten: 'LIGHTEN',
  'color-dodge': 'COLOR_DODGE',
  'color-burn': 'COLOR_BURN',
  'hard-light': 'HARD_LIGHT',
  'soft-light': 'SOFT_LIGHT',
  difference: 'DIFFERENCE',
  exclusion: 'EXCLUSION',
  hue: 'HUE',
  saturation: 'SATURATION',
  color: 'COLOR',
  luminosity: 'LUMINOSITY',
};

export function blendMode(value: string | null): {
  mode: BlendMode;
  supported: boolean;
} {
  const t = (value ?? 'normal').trim().toLowerCase();
  const mapped = BLEND[t];
  if (mapped) return { mode: mapped, supported: true };
  return { mode: 'NORMAL', supported: t === 'normal' || t === 'plus-lighter' ? false : false };
}

export function clipsContent(overflow: string | null): boolean {
  const t = (overflow ?? 'visible').toLowerCase();
  return t.includes('hidden') || t.includes('clip') || t.includes('auto') || t.includes('scroll');
}

/** Properties that force a subtree rasterisation (PRD section 5 and 10). */
export function rasteriseReason(styles: {
  transform: string | null;
  clipPath: string | null;
  maskImage: string | null;
  writingMode: string | null;
  filter: string | null;
}): string | null {
  const t = decomposeTransform(styles.transform);
  if (t?.is3d) return 'transform-3d';
  if (t?.hasSkew) return 'transform-skew';
  const clip = (styles.clipPath ?? 'none').toLowerCase();
  if (clip !== 'none' && clip !== '') return 'clip-path';
  const mask = (styles.maskImage ?? 'none').toLowerCase();
  if (mask !== 'none' && mask !== '') return 'mask-image';
  const wm = (styles.writingMode ?? 'horizontal-tb').toLowerCase();
  if (wm.startsWith('vertical')) return 'writing-mode';
  return null;
}
