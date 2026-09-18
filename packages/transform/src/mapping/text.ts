import type { FontClassification, FontRequest, TextStyle } from '@web2figma/ir';

/**
 * Typography mapping (PRD section 10). Font *resolution* against the installed
 * Figma font list happens in the builder; this file only turns CSS into the
 * FontRequest and TextStyle shapes the builder consumes.
 */

const GENERIC: Record<string, FontClassification> = {
  serif: 'serif',
  'sans-serif': 'sans-serif',
  monospace: 'monospace',
  cursive: 'handwriting',
  fantasy: 'display',
  'system-ui': 'sans-serif',
  'ui-sans-serif': 'sans-serif',
  'ui-serif': 'serif',
  'ui-monospace': 'monospace',
  'ui-rounded': 'sans-serif',
  '-apple-system': 'sans-serif',
  blinkmacsystemfont: 'sans-serif',
};

const KNOWN_SERIF = /(times|georgia|garamond|baskerville|palatino|cambria|merriweather|playfair|source serif|noto serif|pt serif|lora|charter)/i;
const KNOWN_MONO = /(mono|consolas|menlo|courier|source code|fira code|jetbrains|ibm plex mono)/i;
const KNOWN_HAND = /(script|handwriting|comic|caveat|pacifico|dancing)/i;

export function splitFontStack(family: string | null): string[] {
  if (!family) return [];
  return family
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter((f) => f.length > 0);
}

export function classifyFamily(family: string, stack: string[]): FontClassification {
  const all = [family, ...stack];
  for (const f of all) {
    const g = GENERIC[f.toLowerCase()];
    if (g) return g;
  }
  if (KNOWN_MONO.test(family)) return 'monospace';
  if (KNOWN_SERIF.test(family)) return 'serif';
  if (KNOWN_HAND.test(family)) return 'handwriting';
  return 'sans-serif';
}

export function normaliseWeight(weight: string | number | null): number {
  if (weight === null || weight === undefined) return 400;
  if (typeof weight === 'number') return clampWeight(weight);
  const t = weight.trim().toLowerCase();
  if (t === 'normal') return 400;
  if (t === 'bold') return 700;
  if (t === 'lighter') return 300;
  if (t === 'bolder') return 700;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? clampWeight(n) : 400;
}

function clampWeight(n: number): number {
  const rounded = Math.round(n / 100) * 100;
  return Math.min(900, Math.max(100, rounded));
}

export function toFontRequest(
  fontFamily: string | null,
  fontWeight: string | number | null,
  fontStyle: string | null,
): FontRequest {
  const stack = splitFontStack(fontFamily);
  const family = stack[0] ?? 'Inter';
  return {
    family,
    weight: normaliseWeight(fontWeight),
    italic: (fontStyle ?? '').toLowerCase().startsWith('italic'),
    fallbackStack: stack.slice(1),
    classification: classifyFamily(family, stack.slice(1)),
  };
}

export function fontKey(f: FontRequest): string {
  return `${f.family.toLowerCase()}|${f.weight}|${f.italic ? 'i' : 'n'}`;
}

export function textAlign(
  value: string | null,
  direction: string | null,
): TextStyle['align'] {
  const rtl = (direction ?? 'ltr').toLowerCase() === 'rtl';
  switch ((value ?? '').toLowerCase()) {
    case 'center':
      return 'CENTER';
    case 'right':
      return 'RIGHT';
    case 'justify':
      return 'JUSTIFIED';
    case 'start':
      return rtl ? 'RIGHT' : 'LEFT';
    case 'end':
      return rtl ? 'LEFT' : 'RIGHT';
    default:
      return 'LEFT';
  }
}

export function lineHeight(value: string | null, fontSize: number): TextStyle['lineHeight'] {
  const t = (value ?? '').trim().toLowerCase();
  if (t === '' || t === 'normal') return { unit: 'AUTO' };
  if (t.endsWith('px')) {
    const n = parseFloat(t);
    return Number.isFinite(n) ? { unit: 'PIXELS', value: n } : { unit: 'AUTO' };
  }
  if (t.endsWith('%')) {
    const n = parseFloat(t);
    return Number.isFinite(n) ? { unit: 'PERCENT', value: n } : { unit: 'AUTO' };
  }
  const n = parseFloat(t);
  // Unitless multiplier.
  if (Number.isFinite(n)) return { unit: 'PIXELS', value: n * fontSize };
  return { unit: 'AUTO' };
}

export function letterSpacing(
  value: string | null,
  fontSize: number,
): TextStyle['letterSpacing'] {
  const t = (value ?? '').trim().toLowerCase();
  if (t === '' || t === 'normal') return { unit: 'PIXELS', value: 0 };
  if (t.endsWith('%')) {
    const n = parseFloat(t);
    return { unit: 'PERCENT', value: Number.isFinite(n) ? n : 0 };
  }
  if (t.endsWith('em')) {
    const n = parseFloat(t);
    return { unit: 'PIXELS', value: Number.isFinite(n) ? n * fontSize : 0 };
  }
  const n = parseFloat(t);
  return { unit: 'PIXELS', value: Number.isFinite(n) ? n : 0 };
}

export function textCase(value: string | null): TextStyle['case'] {
  switch ((value ?? '').toLowerCase()) {
    case 'uppercase':
      return 'UPPER';
    case 'lowercase':
      return 'LOWER';
    case 'capitalize':
      return 'TITLE';
    default:
      return undefined;
  }
}

export function textDecoration(
  value: string | null,
): 'UNDERLINE' | 'STRIKETHROUGH' | undefined {
  const t = (value ?? '').toLowerCase();
  if (t.includes('underline')) return 'UNDERLINE';
  if (t.includes('line-through')) return 'STRIKETHROUGH';
  return undefined;
}

export function verticalAlign(value: string | null): TextStyle['verticalAlign'] {
  switch ((value ?? '').toLowerCase()) {
    case 'middle':
      return 'CENTER';
    case 'bottom':
      return 'BOTTOM';
    default:
      return 'TOP';
  }
}

/**
 * PRD section 8: prefer HEIGHT auto-resize so text reflows when the width
 * changes. Only a clamped or truncated box stays fixed.
 */
export function autoResize(opts: {
  truncate: boolean;
  clamped: boolean;
  inline: boolean;
}): TextStyle['autoResize'] {
  if (opts.truncate || opts.clamped) return 'NONE';
  if (opts.inline) return 'WIDTH_AND_HEIGHT';
  return 'HEIGHT';
}

export function lineClamp(value: string | null): number | undefined {
  const n = parseInt((value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
