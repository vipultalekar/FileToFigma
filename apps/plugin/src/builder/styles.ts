import type { IRDocument, Paint, RGB, TextNode as IRText } from '@web2figma/ir';
import { isFrame, isImage, isText, walk } from '@web2figma/ir';

/**
 * Figma style creation (colour and text), the thing that turns an import into
 * something a design system can absorb.
 *
 * Only values that actually repeat become styles. A style per one-off colour
 * gives a designer 200 entries to delete, which is worse than none: the
 * threshold is what keeps the output usable.
 */

export interface StyleOptions {
  /** How many uses a value needs before it earns a style. */
  minUses?: number;
  /** Prefix for every created style, so they group together in the picker. */
  prefix?: string;
}

export interface StyleReport {
  colors: { name: string; uses: number }[];
  texts: { name: string; uses: number }[];
}

/** Where a colour was seen, and whether binding a style there is safe. */
interface ColorTarget {
  nodeId: string;
  kind: 'fill' | 'stroke';
  /**
   * False when the node paints more than one thing. Binding a style replaces
   * the whole paints array, so a style built from one solid would wipe out the
   * gradient or image stacked with it.
   */
  bindable: boolean;
}

interface ColorUse {
  paint: Paint & { type: 'SOLID' };
  targets: ColorTarget[];
}

interface TextUse {
  family: string;
  style: string;
  size: number;
  lineHeight: IRText['style']['lineHeight'];
  letterSpacing: IRText['style']['letterSpacing'];
  nodes: string[];
}

const DEFAULT_MIN_USES = 3;

function hex(color: RGB): string {
  const c = (n: number): string =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `${c(color.r)}${c(color.g)}${c(color.b)}`;
}

/**
 * Colour names people can scan: hue family plus lightness, with the hex kept as
 * the disambiguator. "Blue 600 / 2563EB" beats "Style 14".
 */
export function nameColor(color: RGB, opacity: number): string {
  const { r, g, b } = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;

  let family: string;
  if (delta < 0.04) {
    family = lightness > 0.96 ? 'White' : lightness < 0.06 ? 'Black' : 'Grey';
  } else {
    let hue = 0;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
    family =
      hue < 15 || hue >= 345
        ? 'Red'
        : hue < 45
          ? 'Orange'
          : hue < 70
            ? 'Yellow'
            : hue < 160
              ? 'Green'
              : hue < 200
                ? 'Teal'
                : hue < 260
                  ? 'Blue'
                  : hue < 290
                    ? 'Indigo'
                    : hue < 345
                      ? 'Purple'
                      : 'Pink';
  }

  // A 50-950 tone step, fitted so the familiar ramps land where designers
  // expect them: #2563EB reads as 600, not 400.
  const raw = 500 + (0.6 - lightness) * (200 / 0.12);
  const step = Math.min(950, Math.max(50, Math.round(raw / 100) * 100 || 50));
  const tone = family === 'White' || family === 'Black' ? '' : ` ${step}`;
  const alpha = opacity < 0.999 ? ` ${Math.round(opacity * 100)}%` : '';
  return `${family}${tone} / ${hex(color)}${alpha}`;
}

export function nameTextStyle(use: TextUse): string {
  const line =
    use.lineHeight.unit === 'AUTO'
      ? 'auto'
      : `${Math.round(use.lineHeight.value ?? 0)}${use.lineHeight.unit === 'PERCENT' ? '%' : ''}`;
  return `${use.family} ${use.style} / ${Math.round(use.size)}·${line}`;
}

function colorKey(paint: Paint & { type: 'SOLID' }): string {
  return `${hex(paint.color)}-${paint.opacity.toFixed(2)}`;
}

function textKey(node: IRText): string | null {
  const segment = node.segments[0];
  if (!segment?.font.resolved) return null;
  const lh = node.style.lineHeight;
  return [
    segment.font.resolved.family,
    segment.font.resolved.style,
    Math.round(segment.size),
    lh.unit,
    Math.round(lh.value ?? 0),
    node.style.letterSpacing.unit,
    node.style.letterSpacing.value.toFixed(2),
  ].join('|');
}

