import type { FrameNode, IRNode, LayoutSpec, Sizing } from '@web2figma/ir';
import { isFrame, isText } from '@web2figma/ir';

/**
 * Padding, alignment and per-child sizing for Tier 2 (PRD section 7 stage 3).
 * All rects here are parent-relative: normalisation has already run.
 */

import { EDGE_TOLERANCE, mean } from './score.js';

export interface PaddingResult {
  padding: [number, number, number, number];
  /** A child sticking out of its parent is worth reporting. */
  overflow: boolean;
}

export function derivePadding(parent: FrameNode, kids: readonly IRNode[]): PaddingResult {
  if (kids.length === 0) {
    return { padding: [0, 0, 0, 0], overflow: false };
  }
  const left = Math.min(...kids.map((k) => k.rect.x));
  const top = Math.min(...kids.map((k) => k.rect.y));
  const right = parent.rect.w - Math.max(...kids.map((k) => k.rect.x + k.rect.w));
  const bottom = parent.rect.h - Math.max(...kids.map((k) => k.rect.y + k.rect.h));

  const overflow = left < -0.5 || top < -0.5 || right < -0.5 || bottom < -0.5;
  const clamp = (n: number): number => Math.max(0, Math.round(n));
  return { padding: [clamp(top), clamp(right), clamp(bottom), clamp(left)], overflow };
}

export type CounterAlign = LayoutSpec['counterAlign'];

/** Counter-axis alignment from shared edges, majority wins. */
export function deriveCounterAlign(
  parent: FrameNode,
  kids: readonly IRNode[],
  mode: 'HORIZONTAL' | 'VERTICAL',
): CounterAlign {
  if (kids.length === 0) return 'MIN';
  const vertical = mode === 'VERTICAL';
  const starts = kids.map((k) => (vertical ? k.rect.x : k.rect.y));
  const ends = kids.map((k) => (vertical ? k.rect.x + k.rect.w : k.rect.y + k.rect.h));
  const extent = vertical ? parent.rect.w : parent.rect.h;
  const centres = kids.map((k, i) => (starts[i] as number) + ((ends[i] as number) - (starts[i] as number)) / 2);

  const agree = (values: number[]): number => {
    let best = 0;
    for (const v of values) {
      best = Math.max(best, values.filter((o) => Math.abs(o - v) <= EDGE_TOLERANCE).length);
    }
    return best / values.length;
  };

  const startAgreement = agree(starts);
  const endAgreement = agree(ends);
  const centreAgreement = agree(centres);
  const centreOfParent = extent / 2;
  const centred =
    centreAgreement >= startAgreement &&
    centreAgreement >= endAgreement &&
    Math.abs(mean(centres) - centreOfParent) <= Math.max(2, extent * 0.02);

  if (centred) return 'CENTER';
  if (endAgreement > startAgreement) return 'MAX';
  return 'MIN';
}

/**
 * SPACE_BETWEEN is the honest reading when the children span the full content
 * box and the interior gaps dwarf the outer padding (PRD section 7).
 */
export function derivePrimaryAlign(
  parent: FrameNode,
  ordered: readonly IRNode[],
  mode: 'HORIZONTAL' | 'VERTICAL',
  gaps: readonly number[],
  padding: [number, number, number, number],
): LayoutSpec['primaryAlign'] {
  if (ordered.length < 2) return 'MIN';
  const horizontal = mode === 'HORIZONTAL';
  const leadPad = horizontal ? padding[3] : padding[0];
  const trailPad = horizontal ? padding[1] : padding[2];
  const interior = mean(gaps);
  const outer = Math.max(leadPad, trailPad);

  const contentExtent = horizontal ? parent.rect.w : parent.rect.h;
  const first = ordered[0] as IRNode;
  const last = ordered[ordered.length - 1] as IRNode;
  const used = horizontal
    ? last.rect.x + last.rect.w - first.rect.x
    : last.rect.y + last.rect.h - first.rect.y;
  const slackBefore = horizontal ? first.rect.x : first.rect.y;
  const slackAfter = contentExtent - used - slackBefore;

  // SPACE_BETWEEN only when the run really is flush to both padding edges and
  // the interior gaps dwarf the outer padding (PRD section 7). Without the
  // flush test, any stack with a margin between two blocks reads as
  // SPACE_BETWEEN, which then collapses the moment the content grows.
  const flushStart = Math.abs(slackBefore - leadPad) <= 1;
  const flushEnd = Math.abs(slackAfter - trailPad) <= 1;
  if (flushStart && flushEnd && interior > Math.max(8, outer * 2)) return 'SPACE_BETWEEN';

  if (Math.abs(slackBefore - slackAfter) <= Math.max(2, contentExtent * 0.02) && slackBefore > 4) {
    return 'CENTER';
  }
  if (slackBefore > slackAfter * 2 && slackBefore > 8) return 'MAX';
  return 'MIN';
}

