import { describe, it, expect } from 'vitest';
import { createFigmaH2DClipboardHtml, toBase64 } from './figma-h2d';

describe('figma-h2d clipboard formatting', () => {
  it('encodes string into base64 correctly', () => {
    const raw = 'Hello Figma';
    const b64 = toBase64(raw);
    expect(b64).toBe(Buffer.from(raw).toString('base64'));
  });

  it('produces the exact Figma native span format', () => {
    const jsonPayload = JSON.stringify({ version: 2, root: { type: 'FRAME' } });
    const html = createFigmaH2DClipboardHtml(jsonPayload);

    expect(html).toContain('<span data-metadata="<!--(figmeta)');
    expect(html).toContain('(/figmeta)-->"></span>');
    expect(html).toContain('<span data-h2d="<!--(figh2d)');
    expect(html).toContain('(/figh2d)-->"></span>');

    // Verify metadata inside is valid JSON
    const metaMatch = html.match(/data-metadata="<!--\(figmeta\)(.*?)\(\/figmeta\)-->"/);
    expect(metaMatch).toBeTruthy();
    const metaDecoded = Buffer.from(metaMatch![1], 'base64').toString('utf8');
    const metaParsed = JSON.parse(metaDecoded);
    expect(metaParsed.dataType).toBe('h2d');
    expect(metaParsed.source).toBe('mcp');

    // Verify payload inside is valid JSON
    const h2dMatch = html.match(/data-h2d="<!--\(figh2d\)(.*?)\(\/figh2d\)-->"/);
    expect(h2dMatch).toBeTruthy();
    const payloadDecoded = Buffer.from(h2dMatch![1], 'base64').toString('utf8');
    expect(JSON.parse(payloadDecoded)).toEqual({ version: 2, root: { type: 'FRAME' } });
  });
});
