import type { FontRequest, IRDocument } from '@web2figma/ir';
import { isText, walk } from '@web2figma/ir';
import { fontKey } from '@web2figma/transform';

/**
 * Font resolution ladder (PRD section 8).
 *
 * Every substitution is recorded so the conversion report can list it: a
 * designer who sees "Inter stood in for SF Pro" trusts the output; one who
 * discovers it later does not.
 */

export interface AvailableFont {
  family: string;
  style: string;
}

/** Curated table for the web fonts that turn up on most sites. */
export const SUBSTITUTIONS: Record<string, string> = {
  'helvetica neue': 'Inter',
  helvetica: 'Inter',
  arial: 'Inter',
  'sf pro': 'Inter',
  'sf pro text': 'Inter',
  'sf pro display': 'Inter',
  '-apple-system': 'Inter',
  'system-ui': 'Inter',
  'segoe ui': 'Inter',
  roboto: 'Roboto',
  'ibm plex sans': 'Inter',
  georgia: 'Source Serif Pro',
  'times new roman': 'Source Serif Pro',
  times: 'Source Serif Pro',
  garamond: 'Source Serif Pro',
  menlo: 'Roboto Mono',
  monaco: 'Roboto Mono',
  consolas: 'Roboto Mono',
  'courier new': 'Roboto Mono',
  'sf mono': 'Roboto Mono',
};

const CLASS_FALLBACK: Record<string, string> = {
  'sans-serif': 'Inter',
  serif: 'Source Serif Pro',
  monospace: 'Roboto Mono',
  display: 'Inter',
  handwriting: 'Inter',
};

const WEIGHT_STYLES: { weight: number; names: string[] }[] = [
  { weight: 100, names: ['Thin', 'Hairline'] },
  { weight: 200, names: ['ExtraLight', 'Extra Light', 'UltraLight'] },
  { weight: 300, names: ['Light'] },
  { weight: 400, names: ['Regular', 'Normal', 'Book'] },
  { weight: 500, names: ['Medium'] },
  { weight: 600, names: ['SemiBold', 'Semi Bold', 'DemiBold'] },
  { weight: 700, names: ['Bold'] },
  { weight: 800, names: ['ExtraBold', 'Extra Bold', 'UltraBold'] },
  { weight: 900, names: ['Black', 'Heavy'] },
];

export function collectFonts(doc: IRDocument): FontRequest[] {
  const seen = new Map<string, FontRequest>();
  for (const f of doc.fonts) seen.set(fontKey(f), f);
  for (const node of walk(doc.root)) {
    if (!isText(node)) continue;
    for (const seg of node.segments) {
      const key = fontKey(seg.font);
      if (!seen.has(key)) seen.set(key, seg.font);
    }
  }
  return [...seen.values()];
}

function stylesFor(available: AvailableFont[], family: string): string[] {
  const lower = family.toLowerCase();
  return available.filter((f) => f.family.toLowerCase() === lower).map((f) => f.style);
}

/** Nearest available style for a CSS weight plus italic flag. */
export function pickStyle(styles: readonly string[], weight: number, italic: boolean): string | null {
  if (styles.length === 0) return null;
  const wantItalic = (s: string): boolean => /italic|oblique/i.test(s);
  const pool = styles.filter((s) => wantItalic(s) === italic);
  const candidates = pool.length > 0 ? pool : styles;

  const score = (style: string): number => {
    const base = style.replace(/\s*(italic|oblique)\s*/i, '').trim() || 'Regular';
    const entry = WEIGHT_STYLES.find((w) =>
      w.names.some((n) => n.toLowerCase() === base.toLowerCase()),
    );
    const styleWeight = entry?.weight ?? 400;
    return Math.abs(styleWeight - weight);
  };

  return [...candidates].sort((a, b) => score(a) - score(b) || a.length - b.length)[0] ?? null;
}

export interface Resolution {
  resolved: { family: string; style: string };
  substituted: boolean;
  via: 'exact' | 'weight' | 'fallback-stack' | 'table' | 'classification' | 'last-resort';
}

/**
 * The ladder from PRD section 8, in order:
 * exact -> nearest weight -> CSS fallback stack -> substitution table ->
 * classification -> Inter Regular.
 */
export function resolveFont(
  request: FontRequest,
  available: AvailableFont[],
): Resolution {
  const tryFamily = (family: string): { family: string; style: string } | null => {
    const styles = stylesFor(available, family);
    const style = pickStyle(styles, request.weight, request.italic);
    return style ? { family, style } : null;
  };

  const exactStyles = stylesFor(available, request.family);
  if (exactStyles.length > 0) {
    const wanted = request.italic ? 'Italic' : 'Regular';
    if (request.weight === 400 && exactStyles.includes(wanted)) {
      return { resolved: { family: request.family, style: wanted }, substituted: false, via: 'exact' };
    }
    if (request.weight === 700 && exactStyles.includes(request.italic ? 'Bold Italic' : 'Bold')) {
      return {
        resolved: { family: request.family, style: request.italic ? 'Bold Italic' : 'Bold' },
        substituted: false,
        via: 'exact',
      };
    }
    const nearest = pickStyle(exactStyles, request.weight, request.italic);
    if (nearest) {
      return { resolved: { family: request.family, style: nearest }, substituted: false, via: 'weight' };
    }
  }

  for (const fallback of request.fallbackStack) {
    const hit = tryFamily(fallback);
    if (hit) return { resolved: hit, substituted: true, via: 'fallback-stack' };
  }

  const tableTarget =
    SUBSTITUTIONS[request.family.toLowerCase()] ??
    request.fallbackStack.map((f) => SUBSTITUTIONS[f.toLowerCase()]).find(Boolean);
  if (tableTarget) {
    const hit = tryFamily(tableTarget);
    if (hit) return { resolved: hit, substituted: true, via: 'table' };
  }

  const classTarget = CLASS_FALLBACK[request.classification] ?? 'Inter';
  const classHit = tryFamily(classTarget);
  if (classHit) return { resolved: classHit, substituted: true, via: 'classification' };

  const inter = tryFamily('Inter');
  if (inter) return { resolved: inter, substituted: true, via: 'last-resort' };

  return {
    resolved: { family: 'Inter', style: 'Regular' },
    substituted: true,
    via: 'last-resort',
  };
}
