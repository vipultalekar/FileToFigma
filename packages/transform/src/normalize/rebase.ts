import type { IRNode } from '@web2figma/ir';
import { isFrame } from '@web2figma/ir';

/**
 * Pass 3: document-absolute rects -> parent-relative (PRD section 7).
 *
 * Done exactly once, here. The builder assumes parent-relative coordinates and
 * has no way to tell the two apart, so running this twice silently shifts
 * everything; the `rebased` marker guards against that.
 */

const REBASED = new WeakSet<object>();

export function rebaseCoordinates(root: IRNode, originAtZero = true): IRNode {
  if (REBASED.has(root)) return root;

  const rootX = root.rect.x;
  const rootY = root.rect.y;

  const visit = (node: IRNode, parentAbsX: number, parentAbsY: number): void => {
    const absX = node.rect.x;
    const absY = node.rect.y;
    node.rect = {
      x: absX - parentAbsX,
      y: absY - parentAbsY,
      w: node.rect.w,
      h: node.rect.h,
    };
    if (isFrame(node)) for (const c of node.children) visit(c, absX, absY);
  };

  visit(root, rootX, rootY);
  if (!originAtZero) {
    root.rect = { ...root.rect, x: rootX, y: rootY };
  }
  REBASED.add(root);
  return root;
}