/** Gather every repeated solid colour and text style in the document. */
export function collectStyleCandidates(
  doc: IRDocument,
  options: StyleOptions = {},
): { colors: Map<string, ColorUse>; texts: Map<string, TextUse> } {
  const colors = new Map<string, ColorUse>();
  const texts = new Map<string, TextUse>();

  const noteColor = (
    paint: Paint,
    nodeId: string,
    kind: 'fill' | 'stroke',
    bindable: boolean,
  ): void => {
    if (paint.type !== 'SOLID') return;
    if (paint.opacity <= 0.01) return;
    const key = colorKey(paint);
    const target: ColorTarget = { nodeId, kind, bindable };
    const entry = colors.get(key);
    if (entry) entry.targets.push(target);
    else colors.set(key, { paint, targets: [target] });
  };

  for (const node of walk(doc.root)) {
    if (isFrame(node)) {
      for (const fill of node.fills) noteColor(fill, node.id, 'fill', node.fills.length === 1);
      for (const stroke of node.strokes) {
        noteColor(stroke.paint, node.id, 'stroke', node.strokes.length === 1);
      }
    } else if (isImage(node)) {
      // An image node's fill is the image; only its stroke is a candidate.
      for (const stroke of node.strokes) {
        noteColor(stroke.paint, node.id, 'stroke', node.strokes.length === 1);
      }
    } else if (isText(node)) {
      const segment = node.segments[0];
      // Ranged formatting means there is no single fill to bind.
      const single = node.segments.length === 1;
      if (segment) noteColor(segment.color, node.id, 'fill', single);
      const key = single ? textKey(node) : null;
      if (key && segment?.font.resolved) {
        const entry = texts.get(key);
        if (entry) entry.nodes.push(node.id);
        else
          texts.set(key, {
            family: segment.font.resolved.family,
            style: segment.font.resolved.style,
            size: segment.size,
            lineHeight: node.style.lineHeight,
            letterSpacing: node.style.letterSpacing,
            nodes: [node.id],
          });
      }
    }
  }

  const min = options.minUses ?? DEFAULT_MIN_USES;
  for (const [key, use] of colors) if (use.targets.length < min) colors.delete(key);
  for (const [key, use] of texts) if (use.nodes.length < min) texts.delete(key);
  return { colors, texts };
}

/**
 * Create the styles in the file and apply them to the built nodes.
 * `byIrId` maps IR node ids to the Figma nodes the builder produced.
 */
export async function applyStyles(
  doc: IRDocument,
  byIrId: Map<string, SceneNode>,
  options: StyleOptions = {},
): Promise<StyleReport> {
  const prefix = options.prefix ?? 'Web';
  const { colors, texts } = collectStyleCandidates(doc, options);
  const report: StyleReport = { colors: [], texts: [] };

  for (const use of colors.values()) {
    const name = `${prefix}/Colour/${nameColor(use.paint.color, use.paint.opacity)}`;
    const style = figma.createPaintStyle();
    style.name = name;
    style.paints = [{ type: 'SOLID', color: use.paint.color, opacity: use.paint.opacity }];

    let applied = 0;
    for (const target of use.targets) {
      // The style is still worth creating for an unbindable use: it belongs in
      // the file even where attaching it would destroy the other paints.
      if (!target.bindable) continue;
      const node = byIrId.get(target.nodeId);
      if (!node) continue;
      try {
        if (target.kind === 'stroke') {
          if ('strokeStyleId' in node) {
            await (node as SceneNode & MinimalStrokesMixin).setStrokeStyleIdAsync(style.id);
            applied++;
          }
          continue;
        }
        if ('fillStyleId' in node) {
          await (node as SceneNode & MinimalFillsMixin).setFillStyleIdAsync(style.id);
          applied++;
        }
      } catch {
        // A node that refuses the style keeps the paints it already has.
      }
    }
    report.colors.push({ name, uses: applied });
  }

  for (const use of texts.values()) {
    const name = `${prefix}/Text/${nameTextStyle(use)}`;
    const style = figma.createTextStyle();
    style.name = name;
    style.fontName = { family: use.family, style: use.style };
    style.fontSize = Math.round(use.size);
    style.lineHeight =
      use.lineHeight.unit === 'AUTO'
        ? { unit: 'AUTO' }
        : { unit: use.lineHeight.unit, value: use.lineHeight.value ?? 0 };
    style.letterSpacing =
      use.letterSpacing.unit === 'PERCENT'
        ? { unit: 'PERCENT', value: use.letterSpacing.value }
        : { unit: 'PIXELS', value: use.letterSpacing.value };

    let applied = 0;
    for (const nodeId of use.nodes) {
      const node = byIrId.get(nodeId);
      if (!node || node.type !== 'TEXT') continue;
      try {
        await (node as TextNode).setTextStyleIdAsync(style.id);
        applied++;
      } catch {
        // Mixed-style text refuses a paragraph style; that is expected.
      }
    }
    report.texts.push({ name, uses: applied });
  }

  return report;
}
