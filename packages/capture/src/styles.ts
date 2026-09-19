import type { Effect, FlexInfo, GridInfo, NodeMeta, Paint, Stroke } from '@web2figma/ir';
import {
  backgroundToFills,
  blendMode as mapBlend,
  borderToStroke,
  boxShadowToEffects,
  clipsContent,
  cornerRadius,
  decomposeTransform,
  filterToEffects,
  rasteriseReason,
  toFigmaRotation,
} from '@web2figma/transform';

/**
 * Style extraction (PRD section 5).
 *
 * Capture never parses CSS text: it reads resolved values from
 * getComputedStyle and hands them to the pure mapping functions in the
 * transform package, so every CSS decision stays unit-testable in plain Node.
 */

export interface VisualStyles {
  fills: Paint[];
  strokes: Stroke[];
  nonUniformBorders: { side: 'top' | 'right' | 'bottom' | 'left'; width: number; color: string; style: string }[];
  corner: [number, number, number, number];
  effects: Effect[];
  clip: boolean;
  opacity: number;
  rotation?: number;
  blend?: string;
  /** Non-null when the subtree has to be rasterised. */
  rasterise: string | null;
  unsupportedFilters: string[];
}

export type UrlResolver = (url: string) => string | null;

const num = (v: string): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function extractVisualStyles(
  cs: CSSStyleDeclaration,
  box: { w: number; h: number },
  resolveAsset: UrlResolver,
  onDrop?: (property: string, detail: string) => void,
): VisualStyles {
  const fills = backgroundToFills(
    {
      color: cs.backgroundColor,
      image: cs.backgroundImage,
      size: cs.backgroundSize,
      position: cs.backgroundPosition,
      repeat: cs.backgroundRepeat,
      width: box.w,
      height: box.h,
    },
    resolveAsset,
    onDrop,
  );

  const border = borderToStroke({
    top: { width: num(cs.borderTopWidth), style: cs.borderTopStyle, color: cs.borderTopColor },
    right: { width: num(cs.borderRightWidth), style: cs.borderRightStyle, color: cs.borderRightColor },
    bottom: { width: num(cs.borderBottomWidth), style: cs.borderBottomStyle, color: cs.borderBottomColor },
    left: { width: num(cs.borderLeftWidth), style: cs.borderLeftStyle, color: cs.borderLeftColor },
  });

  const filter = filterToEffects(cs.filter, 'filter');
  const backdrop = filterToEffects(cs.backdropFilter ?? null, 'backdrop-filter');
  const effects: Effect[] = [
    ...boxShadowToEffects(cs.boxShadow),
    ...filter.effects,
    ...backdrop.effects,
  ];

  const decomposed = decomposeTransform(cs.transform);
  const rotation = decomposed && !decomposed.is3d && !decomposed.hasSkew
    ? toFigmaRotation(decomposed.rotationDeg)
    : undefined;

  const raster = rasteriseReason({
    transform: cs.transform,
    clipPath: cs.clipPath ?? null,
    maskImage: (cs as unknown as { maskImage?: string }).maskImage ?? null,
    writingMode: cs.writingMode,
    filter: cs.filter,
  });

  const blend = mapBlend(cs.mixBlendMode ?? null);

  const style: VisualStyles = {
    fills,
    strokes: border.stroke ? [border.stroke] : [],
    nonUniformBorders: border.nonUniform
      ? border.sides.map((s) => ({
          side: s.side,
          width: s.border.width,
          color: s.border.color,
          style: s.border.style,
        }))
      : [],
    corner: cornerRadius(
      [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      box.w,
      box.h,
    ),
    effects,
    clip: clipsContent(cs.overflow),
    opacity: Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1,
    rasterise: raster ?? (filter.unsupported.length > 0 ? `filter:${filter.unsupported[0]}` : null),
    unsupportedFilters: [...filter.unsupported, ...backdrop.unsupported],
  };
  if (rotation !== undefined) style.rotation = rotation;
  if (blend.mode !== 'NORMAL') style.blend = blend.mode;
  return style;
}

/* -------------------------------------------------------------- metadata -- */

function parseGap(value: string): number {
  if (value === 'normal' || value === '') return 0;
  return num(value);
}

export function extractFlex(cs: CSSStyleDeclaration): FlexInfo | undefined {
  if (!/flex/.test(cs.display)) return undefined;
  return {
    direction: (cs.flexDirection || 'row') as FlexInfo['direction'],
    wrap: (cs.flexWrap || 'nowrap') as FlexInfo['wrap'],
    justifyContent: cs.justifyContent || 'flex-start',
    alignItems: cs.alignItems || 'stretch',
    rowGap: parseGap(cs.rowGap),
    columnGap: parseGap(cs.columnGap),
  };
}

export function extractGrid(cs: CSSStyleDeclaration): GridInfo | undefined {
  if (!/grid/.test(cs.display)) return undefined;
  const split = (v: string): string[] =>
    v && v !== 'none' ? v.trim().split(/\s+/).filter(Boolean) : [];
  return {
    templateColumns: split(cs.gridTemplateColumns),
    templateRows: split(cs.gridTemplateRows),
    rowGap: parseGap(cs.rowGap),
    columnGap: parseGap(cs.columnGap),
    justifyContent: cs.justifyContent || 'start',
    alignItems: cs.alignItems || 'stretch',
  };
}

/** Per-child flex and grid placement, recorded on the child's own meta. */
export function extractChildPlacement(
  el: Element,
  cs: CSSStyleDeclaration,
  parentCs: CSSStyleDeclaration | null,
): { flex?: FlexInfo; grid?: GridInfo } {
  const out: { flex?: FlexInfo; grid?: GridInfo } = {};
  if (parentCs && /flex/.test(parentCs.display)) {
    out.flex = {
      direction: (parentCs.flexDirection || 'row') as FlexInfo['direction'],
      wrap: (parentCs.flexWrap || 'nowrap') as FlexInfo['wrap'],
      justifyContent: parentCs.justifyContent || 'flex-start',
      alignItems: parentCs.alignItems || 'stretch',
      rowGap: parseGap(parentCs.rowGap),
      columnGap: parseGap(parentCs.columnGap),
      grow: num(cs.flexGrow),
      shrink: num(cs.flexShrink),
      basis: cs.flexBasis,
      alignSelf: cs.alignSelf === 'auto' ? parentCs.alignItems : cs.alignSelf,
    };
  }
  if (parentCs && /grid/.test(parentCs.display)) {
    const cell = resolveGridCell(cs);
    out.grid = {
      templateColumns: [],
      templateRows: [],
      rowGap: parseGap(parentCs.rowGap),
      columnGap: parseGap(parentCs.columnGap),
      justifyContent: parentCs.justifyContent || 'start',
      alignItems: parentCs.alignItems || 'stretch',
      ...(cell ? { cell } : {}),
    };
  }
  void el;
  return out;
}

function resolveGridCell(cs: CSSStyleDeclaration): GridInfo['cell'] | undefined {
  const line = (v: string, fallback: number): number => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const rowStart = line(cs.gridRowStart, NaN);
  const colStart = line(cs.gridColumnStart, NaN);
  if (!Number.isFinite(rowStart) || !Number.isFinite(colStart)) return undefined;
  const rowEndRaw = cs.gridRowEnd;
  const colEndRaw = cs.gridColumnEnd;
  const span = (raw: string, start: number): number => {
    const m = /span\s+(\d+)/.exec(raw);
    if (m) return start + parseInt(m[1] as string, 10);
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : start + 1;
  };
  return {
    rowStart,
    rowEnd: span(rowEndRaw, rowStart),
    colStart,
    colEnd: span(colEndRaw, colStart),
  };
}

export function extractMeta(el: Element, cs: CSSStyleDeclaration, parentCs: CSSStyleDeclaration | null): NodeMeta {
  const zRaw = parseInt(cs.zIndex, 10);
  const placement = extractChildPlacement(el, cs, parentCs);
  const meta: NodeMeta = {
    tag: el.tagName.toLowerCase(),
    classes: typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : [],
    display: cs.display,
    position: cs.position,
    declaredSize: { w: cs.width, h: cs.height },
  };
  const role = el.getAttribute('role');
  if (role) meta.role = role;
  const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test-id');
  if (testId) meta.testId = testId;
  const aria = el.getAttribute('aria-label');
  if (aria) meta.ariaLabel = aria;
  const dataRole = el.getAttribute('data-role');
  if (dataRole) meta.dataRole = dataRole;
  const href = el.getAttribute('href');
  if (href) meta.href = href;
  if (Number.isFinite(zRaw)) meta.zIndex = zRaw;
  if (cs.position === 'absolute' || cs.position === 'fixed') {
    let top = cs.top;
    let right = cs.right;
    let bottom = cs.bottom;
    let left = cs.left;
    if (typeof (el as unknown as { computedStyleMap?: () => { get(k: string): { toString(): string } | undefined } }).computedStyleMap === 'function') {
      try {
        const map = (el as unknown as { computedStyleMap: () => { get(k: string): { toString(): string } | undefined } }).computedStyleMap();
        const t = map.get('top')?.toString();
        const r = map.get('right')?.toString();
        const b = map.get('bottom')?.toString();
        const l = map.get('left')?.toString();
        if (t === 'auto') top = 'auto';
        if (r === 'auto') right = 'auto';
        if (b === 'auto') bottom = 'auto';
        if (l === 'auto') left = 'auto';
      } catch {
        // Fall back to resolved cs
      }
    }
    meta.inset = { top, right, bottom, left };
  }
  const flexSelf = extractFlex(cs);
  if (flexSelf) {
    // The element is itself a flex container: keep its own container values and
    // add only the child-side properties its parent's layout will read.
    const child = placement.flex;
    meta.flex = child
      ? {
          ...flexSelf,
          grow: child.grow,
          shrink: child.shrink,
          basis: child.basis,
          alignSelf: child.alignSelf,
        }
      : flexSelf;
  } else if (placement.flex) {
    meta.flex = placement.flex;
  }
  const gridSelf = extractGrid(cs);
  if (gridSelf) meta.grid = { ...gridSelf, ...(placement.grid?.cell ? { cell: placement.grid.cell } : {}) };
  else if (placement.grid) meta.grid = placement.grid;
  return meta;
}
