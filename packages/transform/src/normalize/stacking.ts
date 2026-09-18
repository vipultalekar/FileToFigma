import type { IRNode } from '@web2figma/ir';
import { isFrame } from '@web2figma/ir';

/**
 * Pass 4: reorder siblings into paint order (PRD section 7).
 *
 * Figma's child order is paint order, so this has to match what the browser
 * actually painted or overlapping elements land the wrong way round.
 *
 * Simplified CSS 2.1 Appendix E order, which is what matters for a static
 * capture: negative z-index, then in-flow, then floats, then positioned/z-auto,
 * then positive z-index. Ties keep DOM order, so the sort must be stable.
 */

const POSITIONED = new Set(['absolute', 'relative', 'fixed', 'sticky']);

function paintLayer(node: IRNode): number {
  const position = node.meta.position ?? 'static';
  const z = node.meta.zIndex;
  const isPositioned = POSITIONED.has(position);

  if (isPositioned && z !== undefined && z < 0) return 0;
  if (!isPositioned) return 1;
  if (z === undefined || Number.isNaN(z)) return 2;
  if (z === 0) return 2;
  return 3;
}

export function resolveStacking(root: IRNode): IRNode {
  if (!isFrame(root)) return root;

  const decorated = root.children.map((node, index) => ({
    node,
    index,
    layer: paintLayer(node),
    z: node.meta.zIndex ?? 0,
  }));

  decorated.sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer;
    if (a.layer === 0 || a.layer === 3) {
      if (a.z !== b.z) return a.z - b.z;
    }
    return a.index - b.index;
  });

  root.children = decorated.map((d) => d.node);
  for (const child of root.children) resolveStacking(child);
  return root;
}
