import { describe, expect, it } from 'vitest';
import { clusterFontSizes, estimateFontSize, groupIntoLines, runOcr } from './ocr.js';
import { kMeansPalette, luminance, toHex, type RgbaImage } from './palette.js';
import { detectIcons } from './icons.js';
import { buildPrompt, stripFence } from './prompt.js';
import { diffImages, shouldIterate } from './verify.js';
import { imageToHtml, readImageSize } from './index.js';

function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('ocr post-processing', () => {
  it('groups words into lines in reading order', () => {
    const lines = groupIntoLines([
      { text: 'world', x: 60, y: 10, w: 40, h: 14 },
      { text: 'Hello', x: 10, y: 11, w: 40, h: 14 },
      { text: 'Next', x: 10, y: 40, w: 40, h: 14 },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.text).toBe('Hello world');
  });

  it('estimates font size from the box height', () => {
    expect(estimateFontSize(22)).toBe(16);
  });

  it('clusters nearly-equal font sizes onto one value', () => {
    const lines = clusterFontSizes([
      { text: 'a', x: 0, y: 0, w: 10, h: 10, estimatedFontSize: 16, confidence: 1 },
      { text: 'b', x: 0, y: 20, w: 10, h: 10, estimatedFontSize: 17, confidence: 1 },
      { text: 'c', x: 0, y: 40, w: 10, h: 10, estimatedFontSize: 16, confidence: 1 },
      { text: 'd', x: 0, y: 60, w: 10, h: 10, estimatedFontSize: 32, confidence: 1 },
    ]);
    expect(lines.slice(0, 3).map((l) => l.estimatedFontSize)).toEqual([16, 16, 16]);
    expect(lines[3]?.estimatedFontSize).toBe(32);
  });

  it('drops low-confidence noise', async () => {
    const lines = await runOcr('data:image/png;base64,', async () => [
      { text: 'Real text', x: 0, y: 0, w: 60, h: 14, confidence: 0.95 },
      { text: '~', x: 0, y: 40, w: 4, h: 4, confidence: 0.2 },
    ]);
    expect(lines).toHaveLength(1);
  });
});

describe('palette', () => {
  it('finds the dominant colours', () => {
    const image = makeImage(60, 60, (x) => (x < 30 ? [255, 0, 0] : [0, 0, 255]));
    const palette = kMeansPalette(image, 4);
    const hexes = palette.map((p) => p.hex);
    expect(hexes).toContain('#ff0000');
    expect(hexes).toContain('#0000ff');
  });

  it('sorts by weight', () => {
    const image = makeImage(100, 10, (x) => (x < 90 ? [255, 255, 255] : [0, 0, 0]));
    const palette = kMeansPalette(image, 3);
    expect(palette[0]?.hex).toBe('#ffffff');
  });

  it('computes luminance for readable text choices', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1, 2);
    expect(luminance('#000000')).toBeCloseTo(0, 2);
    expect(toHex({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
  });
});

describe('icon detection', () => {
  it('finds a small high-contrast square with no text over it', () => {
    const image = makeImage(200, 120, (x, y) => {
      const inIcon = x >= 40 && x < 72 && y >= 40 && y < 72;
      const checker = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      if (inIcon) return checker ? [0, 0, 0] : [255, 255, 255];
      return [250, 250, 250];
    });
    const icons = detectIcons(image, []);
    expect(icons.length).toBeGreaterThan(0);
    expect(icons[0]?.w).toBeLessThanOrEqual(96);
  });

  it('ignores regions that overlap OCR text', () => {
    const image = makeImage(200, 120, (x, y) => {
      const inIcon = x >= 40 && x < 72 && y >= 40 && y < 72;
      const checker = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      if (inIcon) return checker ? [0, 0, 0] : [255, 255, 255];
      return [250, 250, 250];
    });
    const icons = detectIcons(image, [
      { text: 'label', x: 30, y: 30, w: 80, h: 60, estimatedFontSize: 16, confidence: 1 },
    ]);
    expect(icons).toHaveLength(0);
  });
});

describe('prompt contract', () => {
  const input = {
    width: 1440,
    height: 900,
    lines: [
      { text: 'Get started', x: 40, y: 80, w: 120, h: 22, estimatedFontSize: 16, confidence: 1 },
    ],
    palette: [{ hex: '#0f172a', weight: 0.6 }],
    icons: [{ id: 1, x: 10, y: 10, w: 24, h: 24 }],
  };

  it('pins the output format and the flexbox requirement', () => {
    const prompt = buildPrompt(input);
    expect(prompt).toMatch(/no markdown fence/i);
    expect(prompt).toMatch(/flexbox for every container/i);
    expect(prompt).toMatch(/verbatim/i);
    expect(prompt).toContain('1440px');
    expect(prompt).toContain('#0f172a');
    expect(prompt).toContain('Get started');
    expect(prompt).toContain('data-icon="1"');
  });

  it('strips a fence the model adds anyway', () => {
    expect(stripFence('```html\n<!DOCTYPE html><html></html>\n```')).toBe(
      '<!DOCTYPE html><html></html>',
    );
    expect(stripFence('Sure! <!DOCTYPE html><html></html>')).toBe(
      '<!DOCTYPE html><html></html>',
    );
  });
});

describe('verification loop', () => {
  it('reports zero difference for identical images', () => {
    const a = makeImage(40, 40, () => [10, 20, 30]);
    expect(diffImages(a, a).ratio).toBe(0);
  });

  it('locates where the difference is', () => {
    const a = makeImage(40, 40, () => [255, 255, 255]);
    const b = makeImage(40, 40, (x, y) => (y > 30 ? [0, 0, 0] : [255, 255, 255]));
    const diff = diffImages(a, b);
    expect(diff.ratio).toBeGreaterThan(0.1);
    expect(diff.hints[0]).toMatch(/bottom/);
  });

  it('stops after three iterations or when improvement stalls', () => {
    expect(shouldIterate(0, 0.4, 1)).toBe(true);
    expect(shouldIterate(3, 0.4, 1)).toBe(false);
    expect(shouldIterate(1, 0.02, 0.4)).toBe(false);
    expect(shouldIterate(1, 0.39, 0.4)).toBe(false);
  });
});

describe('imageToHtml', () => {
  const pngHeader = (() => {
    // 8x8 PNG header with IHDR only; enough for readImageSize.
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes[19] = 8;
    bytes[23] = 8;
    return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  })();

  it('reads PNG dimensions from the header', () => {
    expect(readImageSize(pngHeader)).toEqual({ width: 8, height: 8 });
  });

  it('degrades to an OCR skeleton and says so when no model is configured', async () => {
    const result = await imageToHtml(pngHeader, {
      width: 1200,
      ocr: async () => [{ text: 'Dashboard', x: 20, y: 20, w: 100, h: 22, confidence: 0.9 }],
    });
    expect(result.html).toContain('Dashboard');
    expect(result.warnings.some((w) => w.property === 'vision-model')).toBe(true);
    expect(result.iterations).toBe(0);
  });

  it('runs the model and the verification loop', async () => {
    const calls: string[] = [];
    const result = await imageToHtml(pngHeader, {
      width: 400,
      ocr: async () => [{ text: 'Hello', x: 0, y: 0, w: 40, h: 20, confidence: 1 }],
      decode: async () => makeImage(40, 40, () => [255, 255, 255]),
      renderHtml: async () => new Uint8Array([1, 2, 3]),
      model: async ({ prompt }) => {
        calls.push(prompt);
        return '```html\n<!DOCTYPE html><html><body><div style="display:flex">Hello</div></body></html>\n```';
      },
    });
    expect(result.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(result.diffRatio).toBe(0);
  });
});
