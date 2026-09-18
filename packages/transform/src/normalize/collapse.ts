import type { FrameNode, IRNode } from '@web2figma/ir';
import { isFrame } from '@web2figma/ir';

/**
 * Pass 2: collapse framework wrapper frames (PRD section 7).
 *
 * A frame with exactly one child, no paint of its own, and the same box as that
 * child is noise from the component tree. Removing it typically takes 30-50% of
 * the nodes off a React page, which every later pass then never has to touch.
 */

const TOLERANCE = 1;

export interface CollapseStats {
  removed: number;
  passes: number;
}

function isDecorated(f: FrameNode): boolean {
  return (
    f.fills.length > 0 ||
    f.strokes.length > 0 ||
    f.effects.length > 0 ||
    f.clip ||
    f.opacity < 0.999 ||
    f.rotation !== undefined ||
    (f.blendMode !== undefined && f.blendMode !== 'NORMAL') ||
    f.corner.some((c) => c > 0)
  );
}

function sameBox(a: FrameNode, b: IRNode): boolean {
  return (
    Math.abs(a.rect.x - b.rect.x) <= TOLERANCE &&
    Math.abs(a.rect.y - b.rect.y) <= TOLERANCE &&
    Math.abs(a.rect.w - b.rect.w) <= TOLERANCE &&
    Math.abs(a.rect.h - b.rect.h) <= TOLERANCE
  );
}

/** The child inherits whichever name carries more meaning. */
function mergeName(wrapper: FrameNode, child: IRNode): string {
  const wrapperNamed = !/^(div|span|section)$/i.test(wrapper.name);
  const childNamed = !/^(div|span|section)$/i.test(child.name);
  if (childNamed) return child.name;
  if (wrapperNamed) return wrapper.name;
  return child.name;
}

/** Collapse to a fixed point. Returns the new root plus stats for the report. */
export function collapseWrappers(root: IRNode): { root: IRNode; stats: CollapseStats } {
  const stats: CollapseStats = { removed: 0, passes: 0 };

  const once = (node: IRNode, isRoot: boolean): IRNode => {
    if (!isFrame(node)) return node;
    node.children = node.children.map((c) => once(c, false));

    // The root frame stays, whatever it looks like: everything downstream and
    // the user both expect exactly one top-level frame.
    if (isRoot) return node;
    if (node.children.length !== 1) return node;
    const child = node.children[0] as IRNode;
    if (isDecorated(node)) return node;
    if (!sameBox(node, child)) return node;
    // A positioned child relies on its wrapper as a containing block.
    if (child.layout?.absolute) return node;

    stats.removed++;
    child.name = mergeName(node, child);
    // Keep the wrapper's semantics if the child had none worth preserving.
    if (!child.meta.role && node.meta.role) child.meta.role = node.meta.role;
    if (!child.meta.testId && node.meta.testId) child.meta.testId = node.meta.testId;
    if (!child.meta.ariaLabel && node.meta.ariaLabel) child.meta.ariaLabel = node.meta.ariaLabel;
    return child;
  };

  let current = root;
  let before = -1;
  while (before !== stats.removed && stats.passes < 20) {
    before = stats.removed;
    stats.passes++;
    current = once(current, true);
  }
  return { root: current, stats };
}
