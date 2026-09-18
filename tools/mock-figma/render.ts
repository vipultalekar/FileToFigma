import { MockNode, MockTextNode, type MockPaint } from './nodes.js';

/**
 * Render a built mock tree to SVG, for the visual diff harness (PRD section
 * 15). It approximates Figma's renderer: solid and linear gradient fills,
 * strokes, corner radii, shadows and text. That is enough to catch the
 * regressions that matter, and it runs in CI without a Figma session.
 */

export interface RenderOptions {
  width?: number;
  height?: number;
  /** assetId/hash -> data URI, so images show up in the diff. */
  images?: Map<string, string>;
  background?: string;
}

function toCss(paint: MockPaint | undefined): string {
  if (!paint) return 'none';
  if (paint.type === 'SOLID') {
    const c = paint.color as { r: number; g: number; b: number };
    const a = (paint.opacity as number) ?? 1;
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
  }
  return 'none';
}

function gradientDef(paint: MockPaint, id: string): string | null {
  if (typeof paint.type !== 'string' || !paint.type.startsWith('GRADIENT')) return null;
  const stops = (paint.gradientStops as { position: number; color: { r: number; g: number; b: number; a: number } }[]) ?? [];
  const body = stops
    .map(
      (s) =>
        `<stop offset="${(s.position * 100).toFixed(2)}%" stop-color="rgb(${Math.round(s.color.r * 255)},${Math.round(
          s.color.g * 255,
        )},${Math.round(s.color.b * 255)})" stop-opacity="${s.color.a}"/>`,
    )
    .join('');

  if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
    return `<radialGradient id="${id}" cx="50%" cy="50%" r="50%">${body}</radialGradient>`;
  }
  // Recover the gradient direction from the transform's first row.
  const t = paint.gradientTransform as number[][] | undefined;
  const a = t?.[0]?.[0] ?? 1;
  const b = t?.[0]?.[1] ?? 0;
  const len = Math.hypot(a, b) || 1;
  const dx = a / len;
  const dy = b / len;
  const x1 = 50 - dx * 50;
  const y1 = 50 - dy * 50;
  const x2 = 50 + dx * 50;
  const y2 = 50 + dy * 50;
  return `<linearGradient id="${id}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">${body}</linearGradient>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderToSvg(root: MockNode, options: RenderOptions = {}): string {
  const defs: string[] = [];
  let defCount = 0;

  const paintFor = (node: MockNode): string => {
    const fill = node.fills[node.fills.length - 1];
    if (!fill) return 'none';
    if (fill.type === 'IMAGE') {
      const uri = options.images?.get(fill.imageHash as string);
      if (!uri) return 'rgba(220,220,220,1)';
      const id = `img${++defCount}`;
      defs.push(
        `<pattern id="${id}" patternUnits="objectBoundingBox" width="1" height="1"><image href="${uri}" width="${node.width}" height="${node.height}" preserveAspectRatio="xMidYMid slice"/></pattern>`,
      );
      return `url(#${id})`;
    }
    if (typeof fill.type === 'string' && fill.type.startsWith('GRADIENT')) {
      const id = `grad${++defCount}`;
      const def = gradientDef(fill, id);
      if (def) {
        defs.push(def);
        return `url(#${id})`;
      }
    }
    return toCss(fill);
  };

  const body: string[] = [];

  const draw = (node: MockNode, ox: number, oy: number): void => {
    if (!node.visible) return;
    const x = ox + node.x;
    const y = oy + node.y;
    const opacity = node.opacity;

    if (node instanceof MockTextNode) {
      const fill = node.ranges[0]?.fills?.[0] ?? node.fills[0];
      const size = node.ranges[0]?.size ?? node.fontSize;
      const lineHeight =
        node.lineHeight.unit === 'PIXELS' ? (node.lineHeight.value as number) : size * 1.4;
      const anchor =
        node.textAlignHorizontal === 'CENTER'
          ? 'middle'
          : node.textAlignHorizontal === 'RIGHT'
            ? 'end'
            : 'start';
      const tx =
        node.textAlignHorizontal === 'CENTER'
          ? x + node.width / 2
          : node.textAlignHorizontal === 'RIGHT'
            ? x + node.width
            : x;
      body.push(
        `<text x="${tx}" y="${y + size}" font-family="${escapeXml(node.fontName.family)}" font-size="${size}" fill="${toCss(
          fill,
        )}" text-anchor="${anchor}" opacity="${opacity}" style="line-height:${lineHeight}px">${escapeXml(
          node.characters,
        )}</text>`,
      );
      return;
    }

    const radius = Math.max(
      node.topLeftRadius,
      node.topRightRadius,
      node.bottomRightRadius,
      node.bottomLeftRadius,
    );
    const stroke = node.strokes[0] ? toCss(node.strokes[0]) : 'none';
    const shadow = node.effects.find((e) => e.type === 'DROP_SHADOW') as
      | { color: { r: number; g: number; b: number; a: number }; offset: { x: number; y: number }; radius: number }
      | undefined;
    if (shadow) {
      const id = `sh${++defCount}`;
      defs.push(
        `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${shadow.offset.x}" dy="${shadow.offset.y}" stdDeviation="${shadow.radius / 2}" flood-color="rgba(${Math.round(
          shadow.color.r * 255,
        )},${Math.round(shadow.color.g * 255)},${Math.round(shadow.color.b * 255)},${shadow.color.a})"/></filter>`,
      );
      body.push(
        `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="${radius}" fill="${paintFor(node)}" stroke="${stroke}" stroke-width="${node.strokeWeight}" opacity="${opacity}" filter="url(#${id})"/>`,
      );
    } else {
      body.push(
        `<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="${radius}" fill="${paintFor(node)}" stroke="${stroke}" stroke-width="${node.strokeWeight}" opacity="${opacity}"/>`,
      );
    }

    for (const child of node.children) draw(child, x, y);
  };

  draw(root, -root.x, -root.y);

  const width = options.width ?? root.width;
  const height = options.height ?? root.height;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${options.background ?? '#ffffff'}"/>`,
    defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '',
    body.join(''),
    '</svg>',
  ].join('');
}
