import type { FrameNode, IRNode, TextNode, TextSegment } from '@web2figma/ir';
import { isFrame, isText } from '@web2figma/ir';

/**
 * Pass 5: merge adjacent inline text runs (PRD section 7).
 *
 * Capture emits one text node per text run so that ranged styles survive. A
 * paragraph containing three <span>s should reach Figma as one editable text
 * node with three segments, not three overlapping layers.
 */

const LINE_TOLERANCE = 4;

function sameLineOrNext(a: TextNode, b: TextNode): boolean {
  const aBottom = a.rect.y + a.rect.h;
  const sameLine = Math.abs(a.rect.y - b.rect.y) <= LINE_TOLERANCE;
  const nextLine = b.rect.y >= a.rect.y - LINE_TOLERANCE && b.rect.y <= aBottom + LINE_TOLERANCE;
  return sameLine || nextLine;
}

function joiner(a: TextNode, b: TextNode): string {
  // Runs already carry their own leading/trailing spaces where the DOM had
  // them; only insert a separator when neither side has one.
  const endsWithSpace = /\s$/.test(a.characters);
  const startsWithSpace = /^\s/.test(b.characters);
  if (endsWithSpace || startsWithSpace) return '';
  const wrapped = b.rect.y > a.rect.y + LINE_TOLERANCE;
  return wrapped ? ' ' : '';
}

function unionRect(a: TextNode, b: TextNode): TextNode['rect'] {
  const x = Math.min(a.rect.x, b.rect.x);
  const y = Math.min(a.rect.y, b.rect.y);
  const right = Math.max(a.rect.x + a.rect.w, b.rect.x + b.rect.w);
  const bottom = Math.max(a.rect.y + a.rect.h, b.rect.y + b.rect.h);
  return { x, y, w: right - x, h: bottom - y };
}

function shiftSegments(segments: TextSegment[], offset: number): TextSegment[] {
  return segments.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset }));
}

function mergePair(a: TextNode, b: TextNode): TextNode {
  const glue = joiner(a, b);
  const offset = a.characters.length + glue.length;
  return {
    ...a,
    characters: a.characters + glue + b.characters,
    segments: [...a.segments, ...shiftSegments(b.segments, offset)],
    rect: unionRect(a, b),
    // The merged node keeps the first run's paragraph style; segments carry the
    // per-run differences.
    name: a.name,
  };
}

/** Text runs merge only when nothing visual sits between them. */
function mergeable(a: IRNode, b: IRNode): boolean {
  if (!isText(a) || !isText(b)) return false;
  if (a.meta.pseudo || b.meta.pseudo) return false;
  if (a.style.align !== b.style.align) return false;
  if ((a.rotation ?? 0) !== (b.rotation ?? 0)) return false;
  if (a.layout?.absolute || b.layout?.absolute) return false;
  return sameLineOrNext(a, b);
}

export function mergeTextRuns(root: IRNode): IRNode {
  if (!isFrame(root)) return root;
  const frame = root as FrameNode;

  const merged: IRNode[] = [];
  for (const child of frame.children) {
    const prev = merged[merged.length - 1];
    if (prev && mergeable(prev, child)) {
      merged[merged.length - 1] = mergePair(prev as TextNode, child as TextNode);
      continue;
    }
    merged.push(child);
  }

  frame.children = merged.map((c) => mergeTextRuns(c));
  return frame;
}
