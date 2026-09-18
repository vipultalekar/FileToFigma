import type { IRNode } from '@web2figma/ir';

/**
 * Axis scoring for Tier 2 geometric inference (PRD section 7 stage 3).
 *
 *   score = 0.5 * separation + 0.3 * alignment + 0.2 * gapRegularity
 *
 * separation      fraction of adjacent pairs whose ranges do not overlap
 * alignment       fraction of children sharing an edge or centre
 * gapRegularity   1 - stdev(gaps) / mean(gaps), clamped
 */

export const EDGE_TOLERANCE = 2;
export const OVERLAP_TOLERANCE = 2;
export const THRESHOLD = 0.65;

export type Axis = 'vertical' | 'horizontal';

export interface AxisScore {
  axis: Axis;
  score: number;
  separation: number;
  alignment: number;
  gapRegularity: number;
  /** Children sorted along the axis. */
  ordered: IRNode[];
  gaps: number[];
  meanGap: number;
}

const start = (n: IRNode, axis: Axis): number => (axis === 'vertical' ? n.rect.y : n.rect.x);
const size = (n: IRNode, axis: Axis): number => (axis === 'vertical' ? n.rect.h : n.rect.w);
const end = (n: IRNode, axis: Axis): number => start(n, axis) + size(n, axis);

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/** Fraction of adjacent pairs that do not overlap on the axis. */
export function separation(ordered: readonly IRNode[], axis: Axis): number {
  if (ordered.length < 2) return 1;
  let clean = 0;
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1] as IRNode;
    const cur = ordered[i] as IRNode;
    if (start(cur, axis) >= end(prev, axis) - OVERLAP_TOLERANCE) clean++;
  }
  return clean / (ordered.length - 1);
}

/** Fraction of children sharing a leading edge, trailing edge or centre on the counter axis. */
export function alignment(children: readonly IRNode[], axis: Axis): number {
  if (children.length < 2) return 1;
  const counter: Axis = axis === 'vertical' ? 'horizontal' : 'vertical';
  const leading = children.map((c) => start(c, counter));
  const trailing = children.map((c) => end(c, counter));
  const centres = children.map((c) => start(c, counter) + size(c, counter) / 2);

  const share = (values: number[]): number => {
    let best = 0;
    for (const v of values) {
      const n = values.filter((o) => Math.abs(o - v) <= EDGE_TOLERANCE).length;
      best = Math.max(best, n);
    }
    return best / values.length;
  };

  return Math.max(share(leading), share(trailing), share(centres));
}

export function gapsBetween(ordered: readonly IRNode[], axis: Axis): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1] as IRNode;
    const cur = ordered[i] as IRNode;
    gaps.push(Math.max(0, start(cur, axis) - end(prev, axis)));
  }
  return gaps;
}

export function gapRegularity(gaps: readonly number[]): number {
  if (gaps.length < 2) return 1;
  const m = mean(gaps);
  return 1 - Math.min(1, stdev(gaps) / Math.max(1, m));
}

export function scoreAxis(children: readonly IRNode[], axis: Axis): AxisScore {
  const ordered = [...children].sort((a, b) => start(a, axis) - start(b, axis));
  const sep = separation(ordered, axis);
  const align = alignment(ordered, axis);
  const gaps = gapsBetween(ordered, axis);
  const regularity = gapRegularity(gaps);
  return {
    axis,
    score: 0.5 * sep + 0.3 * align + 0.2 * regularity,
    separation: sep,
    alignment: align,
    gapRegularity: regularity,
    ordered,
    gaps,
    meanGap: mean(gaps),
  };
}

export interface WrapAnalysis {
  isWrap: boolean;
  rows: IRNode[][];
  rowSpacing: number;
  itemSpacing: number;
}

/**
 * Card grids: multiple rows of roughly equal height with consistent horizontal
 * gaps. WRAP is much nicer to edit than nested row frames (PRD section 7).
 */
export function detectWrap(children: readonly IRNode[]): WrapAnalysis {
  const none: WrapAnalysis = { isWrap: false, rows: [], rowSpacing: 0, itemSpacing: 0 };
  if (children.length < 4) return none;

  const sorted = [...children].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const rows: IRNode[][] = [];
  let current: IRNode[] = [];
  let rowTop = sorted[0]!.rect.y;

  for (const child of sorted) {
    if (current.length === 0 || Math.abs(child.rect.y - rowTop) <= Math.max(4, child.rect.h * 0.3)) {
      current.push(child);
      rowTop = current[0]!.rect.y;
    } else {
      rows.push(current);
      current = [child];
      rowTop = child.rect.y;
    }
  }
  if (current.length > 0) rows.push(current);

  if (rows.length < 2) return none;
  if (rows.some((r) => r.length < 2)) {
    // A trailing partial row is normal for a wrapped grid; anything else is not.
    const partial = rows.filter((r) => r.length < 2);
    if (partial.length > 1 || partial[0] !== rows[rows.length - 1]) return none;
  }

  const heights = rows.flat().map((c) => c.rect.h);
  if (stdev(heights) > Math.max(4, mean(heights) * 0.25)) return none;

  const rowGaps: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prevBottom = Math.max(...rows[i - 1]!.map((c) => c.rect.y + c.rect.h));
    const top = Math.min(...rows[i]!.map((c) => c.rect.y));
    rowGaps.push(Math.max(0, top - prevBottom));
  }

  const itemGaps: number[] = [];
  for (const row of rows) {
    const ordered = [...row].sort((a, b) => a.rect.x - b.rect.x);
    for (let i = 1; i < ordered.length; i++) {
      itemGaps.push(
        Math.max(0, ordered[i]!.rect.x - (ordered[i - 1]!.rect.x + ordered[i - 1]!.rect.w)),
      );
    }
  }
  if (gapRegularity(itemGaps) < 0.8) return none;

  return {
    isWrap: true,
    rows,
    rowSpacing: Math.round(mean(rowGaps)),
    itemSpacing: Math.round(mean(itemGaps)),
  };
}
