import type { GradientPaint, GradientType, RGBA } from '@web2figma/ir';
import { angleToDegrees, clamp01, parseColor } from './color.js';

/**
 * CSS gradients -> Figma GradientPaint (PRD section 10).
 *
 * Figma's gradientTransform M maps normalised object coordinates p = (x, y, 1)
 * into gradient space, where the gradient parameter is the x component of M*p.
 * So the job is to produce M with
 *
 *   t(x, y) = (M[0] . p)   and   t = 0 at the gradient start, 1 at the end.
 *
 * The derivation below yields exactly the identity matrix for
 * `linear-gradient(to right, ...)`, which is Figma's documented default, and
 * that is the check the unit tests pin.
 */

export interface ColorStop {
  position: number;
  color: RGBA;
}

interface ParsedGradient {
  type: GradientType;
  /** CSS degrees, 0 = up, clockwise. Linear only. */
  angle: number;
  stops: ColorStop[];
  /** Normalised 0..1, radial and conic only. */
  center: { x: number; y: number };
  /** Normalised 0..1 radii, radial only. */
  radius: { x: number; y: number };
  repeating: boolean;
}

const KEYWORD_ANGLE: Record<string, number> = {
  'to top': 0,
  'to right': 90,
  'to bottom': 180,
  'to left': 270,
  'to top right': 45,
  'to right top': 45,
  'to bottom right': 135,
  'to right bottom': 135,
  'to bottom left': 225,
  'to left bottom': 225,
  'to top left': 315,
  'to left top': 315,
};

