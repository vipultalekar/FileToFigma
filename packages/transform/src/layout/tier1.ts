import type {
  Constraint,
  FrameNode,
  IRNode,
  LayoutSpec,
  Sizing,
} from '@web2figma/ir';
import { isFrame, isText } from '@web2figma/ir';
import type { WarningSink } from '@web2figma/shared';

/**
 * Tier 1: direct layout mapping (PRD section 7 stage 2).
 *
 * When the source element really is a flex or grid container, its own computed
 * values are better than anything geometry can infer, so this tier runs first
 * and claims confidence 1.0 for flex.
 */

function alignFromJustify(
  value: string,
  warn: (msg: string, fallback: string) => void,
): LayoutSpec['primaryAlign'] {
  switch (value) {
    case 'flex-start':
    case 'start':
    case 'left':
    case 'normal':
      return 'MIN';
    case 'center':
      return 'CENTER';
    case 'flex-end':
    case 'end':
    case 'right':
      return 'MAX';
    case 'space-between':
      return 'SPACE_BETWEEN';
    case 'space-around':
    case 'space-evenly':
      warn(`justify-content: ${value} has no Figma equivalent`, 'SPACE_BETWEEN');
      return 'SPACE_BETWEEN';
    default:
      return 'MIN';
  }
}

function alignFromItems(value: string): LayoutSpec['counterAlign'] {
  switch (value) {
    case 'center':
      return 'CENTER';
    case 'flex-end':
    case 'end':
      return 'MAX';
    case 'baseline':
    case 'first baseline':
      return 'BASELINE';
    default:
      // stretch and flex-start both anchor to MIN; stretch additionally makes
      // children FILL on the counter axis, handled by the caller.
      return 'MIN';
  }
}

/** Is this child's declared size a fill instruction (100%, flex: 1, stretch)? */
function declaredFill(child: IRNode, axis: 'w' | 'h'): boolean {
  const declared = child.meta.declaredSize?.[axis] ?? '';
  return declared === '100%' || declared === '-webkit-fill-available' || declared === 'stretch';
}

function declaredHug(child: IRNode, axis: 'w' | 'h'): boolean {
  const declared = child.meta.declaredSize?.[axis] ?? '';
  return declared === 'fit-content' || declared === 'min-content' || declared === 'max-content' || declared === 'auto';
}

export function childSizingFromFlex(
  parent: FrameNode,
  child: IRNode,
  mainAxis: 'h' | 'v',
): { h: Sizing; v: Sizing } {
  const flex = child.meta.flex;
  const parentFlex = parent.meta.flex;
  const grow = flex?.grow ?? 0;
  const alignSelf = flex?.alignSelf ?? parentFlex?.alignItems ?? 'stretch';

  const main: Sizing =
    grow > 0 || declaredFill(child, mainAxis === 'h' ? 'w' : 'h')
      ? 'FILL'
      : isText(child)
        ? 'HUG'
        : declaredHug(child, mainAxis === 'h' ? 'w' : 'h') && isFrame(child)
          ? 'HUG'
          : 'FIXED';

  const counterAxisKey = mainAxis === 'h' ? 'h' : 'w';
  const counterDeclared = child.meta.declaredSize?.[counterAxisKey];
  const hasFixedCounter = Boolean(
    counterDeclared &&
      counterDeclared !== 'auto' &&
      counterDeclared !== '100%' &&
      !counterDeclared.endsWith('%'),
  );
  const stretched = !hasFixedCounter && (alignSelf === 'stretch' || (alignSelf === 'normal' && !counterDeclared));
  const counter: Sizing = stretched
    ? 'FILL'
    : isText(child)
      ? 'HUG'
      : declaredHug(child, counterAxisKey) && isFrame(child)
        ? 'HUG'
        : 'FIXED';

  return mainAxis === 'h' ? { h: main, v: counter } : { h: counter, v: main };
}

/** position: absolute -> Figma constraints derived from the CSS inset values. */
export function constraintsFromInset(child: IRNode): { h: Constraint; v: Constraint } {
  const inset = child.meta.inset;
  const auto = (v: string | undefined): boolean => !v || v === 'auto';

  // If an element has small fixed dimensions (e.g. icon, FAB, badge) but left & right are set,
  // it was likely centered or aligned, not meant to stretch across the viewport.
  const hasFixedSizeH = Boolean(
    child.meta.declaredSize?.w &&
      child.meta.declaredSize.w !== '100%' &&
      !child.meta.declaredSize.w.endsWith('%'),
  );
  const hasFixedSizeV = Boolean(
    child.meta.declaredSize?.h &&
      child.meta.declaredSize.h !== '100%' &&
      !child.meta.declaredSize.h.endsWith('%'),
  );

  const h: Constraint = !auto(inset?.left) && !auto(inset?.right)
    ? hasFixedSizeH || child.rect.w < 120 ? 'CENTER' : 'STRETCH'
    : !auto(inset?.right) && auto(inset?.left)
      ? 'MAX'
      : 'MIN';
  const v: Constraint = !auto(inset?.top) && !auto(inset?.bottom)
    ? hasFixedSizeV || child.rect.h < 120 ? 'CENTER' : 'STRETCH'
    : !auto(inset?.bottom) && auto(inset?.top)
      ? 'MAX'
      : 'MIN';
  return { h, v };
}

