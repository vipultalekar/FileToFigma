import type { IRDocument, ImageAsset } from '@web2figma/ir';
import { isFrame, isImage, walk } from '@web2figma/ir';

/**
 * Pass 6: collapse duplicate image payloads (PRD section 7).
 *
 * Hero images repeated across sections dominate payload size, and every
 * duplicate also becomes a separate figma.createImage call at build time.
 */

export interface DedupeStats {
  before: number;
  after: number;
  bytesSaved: number;
}

export function dedupeAssets(doc: IRDocument): DedupeStats {
  const byHash = new Map<string, string>();
  const remap = new Map<string, string>();
  const kept: Record<string, ImageAsset> = {};
  let bytesSaved = 0;

  for (const [id, asset] of Object.entries(doc.images)) {
    const existing = byHash.get(asset.hash);
    if (existing) {
      remap.set(id, existing);
      bytesSaved += asset.bytes.length;
    } else {
      byHash.set(asset.hash, id);
      kept[id] = asset;
    }
  }

  const before = Object.keys(doc.images).length;
  if (remap.size > 0) {
    for (const node of walk(doc.root)) {
      if (isImage(node)) {
        const target = remap.get(node.assetId);
        if (target) node.assetId = target;
      }
      if (isFrame(node)) {
        for (const fill of node.fills) {
          if (fill.type === 'IMAGE') {
            const target = remap.get(fill.assetId);
            if (target) fill.assetId = target;
          }
        }
      }
    }
    doc.images = kept;
  }

  // Drop assets nothing references any more; the transport cost is per byte.
  const referenced = new Set<string>();
  for (const node of walk(doc.root)) {
    if (isImage(node)) referenced.add(node.assetId);
    if (isFrame(node)) {
      for (const fill of node.fills) if (fill.type === 'IMAGE') referenced.add(fill.assetId);
    }
  }
  for (const id of Object.keys(doc.images)) {
    if (!referenced.has(id)) {
      bytesSaved += doc.images[id]?.bytes.length ?? 0;
      delete doc.images[id];
    }
  }

  return { before, after: Object.keys(doc.images).length, bytesSaved };
}