/** Split on top-level commas, ignoring commas inside nested parentheses. */
export function splitTopLevel(input: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

function lengthToFraction(token: string, extent: number): number | null {
  const t = token.trim();
  if (t.endsWith('%')) return parseFloat(t) / 100;
  if (t.endsWith('px')) return extent > 0 ? parseFloat(t) / extent : 0;
  if (/^-?[\d.]+$/.test(t)) return extent > 0 ? parseFloat(t) / extent : 0;
  return null;
}

/**
 * Parse the stop list, filling implicit positions by even distribution between
 * the nearest explicit neighbours, which is what the CSS spec does.
 */
function parseStops(tokens: string[], extent: number): ColorStop[] {
  const raw: { color: RGBA; position: number | null }[] = [];
  for (const token of tokens) {
    // `red 10% 40%` is shorthand for two stops with the same colour.
    const parts = token.trim().split(/\s+(?![^(]*\))/);
    const colorText = parts[0] ?? '';
    const color = parseColor(colorText);
    if (!color) continue;
    const positions = parts.slice(1);
    if (positions.length === 0) {
      raw.push({ color, position: null });
    } else {
      for (const p of positions) {
        raw.push({ color, position: lengthToFraction(p, extent) });
      }
    }
  }
  if (raw.length === 0) return [];
  if (raw[0]!.position === null) raw[0]!.position = 0;
  if (raw[raw.length - 1]!.position === null) raw[raw.length - 1]!.position = 1;

  for (let i = 0; i < raw.length; i++) {
    if (raw[i]!.position !== null) continue;
    let j = i;
    while (j < raw.length && raw[j]!.position === null) j++;
    const before = raw[i - 1]!.position as number;
    const after = raw[j]!.position as number;
    const span = j - (i - 1);
    for (let k = i; k < j; k++) {
      raw[k]!.position = before + ((after - before) * (k - (i - 1))) / span;
    }
    i = j - 1;
  }

  // Positions must be non-decreasing; CSS clamps each to the running maximum.
  let max = 0;
  return raw.map((s) => {
    const p = clamp01(s.position as number);
    max = Math.max(max, p);
    return { position: max, color: s.color };
  });
}

export function parseGradient(
  css: string,
  width: number,
  height: number,
): ParsedGradient | null {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/is.exec(css.trim());
  if (!m) return null;
  const repeating = Boolean(m[1]);
  const kind = (m[2] as string).toLowerCase();
  const args = splitTopLevel(m[3] as string);
  if (args.length === 0) return null;

  let angle = 180; // CSS default: to bottom.
  let center = { x: 0.5, y: 0.5 };
  let radius = { x: 0.5, y: 0.5 };
  let stopTokens = args;

  const head = (args[0] as string).trim().toLowerCase();

  if (kind === 'linear') {
    if (head in KEYWORD_ANGLE) {
      angle = KEYWORD_ANGLE[head] as number;
      stopTokens = args.slice(1);
    } else if (/(deg|rad|grad|turn)$/.test(head)) {
      angle = angleToDegrees(head);
      stopTokens = args.slice(1);
    }
  } else if (kind === 'radial') {
    if (!parseColor(head.split(/\s+/)[0] ?? '')) {
      stopTokens = args.slice(1);
      const at = /at\s+(.+)$/.exec(head);
      if (at) {
        const pos = (at[1] as string).split(/\s+/);
        center = {
          x: keywordPosition(pos[0] ?? '50%', width, 'x'),
          y: keywordPosition(pos[1] ?? '50%', height, 'y'),
        };
      }
      const size = head.replace(/at\s+.+$/, '').trim();
      const lengths = size.split(/\s+/).filter((t) => /[\d.]/.test(t));
      if (lengths.length >= 1) {
        const rx = lengthToFraction(lengths[0] as string, width);
        const ry = lengthToFraction(lengths[1] ?? (lengths[0] as string), height);
        if (rx !== null) radius = { x: rx, y: ry ?? rx };
      } else {
        radius = radialExtent(size, center, width, height);
      }
    }
  } else if (kind === 'conic') {
    if (/^(from|at)\b/.test(head)) {
      stopTokens = args.slice(1);
      const from = /from\s+([^\s]+)/.exec(head);
      if (from) angle = angleToDegrees(from[1] as string);
      const at = /at\s+(.+)$/.exec(head);
      if (at) {
        const pos = (at[1] as string).split(/\s+/);
        center = {
          x: keywordPosition(pos[0] ?? '50%', width, 'x'),
          y: keywordPosition(pos[1] ?? '50%', height, 'y'),
        };
      }
    }
  }

  const extent = kind === 'linear' ? gradientLineLength(angle, width, height) : Math.max(width, height);
  const stops = parseStops(stopTokens, extent);
  if (stops.length < 2) {
    if (stops.length === 1) stops.push({ ...stops[0]!, position: 1 });
    else return null;
  }

  const type: GradientType =
    kind === 'linear'
      ? 'GRADIENT_LINEAR'
      : kind === 'radial'
        ? 'GRADIENT_RADIAL'
        : 'GRADIENT_ANGULAR';

  return { type, angle, stops, center, radius, repeating };
}

/**
 * CSS radial extents, normalised to fractions of the box. The default is
 * farthest-corner, and a `circle` keeps one pixel radius on both axes, which is
 * why the result is not simply 0.5 on each side.
 */
export function radialExtent(
  size: string,
  center: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  const w = width || 1;
  const h = height || 1;
  const cx = center.x * w;
  const cy = center.y * h;
  const dxNear = Math.min(cx, w - cx);
  const dxFar = Math.max(cx, w - cx);
  const dyNear = Math.min(cy, h - cy);
  const dyFar = Math.max(cy, h - cy);
  const circle = /\bcircle\b/.test(size);

  let rx: number;
  let ry: number;
  if (/closest-side/.test(size)) {
    rx = dxNear;
    ry = dyNear;
    if (circle) rx = ry = Math.min(dxNear, dyNear);
  } else if (/farthest-side/.test(size)) {
    rx = dxFar;
    ry = dyFar;
    if (circle) rx = ry = Math.max(dxFar, dyFar);
  } else if (/closest-corner/.test(size)) {
    const d = Math.hypot(dxNear, dyNear);
    if (circle) {
      rx = ry = d;
    } else {
      const ratio = dyNear === 0 ? 1 : dxNear / dyNear;
      ry = d / Math.SQRT2;
      rx = ry * ratio;
    }
  } else {
    // farthest-corner, the CSS default.
    const d = Math.hypot(dxFar, dyFar);
    if (circle) {
      rx = ry = d;
    } else {
      const ratio = dyFar === 0 ? 1 : dxFar / dyFar;
      ry = d / Math.SQRT2;
      rx = ry * ratio;
    }
  }
  return { x: rx / w, y: ry / h };
}

function keywordPosition(token: string, extent: number, axis: 'x' | 'y'): number {
  const t = token.trim().toLowerCase();
  if (t === 'center') return 0.5;
  if (axis === 'x' && t === 'left') return 0;
  if (axis === 'x' && t === 'right') return 1;
  if (axis === 'y' && t === 'top') return 0;
  if (axis === 'y' && t === 'bottom') return 1;
  return lengthToFraction(t, extent) ?? 0.5;
}

export function gradientLineLength(angleDeg: number, w: number, h: number): number {
  const rad = (angleDeg * Math.PI) / 180;
  return Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
}

/**
 * Linear gradient transform. CSS 0deg points up and increases clockwise, so the
 * direction in screen coordinates (y down) is (sin a, -cos a).
 */
export function linearGradientTransform(
  angleDeg: number,
  w: number,
  h: number,
): [[number, number, number], [number, number, number]] {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const width = w || 1;
  const height = h || 1;

  const row = (
    ux: number,
    uy: number,
  ): [number, number, number] => {
    const len = Math.abs(width * ux) + Math.abs(height * uy) || 1;
    return [
      (width * ux) / len,
      (height * uy) / len,
      0.5 - ((width / 2) * ux + (height / 2) * uy) / len,
    ];
  };

  // Second row is the perpendicular axis; it controls the gradient's width
  // handle and keeps the matrix non-degenerate.
  return [row(dx, dy), row(-dy, dx)];
}

/** Radial/angular transform: unit circle at `center` with `radius`, normalised. */
export function radialGradientTransform(
  center: { x: number; y: number },
  radius: { x: number; y: number },
): [[number, number, number], [number, number, number]] {
  const rx = radius.x || 0.5;
  const ry = radius.y || 0.5;
  const sx = 1 / (2 * rx);
  const sy = 1 / (2 * ry);
  return [
    [sx, 0, 0.5 - center.x * sx],
    [0, sy, 0.5 - center.y * sy],
  ];
}

/** Full CSS gradient -> Figma paint. Returns null when the value is not a gradient. */
export function gradientToPaint(
  css: string,
  width: number,
  height: number,
): GradientPaint | null {
  const g = parseGradient(css, width, height);
  if (!g) return null;
  const transform =
    g.type === 'GRADIENT_LINEAR'
      ? linearGradientTransform(g.angle, width, height)
      : radialGradientTransform(g.center, g.radius);
  return {
    type: g.type,
    stops: g.stops.map((s) => ({ position: s.position, color: s.color })),
    transform,
  };
}

export function isGradient(css: string): boolean {
  return /(^|\s)(repeating-)?(linear|radial|conic)-gradient\(/i.test(css);
}
