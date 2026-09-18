import type { FrameNode, IRNode, Rect } from '@web2figma/ir';
import { isFrame } from '@web2figma/ir';
import type { WarningSink } from '@web2figma/shared';

/**
 * Pass 1: drop nodes that cannot contribute a pixel (PRD section 7).
 *
 * Runs while rects are still document-absolute, so the root rect is a simple
 * containment test.
 */

const EPSILON = 0.5;

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w + EPSILON &&
    a.x + a.w + EPSILON > b.x &&
    a.y < b.y + b.h + EPSILON &&
    a.y + a.h + EPSILON > b.y
  );
}

function hasVisibleContent(node: IRNode): boolean {
  if (node.kind === 'text') return node.characters.trim().length > 0;
  if (node.kind === 'image' || node.kind === 'vector') return true;
  const f = node as FrameNode;
  if (f.fills.length > 0 || f.strokes.length > 0 || f.effects.length > 0) return true;
  return f.children.some(hasVisibleContent);
}

export function prune(root: IRNode, warnings?: WarningSink): IRNode {
  const bounds = root.rect;
  let dropped = 0;

  const visit = (node: IRNode): IRNode | null => {
    if (!node.visible || node.opacity <= 0.001) {
      if (!isFrame(node) || node.children.length === 0) {
        dropped++;
        return null;
      }
    }
    if (node.rect.w <= 0 || node.rect.h <= 0) {
      // A zero-size frame can still position children (a common flex trick),
      // so only drop it when it is genuinely empty.
      if (!isFrame(node) || node.children.length === 0) {
        dropped++;
        return null;
      }
    }
    if (node !== root && !intersects(node.rect, bounds) && !isFrame(node)) {
      dropped++;
      return null;
    }

    if (isFrame(node)) {
      const kids: IRNode[] = [];
      for (const child of node.children) {
        const kept = visit(child);
        if (kept) kids.push(kept);
      }
      node.children = kids;
      if (node !== root && kids.length === 0 && !hasVisibleContent(node)) {
        dropped++;
        return null;
      }
    }
    return node;
  };

  const result = visit(root) ?? root;
  if (dropped > 0) {
    warnings?.info(root.id, 'prune', `${dropped} invisible or empty nodes removed`);
  }
  return result;
}