function contentExtent(node: IRNode, axis: 'w' | 'h'): number {
  if (!isFrame(node) || node.children.length === 0) {
    return node.meta.intrinsic?.[axis] ?? (axis === 'w' ? node.rect.w : node.rect.h);
  }
  const kids = node.children;
  return axis === 'w'
    ? Math.max(...kids.map((k) => k.rect.x + k.rect.w))
    : Math.max(...kids.map((k) => k.rect.y + k.rect.h));
}

/**
 * Per-child sizing (PRD section 7):
 *  - within 1px of the parent content width -> FILL
 *  - text narrower than its box -> HUG when the box hugs, else FILL
 *  - frame matching its own content extent -> HUG
 *  - otherwise FIXED
 * Vertically, text defaults to HUG so reflow works when the width changes.
 */
export function decideSizing(
  parent: FrameNode,
  child: IRNode,
  padding: [number, number, number, number],
  mode: 'HORIZONTAL' | 'VERTICAL' | 'WRAP',
): { h: Sizing; v: Sizing } {
  const contentW = parent.rect.w - padding[3] - padding[1];
  const contentH = parent.rect.h - padding[0] - padding[2];

  const fillsWidth = Math.abs(child.rect.w - contentW) <= 1;
  const fillsHeight = Math.abs(child.rect.h - contentH) <= 1;

  let h: Sizing = 'FIXED';
  let v: Sizing = 'FIXED';

  if (fillsWidth) h = 'FILL';
  else if (isFrame(child) && Math.abs(contentExtent(child, 'w') - child.rect.w) <= 1) h = 'HUG';
  else if (isText(child)) {
    const intrinsic = child.meta.intrinsic?.w ?? child.rect.w;
    h = intrinsic < child.rect.w - 1 ? 'FILL' : 'HUG';
  }

  if (isText(child)) {
    // Text hugs vertically so it can grow when the width changes.
    v = 'HUG';
  } else if (fillsHeight && mode === 'HORIZONTAL') {
    v = 'FILL';
  } else if (isFrame(child) && Math.abs(contentExtent(child, 'h') - child.rect.h) <= 1) {
    v = 'HUG';
  }

  // A wrapped grid's cards must keep their width or the wrap collapses.
  if (mode === 'WRAP' && h === 'FILL') h = 'FIXED';

  return { h, v };
}

/** The parent's own sizing, seen from inside: does it hug its children? */
export function decideSelfSizing(node: FrameNode, padding: [number, number, number, number]): {
  h: Sizing;
  v: Sizing;
} {
  const kids = node.children.filter((k) => !k.layout?.absolute);
  if (kids.length === 0) return node.layout.sizing;
  const contentRight = Math.max(...kids.map((k) => k.rect.x + k.rect.w)) + padding[1];
  const contentBottom = Math.max(...kids.map((k) => k.rect.y + k.rect.h)) + padding[2];
  return {
    h: Math.abs(contentRight - node.rect.w) <= 1 ? 'HUG' : node.layout.sizing.h,
    v: Math.abs(contentBottom - node.rect.h) <= 1 ? 'HUG' : node.layout.sizing.v,
  };
}
