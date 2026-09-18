/**
 * FNV-1a 64-bit, expressed in 32-bit halves so it runs identically in the Figma
 * sandbox (no BigInt cost concerns), in a content script and in Node.
 *
 * Used for asset dedupe, so it only has to be fast and collision-resistant
 * enough for a few thousand payloads per document.
 */
export function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c & 0xff;
    h2 ^= (c >>> 8) & 0xff;
    // h *= 16777619, done in 32-bit safe arithmetic.
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Hash of a base64 asset payload, sampled for very large strings. */
export function hashAsset(base64: string): string {
  if (base64.length <= 200_000) return fnv1a64(base64);
  // Sample head, middle and tail plus the length: full hashing of a 20MB string
  // in the content script is a measurable capture cost for no accuracy gain.
  const head = base64.slice(0, 60_000);
  const mid = base64.slice(Math.floor(base64.length / 2), Math.floor(base64.length / 2) + 60_000);
  const tail = base64.slice(-60_000);
  return fnv1a64(`${base64.length}:${head}${mid}${tail}`);
}

/** Stable id from a DOM path, so re-captures of the same page produce the same ids. */
export function pathId(path: readonly number[], suffix?: string): string {
  const base = path.length === 0 ? 'r' : `r-${path.join('-')}`;
  return suffix ? `${base}:${suffix}` : base;
}
