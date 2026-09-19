/**
 * Utilities for formatting clipboard payloads into Figma's native H2D format.
 *
 * When written to the clipboard with MIME type 'text/html', Figma canvas
 * automatically parses this structure on Ctrl+V / Cmd+V without requiring any plugin.
 */

export function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createFigmaH2DClipboardHtml(
  jsonPayload: string,
  metadata?: Record<string, unknown>,
): string {
  const metaObj = metadata ?? {
    dataType: 'h2d',
    source: 'mcp',
    capturedAtIso: new Date().toISOString(),
  };
  const metaBase64 = toBase64(JSON.stringify(metaObj));
  const payloadBase64 = toBase64(jsonPayload);

  return (
    `<span data-metadata="<!--(figmeta)${metaBase64}(/figmeta)-->"></span>` +
    `<span data-h2d="<!--(figh2d)${payloadBase64}(/figh2d)-->"></span>`
  );
}
