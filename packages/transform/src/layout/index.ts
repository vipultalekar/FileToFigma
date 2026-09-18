import type { FrameNode, IRDocument, IRNode, LayoutSpec } from '@web2figma/ir';
import { defaultLayout, isFrame } from '@web2figma/ir';
import type { WarningSink } from '@web2figma/shared';
import { inferLayout } from './geometric.js';
import { nameTree } from './naming.js';
import { derivePadding } from './sizing.js';
import { constraintsFromInset, isAbsolutelyPositioned, mapFlex, mapGrid } from './tier1.js';

export * from './score.js';
export * from './sizing.js';
export * from './geometric.js';
export * from './naming.js';
export * from './tier1.js';

export interface LayoutStats {
  frames: number;
  withLayout: number;
  byReason: Record<string, number>;
}

export interface LayoutOptions {
  threshold?: number;
  warnings?: WarningSink;
  /** Skip inference entirely, leaving everything absolute (M1 behaviour). */
  disabled?: boolean;
}

/**
 * Bottom-up layout pass. Children are resolved first so a parent's sizing
 * decisions can look at content extents that are already settled.
 */
export function inferDocumentLayout(doc: IRDocument, options: LayoutOptions = {}): LayoutStats {
  const stats: LayoutStats = { frames: 0, withLayout: 0, byReason: {} };

  const visit = (node: IRNode): void => {
    if (!isFrame(node)) return;
    for (const child of node.children) visit(child);

    stats.frames++;

    // Absolutely positioned children escape their parent's auto layout wherever
    // that layout came from.
    for (const child of node.children) {
      if (isAbsolutelyPositioned(child)) {
        child.layout = {
          ...(child.layout ?? defaultLayout()),
          absolute: true,
          constraints: constraintsFromInset(child),
        };
      }
    }

    if (options.disabled) {
      for (const child of node.children) {
        child.layout = { ...child.layout, absolute: true };
      }
      node.layout = { ...node.layout, mode: 'NONE', reason: 'fallback', confidence: 1 };
      return;
    }

    const spec = resolveFrame(node, options);
    node.layout = spec;
    if (spec.mode !== 'NONE') {
      stats.withLayout++;
      stats.byReason[spec.reason] = (stats.byReason[spec.reason] ?? 0) + 1;
    }
  };

  visit(doc.root);
  nameTree(doc.root);
  return stats;
}

function resolveFrame(node: FrameNode, options: LayoutOptions): LayoutSpec {
  const kids = node.children.filter((k) => !k.layout?.absolute);
  const { padding } = derivePadding(node, kids);

  const flex = mapFlex(node, padding, options.warnings);
  if (flex) return flex;

  const grid = mapGrid(node, padding, options.warnings);
  if (grid) {
    if (grid.rows) wrapGridRows(node, grid.rows, options);
    return grid.spec;
  }

  const opts: { threshold?: number; warnings?: WarningSink } = {};
  if (options.threshold !== undefined) opts.threshold = options.threshold;
  if (options.warnings) opts.warnings = options.warnings;
  return inferLayout(node, opts);
}

/**
 * A true 2D grid becomes a vertical stack of horizontal row frames (PRD
 * section 7). The row frames are synthetic, so they are named and marked as
 * such to keep the layer list honest.
 */
function wrapGridRows(node: FrameNode, rows: IRNode[][], options: LayoutOptions): void {
  const gap = node.meta.grid?.columnGap ?? 0;
  const absolutes = node.children.filter((c) => c.layout?.absolute);
  const rowFrames: IRNode[] = rows.map((kids, index) => {
    const x = Math.min(...kids.map((k) => k.rect.x));
    const y = Math.min(...kids.map((k) => k.rect.y));
    const right = Math.max(...kids.map((k) => k.rect.x + k.rect.w));
    const bottom = Math.max(...kids.map((k) => k.rect.y + k.rect.h));
    for (const k of kids) {
      k.rect = { ...k.rect, x: k.rect.x - x, y: k.rect.y - y };
      k.layout = { ...k.layout, sizing: { h: 'FILL', v: 'FILL' } };
    }
    const row: FrameNode = {
      id: `${node.id}:row${index}`,
      name: `Row ${index + 1}`,
      kind: 'frame',
      rect: { x, y, w: right - x, h: bottom - y },
      opacity: 1,
      visible: true,
      effects: [],
      meta: { tag: 'div', classes: [], display: 'flex' },
      children: kids,
      fills: [],
      strokes: [],
      corner: [0, 0, 0, 0],
      clip: false,
      layout: {
        mode: 'HORIZONTAL',
        padding: [0, 0, 0, 0],
        itemSpacing: gap,
        primaryAlign: 'MIN',
        counterAlign: 'MIN',
        sizing: { h: 'FILL', v: 'HUG' },
        confidence: 0.8,
        reason: 'grid',
      },
    };
    return row;
  });
  options.warnings?.info(
    node.id,
    'display: grid',
    `2D grid emitted as ${rowFrames.length} row frames`,
  );
  node.children = [...rowFrames, ...absolutes];
}
