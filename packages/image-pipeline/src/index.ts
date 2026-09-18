import type { Warning } from '@web2figma/ir';
import { detectIcons, type IconRegion } from './icons.js';
import { runOcr, type OcrEngine, type OcrLine } from './ocr.js';
import { kMeansPalette, type PaletteEntry, type RgbaImage } from './palette.js';
import { SYSTEM_PROMPT, buildCorrectionPrompt, buildPrompt, stripFence } from './prompt.js';
import { diffImages, shouldIterate } from './verify.js';

export * from './ocr.js';
export * from './palette.js';
export * from './icons.js';
export * from './prompt.js';
export * from './verify.js';

/**
 * Image -> self-contained HTML (PRD section 9).
 *
 * The design decision that makes this tractable: do not go image -> IR. Go
 * image -> HTML -> the existing capture pipeline, so every gain in layout
 * inference, font handling and Auto Layout applies to screenshots for free.
 *
 * The OCR engine, the vision model and the decoder are all injected, which
 * keeps this package pure, testable and free of an API key.
 */

export type VisionModel = (request: {
  system: string;
  prompt: string;
  image: string;
  /** Present on a correction turn. */
  renderedImage?: string;
}) => Promise<string>;

export type ImageDecoder = (dataUrl: string) => Promise<RgbaImage>;

export interface ImageToHtmlOptions {
  width?: number;
  iterations?: number;
  ocr?: OcrEngine;
  model?: VisionModel;
  decode?: ImageDecoder;
  /** Renders HTML and returns PNG bytes; used by the verification loop. */
  renderHtml?: (html: string, width: number) => Promise<Uint8Array>;
}

export interface SynthesisResult {
  html: string;
  width: number;
  height: number;
  lines: OcrLine[];
  palette: PaletteEntry[];
  icons: IconRegion[];
  /** Diff ratio of the final iteration, when verification ran. */
  diffRatio?: number;
  iterations: number;
  warnings: Warning[];
}

/**
 * Fallback synthesis when no vision model is configured: OCR text and palette
 * are still real, so the output is a usable, honestly-labelled skeleton rather
 * than nothing.
 */
export function synthesiseFromOcr(
  lines: OcrLine[],
  palette: PaletteEntry[],
  width: number,
  height: number,
): string {
  const background = palette[0]?.hex ?? '#ffffff';
  const ink = palette.find((p) => p.hex !== background)?.hex ?? '#111111';
  const blocks = lines
    .map(
      (l) =>
        `<div data-role="text" style="position:absolute;left:${Math.round(l.x)}px;top:${Math.round(
          l.y,
        )}px;width:${Math.round(l.w)}px;font-size:${l.estimatedFontSize}px;color:${ink};white-space:nowrap">${escapeHtml(
          l.text,
        )}</div>`,
    )
    .join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
body{margin:0;width:${width}px;min-height:${height}px;background:${background};font-family:Inter,system-ui,sans-serif;position:relative}
</style></head>
<body>
${blocks}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal PNG/JPEG size reader, so the pipeline works without a decoder. */
export function readImageSize(dataUrl: string): { width: number; height: number } | null {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const bytes = base64ToBytes(dataUrl.slice(comma + 1));
  // PNG: IHDR width/height are big-endian at offsets 16 and 20.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const read = (o: number): number =>
      ((bytes[o] ?? 0) << 24) | ((bytes[o + 1] ?? 0) << 16) | ((bytes[o + 2] ?? 0) << 8) | (bytes[o + 3] ?? 0);
    return { width: read(16), height: read(20) };
  }
  // JPEG: walk the segment markers to the first SOF.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length - 8) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
          width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
        };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function base64ToBytes(b64: string): Uint8Array {
  const g = globalThis as unknown as { Buffer?: { from(s: string, e: string): Uint8Array } };
  if (g.Buffer) return new Uint8Array(g.Buffer.from(b64, 'base64'));
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function imageToHtml(
  image: string,
  options: ImageToHtmlOptions = {},
): Promise<SynthesisResult> {
  const warnings: Warning[] = [];
  const warn = (severity: Warning['severity'], property: string, message: string): void => {
    warnings.push({ nodeId: '', severity, property, message });
  };

  const size = readImageSize(image) ?? { width: options.width ?? 1440, height: 900 };
  const width = options.width ?? size.width;
  if (width < 1000) {
    warn('info', 'image', `source is ${width}px wide; quality degrades below 1000px`);
  }

  let decoded: RgbaImage | null = null;
  if (options.decode) {
    try {
      decoded = await options.decode(image);
    } catch (err) {
      warn('degraded', 'decode', `could not decode the image: ${String(err)}`);
    }
  }

  const lines = options.ocr ? await runOcr(image, options.ocr) : [];
  if (!options.ocr) {
    warn('degraded', 'ocr', 'no OCR engine configured; text was not recovered');
  }

  const palette = decoded ? kMeansPalette(decoded) : [];
  if (!decoded) warn('degraded', 'palette', 'no decoder configured; palette not extracted');

  const icons = decoded ? detectIcons(decoded, lines) : [];

  if (!options.model) {
    warn(
      'degraded',
      'vision-model',
      'no vision model configured; emitted an OCR-only skeleton instead of a layout',
    );
    return {
      html: synthesiseFromOcr(lines, palette, width, size.height),
      width,
      height: size.height,
      lines,
      palette,
      icons,
      iterations: 0,
      warnings,
    };
  }

  const prompt = buildPrompt({ width, height: size.height, lines, palette, icons });
  let html = stripFence(await options.model({ system: SYSTEM_PROMPT, prompt, image }));
  let iterations = 1;
  let diffRatio: number | undefined;

  // Verification loop: render, diff, correct. Capped at three passes.
  if (options.renderHtml && options.decode && decoded) {
    let previous = 1;
    for (;;) {
      const rendered = await options.renderHtml(html, width);
      const renderedImage = `data:image/png;base64,${bytesToBase64(rendered)}`;
      const shot = await options.decode(renderedImage);
      const diff = diffImages(decoded, shot);
      diffRatio = diff.ratio;
      if (!shouldIterate(iterations - 1, diff.ratio, previous)) break;
      previous = diff.ratio;
      html = stripFence(
        await options.model({
          system: SYSTEM_PROMPT,
          prompt: buildCorrectionPrompt(diff.ratio * 100, diff.hints),
          image,
          renderedImage,
        }),
      );
      iterations++;
    }
    if (diffRatio !== undefined && diffRatio > 0.05) {
      warn('degraded', 'fidelity', `final render differs from the source by ${(diffRatio * 100).toFixed(1)}%`);
    }
  }

  return {
    html,
    width,
    height: size.height,
    lines,
    palette,
    icons,
    ...(diffRatio !== undefined ? { diffRatio } : {}),
    iterations,
    warnings,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } };
  if (g.Buffer) return g.Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
