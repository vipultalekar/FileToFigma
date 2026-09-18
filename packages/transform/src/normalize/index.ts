import type { IRDocument } from '@web2figma/ir';
import type { WarningSink } from '@web2figma/shared';
import { collapseWrappers } from './collapse.js';
import { dedupeAssets } from './dedupeAssets.js';
import { mergeTextRuns } from './mergeText.js';
import { prune } from './prune.js';
import { rebaseCoordinates } from './rebase.js';
import { resolveStacking } from './stacking.js';

export * from './collapse.js';
export * from './dedupeAssets.js';
export * from './mergeText.js';
export * from './prune.js';
export * from './rebase.js';
export * from './stacking.js';

export interface NormaliseStats {
  collapsed: number;
  assetsBefore: number;
  assetsAfter: number;
  bytesSaved: number;
}

/**
 * The six normalisation passes, in the order PRD section 7 specifies. Order is
 * load-bearing: collapsing compares absolute rects, so it must run before the
 * rebase, and stacking must run before text merging so that merged runs are
 * already neighbours in paint order.
 */
export function normalise(doc: IRDocument, warnings?: WarningSink): NormaliseStats {
  doc.root = prune(doc.root, warnings);
  const { root, stats } = collapseWrappers(doc.root);
  doc.root = root;
  doc.root = rebaseCoordinates(doc.root);
  doc.root = resolveStacking(doc.root);
  doc.root = mergeTextRuns(doc.root);
  const assets = dedupeAssets(doc);

  return {
    collapsed: stats.removed,
    assetsBefore: assets.before,
    assetsAfter: assets.after,
    bytesSaved: assets.bytesSaved,
  };
}
