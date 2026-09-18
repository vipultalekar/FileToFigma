import { MockNode, MockTextNode } from './nodes.js';

/**
 * A small auto layout solver for the mock.
 *
 * This is what makes the editability assertion real (PRD section 15 layer 4):
 * widen the root, re-solve, and check that nothing clips or overlaps. A mock
 * that only stored layout properties could not prove anything.
 */

function isAbsolute(node: MockNode): boolean {
  return node.layoutPositioning === 'ABSOLUTE';
}

function flowChildren(frame: MockNode): MockNode[] {
  return frame.children.filter((c) => !isAbsolute(c) && c.visible);
}

/** Intrinsic size of a node when it hugs its content. */
function hugSize(node: MockNode, availableWidth: number): { w: number; h: number } {
  if (node instanceof MockTextNode) {
    return node.measure(availableWidth);
  }
  if (node.layoutMode === 'NONE') return { w: node.width, h: node.height };
  const kids = flowChildren(node);
  if (kids.length === 0) {
    return {
      w: node.paddingLeft + node.paddingRight,
      h: node.paddingTop + node.paddingBottom,
    };
  }
  const horizontal = node.layoutMode === 'HORIZONTAL';
  let main = 0;
  let counter = 0;
  for (const kid of kids) {
    const size = { w: kid.width, h: kid.height };
    main += horizontal ? size.w : size.h;
    counter = Math.max(counter, horizontal ? size.h : size.w);
  }
  main += node.itemSpacing * (kids.length - 1);
  return horizontal
    ? {
        w: main + node.paddingLeft + node.paddingRight,
        h: counter + node.paddingTop + node.paddingBottom,
      }
    : {
        w: counter + node.paddingLeft + node.paddingRight,
        h: main + node.paddingTop + node.paddingBottom,
      };
}

