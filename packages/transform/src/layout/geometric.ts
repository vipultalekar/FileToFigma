import type { FrameNode, IRNode, LayoutSpec } from '@web2figma/ir';
import { isFrame } from '@web2figma/ir';
import type { WarningSink } from '@web2figma/shared';
import {
  THRESHOLD,
  detectWrap,
  gapRegularity,
  gapsBetween,
  mean,
  scoreAxis,
} from './score.js';
import {
  decideSizing,
  derivePadding,
  derivePrimaryAlign,
  deriveCounterAlign,
} from './sizing.js';

/**
 * Tier 2: geometric layout inference (PRD section 7 stage 3).
 *
 * Everything that is not flex or grid arrives here: block, inline-block,
 * tables, floats, and the whole of the pre-flexbox web.
 */

export interface InferOptions {
  threshold?: number;
  warnings?: WarningSink;
}

function fallbackAbsolute(parent: FrameNode, confidence: number): LayoutSpec {
  for (const child of parent.children) {
    child.layout = { ...child.layout, absolute: true, constraints: { h: 'MIN', v: 'MIN' } };
  }
  return {
    mode: 'NONE',
    padding: [0, 0, 0, 0],
    itemSpacing: 0,
    primaryAlign: 'MIN',
    counterAlign: 'MIN',
    sizing: parent.layout.sizing,
    confidence,
    reason: 'fallback',
  };
}

function inferSingleChild(parent: FrameNode, child: IRNode): LayoutSpec {
  const { padding } = derivePadding(parent, [child]);
  // A single child is a vertical stack of one: the padding is the information,
  // and VERTICAL keeps the frame editable without inventing a direction.
  const spec: LayoutSpec = {
    mode: 'VERTICAL',
    padding,
    itemSpacing: 0,
    primaryAlign: 'MIN',
    counterAlign: deriveCounterAlign(parent, [child], 'VERTICAL'),
    sizing: parent.layout.sizing,
    confidence: 0.9,
    reason: 'single',
  };
  child.layout = { ...child.layout, sizing: decideSizing(parent, child, padding, 'VERTICAL') };
  return spec;
}

export function inferLayout(parent: FrameNode, options: InferOptions = {}): LayoutSpec {
  const threshold = options.threshold ?? THRESHOLD;
  const kids = parent.children.filter((k) => !k.layout?.absolute);

  if (kids.length === 0) {
    return {
      mode: 'NONE',
      padding: [0, 0, 0, 0],
      itemSpacing: 0,
      primaryAlign: 'MIN',
      counterAlign: 'MIN',
      sizing: parent.layout.sizing,
      confidence: 1,
      reason: 'leaf',
    };
  }
  if (kids.length === 1) return inferSingleChild(parent, kids[0] as IRNode);

  const wrap = detectWrap(kids);
  if (wrap.isWrap) {
    const { padding, overflow } = derivePadding(parent, kids);
    if (overflow) {
      options.warnings?.info(parent.id, 'layout', 'a child overflows its parent box');
    }
    for (const child of kids) {
      child.layout = { ...child.layout, sizing: decideSizing(parent, child, padding, 'WRAP') };
    }
    return {
      mode: 'WRAP',
      padding,
      itemSpacing: wrap.itemSpacing,
      counterAxisSpacing: wrap.rowSpacing,
      primaryAlign: 'MIN',
      counterAlign: 'MIN',
      sizing: parent.layout.sizing,
      confidence: 0.75,
      reason: 'geometric',
    };
  }

  const v = scoreAxis(kids, 'vertical');
  const h = scoreAxis(kids, 'horizontal');
  const best = v.score >= h.score ? v : h;

  if (best.score < threshold) {
    options.warnings?.degraded(
      parent.id,
      'layout',
      `no defensible axis (best score ${best.score.toFixed(2)})`,
      'absolute positioning',
    );
    return fallbackAbsolute(parent, best.score);
  }

  const mode = best.axis === 'vertical' ? 'VERTICAL' : 'HORIZONTAL';
  const { padding, overflow } = derivePadding(parent, kids);
  if (overflow) options.warnings?.info(parent.id, 'layout', 'a child overflows its parent box');

  const gaps = gapsBetween(best.ordered, best.axis);
  const regular = gapRegularity(gaps);
  const itemSpacing = regular >= 0.85 ? Math.round(mean(gaps)) : 0;

  if (regular < 0.85) {
    // Figma has no per-child margin. Rather than silently flattening the rhythm,
    // spacing falls to 0 and the gaps live on as leading padding inside each
    // child frame, applied by applyIrregularGaps below.
    options.warnings?.info(
      parent.id,
      'gap',
      `irregular gaps (regularity ${regular.toFixed(2)})`,
      'per-child spacing',
    );
    applyIrregularGaps(best.ordered, best.axis, gaps);
  }

  const primaryAlign = derivePrimaryAlign(parent, best.ordered, mode, gaps, padding);
  const counterAlign = deriveCounterAlign(parent, kids, mode);

  for (const child of kids) {
    child.layout = { ...child.layout, sizing: decideSizing(parent, child, padding, mode) };
  }

  // Children must be in layout order once the frame becomes auto layout.
  const absolutes = parent.children.filter((k) => k.layout?.absolute);
  parent.children = [...best.ordered, ...absolutes];

  return {
    mode,
    padding,
    itemSpacing,
    primaryAlign,
    counterAlign,
    sizing: parent.layout.sizing,
    confidence: Math.min(0.95, best.score),
    reason: 'geometric',
  };
}

/**
 * Convert uneven gaps into leading padding on each child frame. Only frames can
 * take padding, so a text or image child keeps its gap in the spacing average
 * instead; that is the compatibility escape the PRD calls for.
 */
function applyIrregularGaps(ordered: readonly IRNode[], axis: 'vertical' | 'horizontal', gaps: readonly number[]): void {
  for (let i = 1; i < ordered.length; i++) {
    const child = ordered[i] as IRNode;
    const gap = gaps[i - 1] ?? 0;
    if (gap <= 0 || !isFrame(child)) continue;
    const p = [...child.layout.padding] as [number, number, number, number];
    if (axis === 'vertical') p[0] += gap;
    else p[3] += gap;
    child.layout = { ...child.layout, padding: p };
  }
}
