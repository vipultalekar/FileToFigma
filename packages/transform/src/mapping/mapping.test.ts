import { describe, expect, it } from 'vitest';
import { parseColor, solidFromCss, toHex } from './color.js';
import {
  gradientToPaint,
  linearGradientTransform,
  parseGradient,
  splitTopLevel,
} from './gradient.js';
import { backgroundSizeToScaleMode, backgroundToFills } from './background.js';
import { borderToStroke, cornerRadius, dashPattern } from './border.js';
import { boxShadowToEffects, filterToEffects, parseShadow } from './effects.js';
import {
  autoResize,
  classifyFamily,
  letterSpacing,
  lineHeight,
  normaliseWeight,
  textAlign,
  textCase,
  toFontRequest,
} from './text.js';
import {
  blendMode,
  clipsContent,
  decomposeTransform,
  rasteriseReason,
  toFigmaRotation,
} from './transform.js';

describe('color', () => {
  it('parses rgb, rgba, hex and named colours', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor('#0000ff80')?.a).toBeCloseTo(0.502, 2);
    expect(parseColor('white')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it('parses modern space-separated syntax with slash alpha', () => {
    expect(parseColor('rgb(255 128 0 / 50%)')).toEqual({
      r: 1,
      g: 128 / 255,
      b: 0,
      a: 0.5,
    });
  });

  it('parses hsl', () => {
    const c = parseColor('hsl(120, 100%, 50%)');
    expect(toHex(c!)).toBe('#00ff00');
  });

  it('treats transparent as no fill', () => {
    expect(solidFromCss('rgba(0, 0, 0, 0)')).toBeNull();
    expect(solidFromCss('transparent')).toBeNull();
    expect(solidFromCss('none')).toBeNull();
  });

  it('folds alpha into paint opacity', () => {
    expect(solidFromCss('rgba(255,0,0,0.25)')).toEqual({
      type: 'SOLID',
      color: { r: 1, g: 0, b: 0 },
      opacity: 0.25,
    });
  });
});

describe('gradient', () => {
  it('splits on top-level commas only', () => {
    expect(splitTopLevel('rgb(1, 2, 3) 0%, blue 100%')).toEqual([
      'rgb(1, 2, 3) 0%',
      'blue 100%',
    ]);
  });

  it('maps `to right` to the identity matrix, which is Figma default', () => {
    const t = linearGradientTransform(90, 200, 100);
    expect(t[0][0]).toBeCloseTo(1);
    expect(t[0][1]).toBeCloseTo(0);
    expect(t[0][2]).toBeCloseTo(0);
    expect(t[1][0]).toBeCloseTo(0);
    expect(t[1][1]).toBeCloseTo(1);
    expect(t[1][2]).toBeCloseTo(0);
  });

  it('maps `to bottom` to a downward gradient', () => {
    const t = linearGradientTransform(180, 200, 100);
    expect(t[0][0]).toBeCloseTo(0);
    expect(t[0][1]).toBeCloseTo(1);
    expect(t[0][2]).toBeCloseTo(0);
  });

  it('maps `to left` to a reversed horizontal gradient', () => {
    const t = linearGradientTransform(270, 200, 100);
    expect(t[0][0]).toBeCloseTo(-1);
    expect(t[0][2]).toBeCloseTo(1);
  });

  it('fills implicit stop positions by even distribution', () => {
    const g = parseGradient('linear-gradient(to right, red, green, blue)', 100, 100);
    expect(g?.stops.map((s) => s.position)).toEqual([0, 0.5, 1]);
  });

  it('honours explicit stop positions and keeps them monotonic', () => {
    const g = parseGradient('linear-gradient(red 40%, blue 10%)', 100, 100);
    expect(g?.stops.map((s) => s.position)).toEqual([0.4, 0.4]);
  });

  it('parses keyword angles and degree angles', () => {
    expect(parseGradient('linear-gradient(to top, red, blue)', 10, 10)?.angle).toBe(0);
    expect(parseGradient('linear-gradient(45deg, red, blue)', 10, 10)?.angle).toBe(45);
    expect(parseGradient('linear-gradient(0.5turn, red, blue)', 10, 10)?.angle).toBe(180);
  });

  it('maps radial and conic gradients to their Figma types', () => {
    expect(gradientToPaint('radial-gradient(red, blue)', 10, 10)?.type).toBe(
      'GRADIENT_RADIAL',
    );
    expect(gradientToPaint('conic-gradient(red, blue)', 10, 10)?.type).toBe(
      'GRADIENT_ANGULAR',
    );
  });

  it('returns a centred identity transform for a default radial gradient', () => {
    const p = gradientToPaint('radial-gradient(red, blue)', 100, 100)!;
    expect(p.transform[0][0]).toBeCloseTo(1);
    expect(p.transform[0][2]).toBeCloseTo(0);
    expect(p.transform[1][1]).toBeCloseTo(1);
  });
});

describe('background', () => {
  const box = { width: 100, height: 50 };

  it('puts background-color underneath image layers', () => {
    const fills = backgroundToFills(
      {
        color: 'rgb(255,255,255)',
        image: 'linear-gradient(to right, red, blue)',
        size: null,
        position: null,
        repeat: null,
        ...box,
      },
      () => null,
    );
    expect(fills[0]?.type).toBe('SOLID');
    expect(fills[1]?.type).toBe('GRADIENT_LINEAR');
  });

  it('reverses multiple background layers so Figma paints them bottom-first', () => {
    const fills = backgroundToFills(
      {
        color: null,
        image: 'url(a.png), url(b.png)',
        size: null,
        position: null,
        repeat: null,
        ...box,
      },
      (url) => url.replace('.png', ''),
    );
    // CSS a is on top, so Figma order is b then a.
    expect(fills.map((f) => (f.type === 'IMAGE' ? f.assetId : f.type))).toEqual(['b', 'a']);
  });

  it('reports dropped background images', () => {
    const drops: string[] = [];
    backgroundToFills(
      { color: null, image: 'url(x.png)', size: null, position: null, repeat: null, ...box },
      () => null,
      (_p, detail) => drops.push(detail),
    );
    expect(drops).toHaveLength(1);
  });

  it('maps background-size to a scale mode', () => {
    expect(backgroundSizeToScaleMode('cover', 'no-repeat')).toBe('FILL');
    expect(backgroundSizeToScaleMode('contain', 'no-repeat')).toBe('FIT');
    expect(backgroundSizeToScaleMode('auto', 'repeat')).toBe('TILE');
    expect(backgroundSizeToScaleMode('40px 40px', 'no-repeat')).toBe('CROP');
  });
});

describe('border', () => {
  const side = (width: number, style = 'solid', color = 'rgb(0,0,0)') => ({
    width,
    style,
    color,
  });

  it('maps a uniform border to a single inside stroke', () => {
    const r = borderToStroke({
      top: side(2),
      right: side(2),
      bottom: side(2),
      left: side(2),
    });
    expect(r.nonUniform).toBe(false);
    expect(r.stroke).toEqual({
      paint: { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 },
      weight: 2,
      align: 'INSIDE',
    });
  });

  it('flags a non-uniform border for edge-frame synthesis', () => {
    const r = borderToStroke({
      top: side(0),
      right: side(0),
      bottom: side(1),
      left: side(0),
    });
    expect(r.nonUniform).toBe(true);
    expect(r.sides.map((s) => s.side)).toEqual(['bottom']);
  });

  it('ignores invisible borders', () => {
    const r = borderToStroke({
      top: side(2, 'none'),
      right: side(0),
      bottom: side(2, 'solid', 'transparent'),
      left: side(0),
    });
    expect(r.stroke).toBeNull();
    expect(r.nonUniform).toBe(false);
  });

  it('derives dash patterns', () => {
    expect(dashPattern('dotted', 2)).toEqual([2, 2]);
    expect(dashPattern('dashed', 2)).toEqual([6, 4]);
    expect(dashPattern('solid', 2)).toBeUndefined();
  });

  it('resolves percentage radii and clamps to half the shorter side', () => {
    expect(cornerRadius(['50%', '0px', '0px', '0px'], 100, 40)).toEqual([20, 0, 0, 0]);
    expect(cornerRadius(['999px', '4px', '4px', '4px'], 100, 40)).toEqual([20, 4, 4, 4]);
  });
});

describe('effects', () => {
  it('parses a computed drop shadow with a leading colour', () => {
    expect(parseShadow('rgba(0, 0, 0, 0.2) 0px 4px 8px 1px')).toEqual({
      type: 'DROP_SHADOW',
      color: { r: 0, g: 0, b: 0, a: 0.2 },
      offset: { x: 0, y: 4 },
      radius: 8,
      spread: 1,
    });
  });

  it('parses inset shadows as inner shadows', () => {
    const e = parseShadow('rgb(0,0,0) 0px 1px 2px inset');
    expect(e?.type).toBe('INNER_SHADOW');
  });

  it('splits multiple shadows', () => {
    const list = boxShadowToEffects(
      'rgba(0,0,0,0.1) 0px 1px 2px 0px, rgba(0,0,0,0.2) 0px 4px 8px 0px',
    );
    expect(list).toHaveLength(2);
  });

  it('maps blur filters and flags unsupported ones', () => {
    expect(filterToEffects('blur(4px)', 'filter').effects[0]).toEqual({
      type: 'LAYER_BLUR',
      radius: 4,
    });
    expect(filterToEffects('blur(10px)', 'backdrop-filter').effects[0]?.type).toBe(
      'BACKGROUND_BLUR',
    );
    expect(filterToEffects('hue-rotate(90deg)', 'filter').unsupported).toEqual([
      'hue-rotate',
    ]);
  });
});

describe('text', () => {
  it('builds a font request from a CSS stack', () => {
    const f = toFontRequest('"Helvetica Neue", Arial, sans-serif', '700', 'italic');
    expect(f.family).toBe('Helvetica Neue');
    expect(f.weight).toBe(700);
    expect(f.italic).toBe(true);
    expect(f.fallbackStack).toEqual(['Arial', 'sans-serif']);
    expect(f.classification).toBe('sans-serif');
  });

  it('normalises weights', () => {
    expect(normaliseWeight('normal')).toBe(400);
    expect(normaliseWeight('bold')).toBe(700);
    expect(normaliseWeight('550')).toBe(600);
    expect(normaliseWeight(null)).toBe(400);
  });

  it('classifies families', () => {
    expect(classifyFamily('Georgia', ['serif'])).toBe('serif');
    expect(classifyFamily('Menlo', [])).toBe('monospace');
    expect(classifyFamily('Inter', [])).toBe('sans-serif');
  });

  it('maps line-height units', () => {
    expect(lineHeight('normal', 16)).toEqual({ unit: 'AUTO' });
    expect(lineHeight('24px', 16)).toEqual({ unit: 'PIXELS', value: 24 });
    expect(lineHeight('1.5', 16)).toEqual({ unit: 'PIXELS', value: 24 });
    expect(lineHeight('150%', 16)).toEqual({ unit: 'PERCENT', value: 150 });
  });

  it('maps letter-spacing', () => {
    expect(letterSpacing('normal', 16)).toEqual({ unit: 'PIXELS', value: 0 });
    expect(letterSpacing('0.05em', 16)).toEqual({ unit: 'PIXELS', value: 0.8 });
  });

  it('resolves logical text alignment via direction', () => {
    expect(textAlign('start', 'rtl')).toBe('RIGHT');
    expect(textAlign('end', 'ltr')).toBe('RIGHT');
    expect(textAlign('center', 'ltr')).toBe('CENTER');
  });

  it('maps text-transform', () => {
    expect(textCase('uppercase')).toBe('UPPER');
    expect(textCase('none')).toBeUndefined();
  });

  it('prefers HEIGHT auto-resize so text reflows', () => {
    expect(autoResize({ truncate: false, clamped: false, inline: false })).toBe('HEIGHT');
    expect(autoResize({ truncate: true, clamped: false, inline: false })).toBe('NONE');
    expect(autoResize({ truncate: false, clamped: false, inline: true })).toBe(
      'WIDTH_AND_HEIGHT',
    );
  });
});

describe('transform', () => {
  it('extracts rotation from a 2D matrix', () => {
    // 45 degree rotation.
    const c = Math.cos(Math.PI / 4);
    const s = Math.sin(Math.PI / 4);
    const d = decomposeTransform(`matrix(${c}, ${s}, ${-s}, ${c}, 0, 0)`);
    expect(d?.rotationDeg).toBeCloseTo(45);
    expect(d?.hasSkew).toBe(false);
  });

  it('negates rotation for Figma', () => {
    expect(toFigmaRotation(45)).toBe(-45);
    expect(toFigmaRotation(0)).toBeUndefined();
  });

  it('detects skew and 3D transforms', () => {
    expect(decomposeTransform('matrix(1, 0, 0.5, 1, 0, 0)')?.hasSkew).toBe(true);
    expect(
      decomposeTransform(
        'matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0.001, 0,0,0,1)',
      )?.is3d,
    ).toBe(true);
  });

  it('names the reason a subtree must be rasterised', () => {
    expect(
      rasteriseReason({
        transform: 'none',
        clipPath: 'circle(50%)',
        maskImage: 'none',
        writingMode: 'horizontal-tb',
        filter: 'none',
      }),
    ).toBe('clip-path');
    expect(
      rasteriseReason({
        transform: 'matrix(1,0,0.6,1,0,0)',
        clipPath: 'none',
        maskImage: 'none',
        writingMode: 'horizontal-tb',
        filter: 'none',
      }),
    ).toBe('transform-skew');
    expect(
      rasteriseReason({
        transform: 'none',
        clipPath: 'none',
        maskImage: 'none',
        writingMode: 'horizontal-tb',
        filter: 'none',
      }),
    ).toBeNull();
  });

  it('maps blend modes and reports unsupported ones', () => {
    expect(blendMode('multiply')).toEqual({ mode: 'MULTIPLY', supported: true });
    expect(blendMode('plus-lighter').mode).toBe('NORMAL');
  });

  it('maps overflow to clipsContent', () => {
    expect(clipsContent('hidden')).toBe(true);
    expect(clipsContent('auto')).toBe(true);
    expect(clipsContent('visible')).toBe(false);
  });
});