export function isAbsolutelyPositioned(node: IRNode): boolean {
  const p = node.meta.position ?? 'static';
  return p === 'absolute' || p === 'fixed';
}

/**
 * Map a flex container. Returns null when the node is not a flex container, so
 * the caller can fall through to grid or to Tier 2.
 */
export function mapFlex(
  node: FrameNode,
  paddingBox: [number, number, number, number],
  warnings?: WarningSink,
): LayoutSpec | null {
  const flex = node.meta.flex;
  const display = node.meta.display ?? '';
  if (!flex || !/flex/.test(display)) return null;

  const reversed = flex.direction.endsWith('-reverse');
  const horizontal = flex.direction.startsWith('row');
  const wraps = flex.wrap === 'wrap' || flex.wrap === 'wrap-reverse';

  const warn = (msg: string, fallback: string): void =>
    warnings?.degraded(node.id, 'justify-content', msg, fallback);

  const spec: LayoutSpec = {
    mode: wraps ? 'WRAP' : horizontal ? 'HORIZONTAL' : 'VERTICAL',
    padding: paddingBox,
    itemSpacing: horizontal ? flex.columnGap : flex.rowGap,
    primaryAlign: alignFromJustify(flex.justifyContent, warn),
    counterAlign: alignFromItems(flex.alignItems),
    sizing: node.layout.sizing,
    confidence: 1,
    reason: 'flex',
  };
  if (wraps) {
    spec.counterAxisSpacing = horizontal ? flex.rowGap : flex.columnGap;
    // Figma only wraps horizontal auto layout.
    if (!horizontal) {
      spec.mode = 'VERTICAL';
      warnings?.degraded(
        node.id,
        'flex-wrap',
        'column wrap has no Figma equivalent',
        'VERTICAL',
      );
    }
  }

  if (reversed) {
    node.children = [...node.children].reverse();
    warnings?.info(node.id, 'flex-direction', `${flex.direction} emitted as reversed children`);
  }

  const mainAxis: 'h' | 'v' = spec.mode === 'VERTICAL' ? 'v' : 'h';
  for (const child of node.children) {
    if (isAbsolutelyPositioned(child)) {
      child.layout = {
        ...child.layout,
        absolute: true,
        constraints: constraintsFromInset(child),
        confidence: 1,
        reason: 'flex',
      };
      continue;
    }
    child.layout = {
      ...child.layout,
      sizing: childSizingFromFlex(node, child, mainAxis),
    };
  }

  return spec;
}

/**
 * Map a grid container (PRD section 7): a single row or column becomes the
 * matching auto layout; a true 2D grid becomes a vertical stack of row frames.
 * Spanning cells that break the row structure fall back to absolute.
 */
export function mapGrid(
  node: FrameNode,
  paddingBox: [number, number, number, number],
  warnings?: WarningSink,
): { spec: LayoutSpec; rows?: IRNode[][] } | null {
  const grid = node.meta.grid;
  const display = node.meta.display ?? '';
  if (!grid || !/grid/.test(display)) return null;

  const cols = grid.templateColumns.length || 1;
  const rows = grid.templateRows.length || 1;

  const placed = node.children.filter((c) => !isAbsolutelyPositioned(c));

  if (rows <= 1 || cols <= 1) {
    const horizontal = rows <= 1 && cols > 1;
    const spec: LayoutSpec = {
      mode: horizontal ? 'HORIZONTAL' : 'VERTICAL',
      padding: paddingBox,
      itemSpacing: horizontal ? grid.columnGap : grid.rowGap,
      primaryAlign: 'MIN',
      counterAlign: grid.alignItems === 'center' ? 'CENTER' : 'MIN',
      sizing: node.layout.sizing,
      confidence: 0.8,
      reason: 'grid',
    };
    for (const child of placed) {
      child.layout = {
        ...child.layout,
        sizing: horizontal
          ? { h: 'FILL', v: grid.alignItems === 'stretch' ? 'FILL' : 'HUG' }
          : { h: 'FILL', v: 'HUG' },
      };
    }
    return { spec };
  }

  // 2D: group children by their resolved grid row.
  const byRow = new Map<number, IRNode[]>();
  let spanning = false;
  for (const child of placed) {
    const cell = child.meta.grid?.cell;
    if (!cell) {
      spanning = true;
      break;
    }
    if (cell.rowEnd - cell.rowStart > 1) spanning = true;
    const list = byRow.get(cell.rowStart) ?? [];
    list.push(child);
    byRow.set(cell.rowStart, list);
  }

  if (spanning || byRow.size === 0) {
    warnings?.degraded(
      node.id,
      'display: grid',
      'grid has spanning cells that break the row structure',
      'absolute children',
    );
    return {
      spec: {
        mode: 'NONE',
        padding: [0, 0, 0, 0],
        itemSpacing: 0,
        primaryAlign: 'MIN',
        counterAlign: 'MIN',
        sizing: node.layout.sizing,
        confidence: 0.4,
        reason: 'grid',
      },
    };
  }

  const ordered = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, kids]) => kids);
  const spec: LayoutSpec = {
    mode: 'VERTICAL',
    padding: paddingBox,
    itemSpacing: grid.rowGap,
    primaryAlign: 'MIN',
    counterAlign: 'MIN',
    sizing: node.layout.sizing,
    confidence: 0.8,
    reason: 'grid',
  };
  return { spec, rows: ordered };
}