/** Lay out one frame's children, then recurse. Call on the root after a resize. */
export function solveLayout(frame: MockNode): void {
  for (const child of frame.children) {
    if (child.children.length > 0 || child.layoutMode !== 'NONE') solveLayout(child);
  }
  if (frame.layoutMode === 'NONE') return;

  const kids = flowChildren(frame);
  if (kids.length === 0) return;

  const horizontal = frame.layoutMode === 'HORIZONTAL';
  const innerW = frame.width - frame.paddingLeft - frame.paddingRight;
  const innerH = frame.height - frame.paddingTop - frame.paddingBottom;

  // Sizing pass.
  for (const kid of kids) {
    const hug = hugSize(kid, innerW);
    if (kid.layoutSizingHorizontal === 'FILL' && !horizontal) kid.width = innerW;
    if (kid.layoutSizingVertical === 'FILL' && horizontal) kid.height = innerH;
    if (kid.layoutSizingHorizontal === 'HUG') kid.width = hug.w;
    if (kid.layoutSizingVertical === 'HUG') {
      kid.height = kid instanceof MockTextNode ? kid.measure(kid.width).h : hug.h;
    }
  }

  // Main-axis FILL splits the leftover space evenly.
  const fillers = kids.filter((k) =>
    horizontal ? k.layoutSizingHorizontal === 'FILL' : k.layoutSizingVertical === 'FILL',
  );
  const fixedMain = kids
    .filter((k) => !fillers.includes(k))
    .reduce((sum, k) => sum + (horizontal ? k.width : k.height), 0);
  const spacingTotal = frame.itemSpacing * (kids.length - 1);
  const free = (horizontal ? innerW : innerH) - fixedMain - spacingTotal;
  if (fillers.length > 0 && free > 0) {
    const each = free / fillers.length;
    for (const f of fillers) {
      if (horizontal) f.width = each;
      else f.height = each;
      if (f.layoutMode !== 'NONE' || f.children.length > 0) solveLayout(f);
      if (f instanceof MockTextNode && f.layoutSizingVertical === 'HUG') {
        f.height = f.measure(f.width).h;
      }
    }
  }

  // Wrapping.
  const rows: MockNode[][] = [];
  if (horizontal && frame.layoutWrap === 'WRAP') {
    let row: MockNode[] = [];
    let used = 0;
    for (const kid of kids) {
      const next = used + kid.width + (row.length > 0 ? frame.itemSpacing : 0);
      if (row.length > 0 && next > innerW) {
        rows.push(row);
        row = [kid];
        used = kid.width;
      } else {
        row.push(kid);
        used = next;
      }
    }
    if (row.length > 0) rows.push(row);
  } else {
    rows.push(kids);
  }

  // Placement.
  let cursorCounter = horizontal ? frame.paddingTop : frame.paddingLeft;
  const rowSpacing = frame.counterAxisSpacing ?? frame.itemSpacing;

  for (const row of rows) {
    const contentMain = row.reduce((sum, k) => sum + (horizontal ? k.width : k.height), 0);
    const gaps = row.length - 1;
    const available = horizontal ? innerW : innerH;
    let spacing = frame.itemSpacing;
    let start = horizontal ? frame.paddingLeft : frame.paddingTop;

    const slack = available - contentMain - spacing * gaps;
    if (frame.primaryAxisAlignItems === 'CENTER') start += slack / 2;
    else if (frame.primaryAxisAlignItems === 'MAX') start += slack;
    else if (frame.primaryAxisAlignItems === 'SPACE_BETWEEN' && gaps > 0) {
      spacing = (available - contentMain) / gaps;
    }

    let cursor = start;
    const rowCounterExtent = Math.max(...row.map((k) => (horizontal ? k.height : k.width)));

    for (const kid of row) {
      const mainSize = horizontal ? kid.width : kid.height;
      const counterSize = horizontal ? kid.height : kid.width;
      const counterExtent = rows.length > 1 ? rowCounterExtent : horizontal ? innerH : innerW;
      let counterOffset = cursorCounter;
      if (frame.counterAxisAlignItems === 'CENTER') {
        counterOffset += (counterExtent - counterSize) / 2;
      } else if (frame.counterAxisAlignItems === 'MAX') {
        counterOffset += counterExtent - counterSize;
      }

      if (horizontal) {
        kid.x = cursor;
        kid.y = counterOffset;
      } else {
        kid.y = cursor;
        kid.x = counterOffset;
      }
      cursor += mainSize + spacing;
    }
    cursorCounter += rowCounterExtent + rowSpacing;
  }

  // Frames that hug grow to fit what was just laid out.
  if (frame.layoutSizingHorizontal === 'HUG' || frame.layoutSizingVertical === 'HUG') {
    const hug = hugSize(frame, innerW);
    if (frame.layoutSizingHorizontal === 'HUG') frame.width = hug.w;
    if (frame.layoutSizingVertical === 'HUG') frame.height = hug.h;
  }
}

/** Resize the root and re-solve, the M2/M4 editability check. */
export function resizeAndReflow(root: MockNode, deltaWidth: number): void {
  root.width += deltaWidth;
  solveLayout(root);
}

export interface OverlapReport {
  overlaps: { a: string; b: string }[];
  clipped: { name: string; by: string }[];
}

function rectsOverlap(a: MockNode, b: MockNode): boolean {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const eps = 0.5;
  return a.x < bx2 - eps && ax2 > b.x + eps && a.y < by2 - eps && ay2 > b.y + eps;
}

/** No sibling overlaps, no child sticking out of an auto layout parent. */
export function checkEditability(root: MockNode): OverlapReport {
  const report: OverlapReport = { overlaps: [], clipped: [] };

  const visit = (frame: MockNode): void => {
    const kids = flowChildren(frame);
    if (frame.layoutMode !== 'NONE') {
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i] as MockNode;
          const b = kids[j] as MockNode;
          if (rectsOverlap(a, b)) report.overlaps.push({ a: a.name, b: b.name });
        }
      }
      for (const kid of kids) {
        const overflowRight = kid.x + kid.width > frame.width - frame.paddingRight + 0.5;
        const overflowBottom = kid.y + kid.height > frame.height - frame.paddingBottom + 0.5;
        if (frame.clipsContent && (overflowRight || overflowBottom)) {
          report.clipped.push({ name: kid.name, by: frame.name });
        }
      }
    }
    for (const kid of frame.children) visit(kid);
  };

  visit(root);
  return report;
}
