import type { RGBA, SolidPaint } from '@web2figma/ir';

/**
 * CSS colour -> RGBA in 0..1 channels.
 *
 * Capture reads getComputedStyle, which resolves almost everything to
 * rgb()/rgba(), but the image pipeline emits hand-written CSS and fixtures use
 * hex and named colours, so all the common forms are handled here.
 */

const NAMED: Record<string, string> = {
  transparent: 'rgba(0,0,0,0)',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
  olive: '#808000',
  lime: '#00ff00',
  aqua: '#00ffff',
  cyan: '#00ffff',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  maroon: '#800000',
  purple: '#800080',
  yellow: '#ffff00',
  orange: '#ffa500',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  gold: '#ffd700',
  indigo: '#4b0082',
  violet: '#ee82ee',
  beige: '#f5f5dc',
  ivory: '#fffff0',
  coral: '#ff7f50',
  crimson: '#dc143c',
  salmon: '#fa8072',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  turquoise: '#40e0d0',
  tan: '#d2b48c',
  plum: '#dda0dd',
  orchid: '#da70d6',
  slategray: '#708090',
  slategrey: '#708090',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  whitesmoke: '#f5f5f5',
  gainsboro: '#dcdcdc',
  dimgray: '#696969',
  dimgrey: '#696969',
};

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };
export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function fromHex(hex: string): RGBA | null {
  const h = hex.slice(1);
  const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
  if (h.length === 3 || h.length === 4) {
    const r = expand(h[0] as string);
    const g = expand(h[1] as string);
    const b = expand(h[2] as string);
    const a = h.length === 4 ? expand(h[3] as string) / 255 : 1;
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }
  if (h.length === 6 || h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r: r / 255, g: g / 255, b: b / 255, a };
  }
  return null;
}

function channel(token: string): number {
  const t = token.trim();
  if (t.endsWith('%')) return clamp01(parseFloat(t) / 100);
  return clamp01(parseFloat(t) / 255);
}

function alphaToken(token: string | undefined): number {
  if (token === undefined) return 1;
  const t = token.trim();
  if (t === 'none') return 1;
  if (t.endsWith('%')) return clamp01(parseFloat(t) / 100);
  return clamp01(parseFloat(t));
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return { r: clamp01(rgb[0] + m), g: clamp01(rgb[1] + m), b: clamp01(rgb[2] + m) };
}

function angleToDegrees(token: string): number {
  const t = token.trim();
  const n = parseFloat(t);
  if (t.endsWith('turn')) return n * 360;
  if (t.endsWith('rad')) return (n * 180) / Math.PI;
  if (t.endsWith('grad')) return n * 0.9;
  return n;
}

/** Split the inside of a functional notation on commas or whitespace, honouring a trailing slash alpha. */
function splitArgs(inner: string): string[] {
  return inner
    .replace(/\//g, ' / ')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '/');
}

/** Parse any CSS colour. Returns null when the value is not a colour at all. */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  if (raw === '' || raw === 'none' || raw === 'currentcolor' || raw === 'inherit') return null;
  if (raw in NAMED) return parseColor(NAMED[raw]);
  if (raw.startsWith('#')) return fromHex(raw);

  const fn = /^([a-z-]+)\((.*)\)$/s.exec(raw);
  if (!fn) return null;
  const name = fn[1] as string;
  const args = splitArgs(fn[2] as string);
  if (args.length < 3) return null;

  if (name === 'rgb' || name === 'rgba') {
    return {
      r: channel(args[0] as string),
      g: channel(args[1] as string),
      b: channel(args[2] as string),
      a: alphaToken(args[3]),
    };
  }
  if (name === 'hsl' || name === 'hsla') {
    const { r, g, b } = hslToRgb(
      angleToDegrees(args[0] as string),
      clamp01(parseFloat(args[1] as string) / 100),
      clamp01(parseFloat(args[2] as string) / 100),
    );
    return { r, g, b, a: alphaToken(args[3]) };
  }
  // color(srgb r g b / a) shows up in Safari-era computed styles.
  if (name === 'color' && args[0] === 'srgb') {
    return {
      r: clamp01(parseFloat(args[1] as string)),
      g: clamp01(parseFloat(args[2] as string)),
      b: clamp01(parseFloat(args[3] as string)),
      a: alphaToken(args[4]),
    };
  }
  return null;
}

export function isTransparent(c: RGBA | null): boolean {
  return c === null || c.a <= 0.001;
}

/** RGBA -> Figma SolidPaint, folding alpha into paint opacity (PRD section 10). */
export function toSolidPaint(c: RGBA): SolidPaint {
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: clamp01(c.a) };
}

export function solidFromCss(input: string | null | undefined): SolidPaint | null {
  const c = parseColor(input);
  if (isTransparent(c)) return null;
  return toSolidPaint(c as RGBA);
}

export function toHex(c: RGBA): string {
  const h = (n: number): string =>
    Math.round(clamp01(n) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export { angleToDegrees, clamp01 };
