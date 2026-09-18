import { describe, expect, it } from 'vitest';
import { parseSrcset } from './images.js';

/**
 * srcset parsing is pure string work, so it is tested here without a DOM. The
 * element-level `bestSource` is covered by the browser fixture suite.
 */

describe('parseSrcset', () => {
  it('reads w descriptors as pixel widths', () => {
    expect(parseSrcset('a.jpg 400w, b.jpg 800w, c.jpg 1600w')).toEqual([
      { url: 'a.jpg', width: 400 },
      { url: 'b.jpg', width: 800 },
      { url: 'c.jpg', width: 1600 },
    ]);
  });

  it('scales x descriptors by the layout width so both kinds compare', () => {
    expect(parseSrcset('a.jpg 1x, b.jpg 2x, c.jpg 3x', 300)).toEqual([
      { url: 'a.jpg', width: 300 },
      { url: 'b.jpg', width: 600 },
      { url: 'c.jpg', width: 900 },
    ]);
  });

  it('treats a bare URL as the 1x candidate', () => {
    expect(parseSrcset('only.jpg', 250)).toEqual([{ url: 'only.jpg', width: 250 }]);
  });

  it('tolerates messy whitespace and trailing commas', () => {
    expect(parseSrcset('  a.jpg   400w ,  b.jpg 800w ,')).toEqual([
      { url: 'a.jpg', width: 400 },
      { url: 'b.jpg', width: 800 },
    ]);
  });

  it('returns nothing for an empty attribute', () => {
    expect(parseSrcset('')).toEqual([]);
    expect(parseSrcset('   ')).toEqual([]);
  });
});
