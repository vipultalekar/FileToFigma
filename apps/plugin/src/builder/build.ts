import type {
  ConversionReport,
  FrameNode as IRFrame,
  IRDocument,
  IRNode,
  ImageNode as IRImage,
  LayoutSpec,
  TextNode as IRText,
  VectorNode as IRVector,
  Warning,
} from '@web2figma/ir';
import { LAYOUT_CONFIDENCE_THRESHOLD, isFrame, isImage, isText, isVector, walk } from '@web2figma/ir';
import { WarningSink } from '@web2figma/shared';
import { collectFonts, resolveFont, type AvailableFont } from './fonts.js';
import { applyStrokes, toFigmaEffect, toFigmaPaints, type ImageHashMap } from './paints.js';

/**
 * The builder (PRD section 8). It walks the final IR and creates nodes; it
 * contains no heuristics. Every failure here is a bug in an earlier module.
 *
 * The order of operations is not negotiable:
 *   1 load every font   2 register every image   3 create the tree top-down
 *   4 auto layout bottom-up   5 absolute positioning last   6 zoom to result
 */

const BATCH = 50;

export interface BuildOptions {
  /** Emitted after every batch so the UI can show real progress. */
  onProgress?: (done: number, total: number, stage: string) => void;
  /** Below this, layout is still applied but a warning is recorded. */
  confidenceThreshold?: number;
}

interface BuiltNode {
  ir: IRNode;
  node: SceneNode;
}

export async function buildDocument(
  doc: IRDocument,
  options: BuildOptions = {},
): Promise<{ root: FrameNode; report: ConversionReport }> {
  const started = Date.now();
  const warnings = new WarningSink();
  warnings.absorb(doc.warnings);
  const threshold = options.confidenceThreshold ?? LAYOUT_CONFIDENCE_THRESHOLD;
  const total = countNodes(doc.root);
  let done = 0;
  const nodesCreated: Record<string, number> = {};

  const tick = async (stage: string): Promise<void> => {
    done++;
    if (done % BATCH === 0) {
      options.onProgress?.(done, total, stage);
      // Yield so Figma can paint; never go more than ~100ms without this.
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  /* 1 -- fonts. Setting characters before the font is loaded throws. */
  options.onProgress?.(0, total, 'fonts');
  const requests = collectFonts(doc);
  const available = (await figma.listAvailableFontsAsync()).map(
    (f): AvailableFont => ({ family: f.fontName.family, style: f.fontName.style }),
  );
  const substitutions: { requested: string; resolved: string }[] = [];
  for (const request of requests) {
    const { resolved, substituted } = resolveFont(request, available);
    request.resolved = resolved;
    if (substituted) {
      substitutions.push({
        requested: `${request.family} ${request.weight}${request.italic ? ' italic' : ''}`,
        resolved: `${resolved.family} ${resolved.style}`,
      });
    }
  }
  const unique = new Map<string, FontName>();
  for (const r of requests) {
    if (!r.resolved) continue;
    unique.set(`${r.resolved.family}|${r.resolved.style}`, r.resolved as FontName);
  }
  unique.set('Inter|Regular', { family: 'Inter', style: 'Regular' });
  await Promise.all(
    [...unique.values()].map(async (font) => {
      try {
        await figma.loadFontAsync(font);
      } catch {
        warnings.push('', 'degraded', 'font', `could not load ${font.family} ${font.style}`, 'Inter Regular');
      }
    }),
  );

  /* 2 -- images. */
  options.onProgress?.(0, total, 'images');
  const images: ImageHashMap = new Map();
  for (const [assetId, asset] of Object.entries(doc.images)) {
    try {
      const bytes = base64ToBytes(asset.bytes);
      const image = figma.createImage(bytes);
      images.set(assetId, image.hash);
    } catch (err) {
      warnings.dropped(assetId, 'image', `could not register asset: ${errorText(err)}`);
    }
  }

  /* 3 -- tree, top-down. */
  options.onProgress?.(0, total, 'nodes');
  const built: BuiltNode[] = [];
  const byIrId = new Map<string, SceneNode>();

  const create = async (ir: IRNode, parent: FrameNode | null): Promise<SceneNode | null> => {
    let node: SceneNode | null = null;
    try {
      node = await createNode(ir, images, warnings);
    } catch (err) {
      warnings.dropped(ir.id, 'build', `node build threw: ${errorText(err)}`, 'placeholder rectangle');
      node = placeholder(ir);
    }
    if (!node) return null;

    node.name = ir.name;
    parent?.appendChild(node);
    // x/y are parent-relative, which is what Figma wants after appendChild.
    node.x = Math.round(ir.rect.x);
    node.y = Math.round(ir.rect.y);
    if (ir.opacity < 0.999 && 'opacity' in node) node.opacity = ir.opacity;
    if (ir.blendMode && 'blendMode' in node) node.blendMode = ir.blendMode as BlendMode;

    nodesCreated[ir.kind] = (nodesCreated[ir.kind] ?? 0) + 1;
    built.push({ ir, node });
    byIrId.set(ir.id, node);
    // Keep confidence and reason for the escape hatches (PRD section 12).
    if (ir.layout) {
      node.setPluginData('w2f', JSON.stringify({
        confidence: ir.layout.confidence,
        reason: ir.layout.reason,
        id: ir.id,
      }));
    }
    await tick('nodes');

    if (isFrame(ir) && node.type === 'FRAME') {
      for (const child of ir.children) await create(child, node);
    }
    return node;
  };

  const root = (await create(doc.root, null)) as FrameNode;

  /* 4 -- auto layout, bottom-up: sizing throws unless the parent has a mode. */
  options.onProgress?.(done, total, 'layout');
  for (let i = built.length - 1; i >= 0; i--) {
    const entry = built[i] as BuiltNode;
    if (!isFrame(entry.ir) || entry.node.type !== 'FRAME') continue;
    applyLayout(entry.node, entry.ir, warnings, threshold);
  }

  /* 5 -- child sizing, then absolute positioning last. */
  for (const { ir, node } of built) {
    const parent = node.parent;
    if (!parent || parent.type !== 'FRAME') continue;
    applyChildSizing(node, ir, parent, warnings);
  }
  for (const { ir, node } of built) {
    if (!ir.layout?.absolute) continue;
    const parent = node.parent;
    if (!parent || parent.type !== 'FRAME' || parent.layoutMode === 'NONE') continue;
    try {
      (node as SceneNode & LayoutMixin & { layoutPositioning: 'AUTO' | 'ABSOLUTE' }).layoutPositioning =
        'ABSOLUTE';
      node.x = Math.round(ir.rect.x);
      node.y = Math.round(ir.rect.y);
      if ('constraints' in node && ir.layout.constraints) {
        (node as ConstraintMixin).constraints = {
          horizontal: toConstraint(ir.layout.constraints.h),
          vertical: toConstraint(ir.layout.constraints.v),
        };
      }
    } catch (err) {
      warnings.degraded(ir.id, 'position', `absolute positioning failed: ${errorText(err)}`);
    }
  }

  /* 6 -- show the user what was built. */
  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);

  const frames = [...walk(doc.root)].filter(isFrame);
  const byReason: Record<string, number> = {};
  let withLayout = 0;
  for (const f of frames) {
    if (f.layout.mode === 'NONE') continue;
    withLayout++;
    byReason[f.layout.reason] = (byReason[f.layout.reason] ?? 0) + 1;
  }

  const report: ConversionReport = {
    nodesCreated,
    autoLayoutCoverage: { frames: frames.length, withLayout, byReason },
    fontSubstitutions: substitutions,
    warnings: warnings.all as Warning[],
    elapsedMs: Date.now() - started,
  };
  options.onProgress?.(total, total, 'done');
  return { root, report };
}

/* ------------------------------------------------------------ node kinds -- */

async function createNode(
  ir: IRNode,
  images: ImageHashMap,
  warnings: WarningSink,
): Promise<SceneNode | null> {
  if (isText(ir)) return createTextNode(ir, images, warnings);
  if (isVector(ir)) return createVectorNode(ir, warnings);
  if (isImage(ir)) return createImageNode(ir, images, warnings);
  return createFrameNode(ir, images);
}

function createFrameNode(ir: IRFrame, images: ImageHashMap): FrameNode {
  const frame = figma.createFrame();
  frame.resizeWithoutConstraints(Math.max(0.01, ir.rect.w), Math.max(0.01, ir.rect.h));
  frame.fills = toFigmaPaints(ir.fills, images);
  frame.clipsContent = ir.clip;
  applyStrokes(frame, ir.strokes, images);
  if (ir.corner.some((c) => c > 0)) {
    frame.topLeftRadius = ir.corner[0];
    frame.topRightRadius = ir.corner[1];
    frame.bottomRightRadius = ir.corner[2];
    frame.bottomLeftRadius = ir.corner[3];
  }
  if (ir.effects.length > 0) frame.effects = ir.effects.map(toFigmaEffect);
  if (ir.rotation) frame.rotation = -ir.rotation;
  return frame;
}

function createTextNode(ir: IRText, images: ImageHashMap, warnings: WarningSink): TextNode {
  const t = figma.createText();
  const firstFont = ir.segments[0]?.font.resolved ?? { family: 'Inter', style: 'Regular' };
  t.fontName = firstFont as FontName;
  t.characters = ir.characters;

  for (const seg of ir.segments) {
    const end = Math.min(seg.end, t.characters.length);
    if (seg.start >= end) continue;
    try {
      if (seg.font.resolved) t.setRangeFontName(seg.start, end, seg.font.resolved as FontName);
      t.setRangeFontSize(seg.start, end, seg.size);
      const paint = toFigmaPaints([seg.color], images);
      if (paint.length > 0) t.setRangeFills(seg.start, end, paint);
      if (seg.decoration) t.setRangeTextDecoration(seg.start, end, seg.decoration);
      if (seg.link) t.setRangeHyperlink(seg.start, end, { type: 'URL', value: seg.link });
    } catch (err) {
      warnings.degraded(ir.id, 'text-range', `range style failed: ${errorText(err)}`);
    }
  }

  t.textAlignHorizontal = ir.style.align;
  t.textAlignVertical = ir.style.verticalAlign;
  if (ir.style.case) t.textCase = ir.style.case;
  t.letterSpacing =
    ir.style.letterSpacing.unit === 'PERCENT'
      ? { unit: 'PERCENT', value: ir.style.letterSpacing.value }
      : { unit: 'PIXELS', value: ir.style.letterSpacing.value };
  t.lineHeight =
    ir.style.lineHeight.unit === 'AUTO'
      ? { unit: 'AUTO' }
      : { unit: ir.style.lineHeight.unit, value: ir.style.lineHeight.value ?? 0 };
  if (ir.style.maxLines) (t as TextNode & { maxLines: number | null }).maxLines = ir.style.maxLines;
  if (ir.style.truncate) t.textTruncation = 'ENDING';

  // Resize before switching auto-resize so the box starts from the captured width.
  t.textAutoResize = 'NONE';
  t.resizeWithoutConstraints(Math.max(1, ir.rect.w), Math.max(1, ir.rect.h));
  t.textAutoResize = ir.style.autoResize;
  if (ir.rotation) t.rotation = -ir.rotation;
  return t;
}

function createVectorNode(ir: IRVector, warnings: WarningSink): SceneNode {
  try {
    const node = figma.createNodeFromSvg(ir.svg);
    node.resizeWithoutConstraints(Math.max(0.01, ir.rect.w), Math.max(0.01, ir.rect.h));
    if (ir.rotation) node.rotation = -ir.rotation;
    return node;
  } catch (err) {
    warnings.degraded(ir.id, 'svg', `SVG parse failed: ${errorText(err)}`, 'empty frame');
    return placeholder(ir);
  }
}

function createImageNode(ir: IRImage, images: ImageHashMap, warnings: WarningSink): SceneNode {
  const rect = figma.createRectangle();
  rect.resizeWithoutConstraints(Math.max(0.01, ir.rect.w), Math.max(0.01, ir.rect.h));
  const hash = images.get(ir.assetId);
  if (hash) {
    rect.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: ir.scaleMode }];
  } else {
    warnings.dropped(ir.id, 'image', `asset ${ir.assetId} missing`, 'grey placeholder');
    rect.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 1 }];
  }
  if (ir.corner.some((c) => c > 0)) {
    rect.topLeftRadius = ir.corner[0];
    rect.topRightRadius = ir.corner[1];
    rect.bottomRightRadius = ir.corner[2];
    rect.bottomLeftRadius = ir.corner[3];
  }
  applyStrokes(rect, ir.strokes, images);
  if (ir.effects.length > 0) rect.effects = ir.effects.map(toFigmaEffect);
  if (ir.rotation) rect.rotation = -ir.rotation;
  return rect;
}

/** A failed node still occupies its space, named so the user can find it. */
function placeholder(ir: IRNode): SceneNode {
  const rect = figma.createRectangle();
  rect.resizeWithoutConstraints(Math.max(0.01, ir.rect.w), Math.max(0.01, ir.rect.h));
  rect.fills = [{ type: 'SOLID', color: { r: 0.95, g: 0.9, b: 0.9 }, opacity: 1 }];
  rect.name = `! ${ir.name}`;
  return rect;
}

/* ---------------------------------------------------------------- layout -- */

function applyLayout(
  frame: FrameNode,
  ir: IRFrame,
  warnings: WarningSink,
  threshold: number,
): void {
  const spec = ir.layout;
  if (spec.mode === 'NONE') return;
  try {
    frame.layoutMode = spec.mode === 'WRAP' ? 'HORIZONTAL' : spec.mode;
    if (spec.mode === 'WRAP') {
      (frame as FrameNode & { layoutWrap: 'NO_WRAP' | 'WRAP' }).layoutWrap = 'WRAP';
      if (spec.counterAxisSpacing !== undefined) {
        (frame as FrameNode & { counterAxisSpacing: number | null }).counterAxisSpacing =
          spec.counterAxisSpacing;
      }
    }
    frame.paddingTop = spec.padding[0];
    frame.paddingRight = spec.padding[1];
    frame.paddingBottom = spec.padding[2];
    frame.paddingLeft = spec.padding[3];
    frame.itemSpacing = spec.itemSpacing;
    frame.primaryAxisAlignItems = spec.primaryAlign;
    frame.counterAxisAlignItems = spec.counterAlign === 'BASELINE' ? 'BASELINE' : spec.counterAlign;
    // Keep the captured size: HUG is applied per-node in applyChildSizing.
    frame.primaryAxisSizingMode = 'FIXED';
    frame.counterAxisSizingMode = 'FIXED';

    if (spec.confidence < threshold) {
      warnings.info(
        ir.id,
        'layout-confidence',
        `inferred layout at ${spec.confidence.toFixed(2)} confidence (${spec.reason})`,
        'flatten available',
      );
    }
  } catch (err) {
    warnings.degraded(ir.id, 'auto-layout', `could not apply layout: ${errorText(err)}`);
  }
}

function applyChildSizing(
  node: SceneNode,
  ir: IRNode,
  parent: FrameNode,
  warnings: WarningSink,
): void {
  if (parent.layoutMode === 'NONE') return;
  if (ir.layout?.absolute) return;
  const sizing = ir.layout?.sizing;
  if (!sizing) return;
  const target = node as SceneNode & {
    layoutSizingHorizontal: 'FIXED' | 'HUG' | 'FILL';
    layoutSizingVertical: 'FIXED' | 'HUG' | 'FILL';
  };
  try {
    target.layoutSizingHorizontal = canHug(node, sizing.h) ? sizing.h : 'FIXED';
  } catch (err) {
    warnings.info(ir.id, 'sizing', `horizontal ${sizing.h} rejected: ${errorText(err)}`, 'FIXED');
  }
  try {
    target.layoutSizingVertical = canHug(node, sizing.v) ? sizing.v : 'FIXED';
  } catch (err) {
    warnings.info(ir.id, 'sizing', `vertical ${sizing.v} rejected: ${errorText(err)}`, 'FIXED');
  }
}

/** HUG is only legal on text and on frames that have their own auto layout. */
function canHug(node: SceneNode, sizing: 'FIXED' | 'HUG' | 'FILL'): boolean {
  if (sizing !== 'HUG') return true;
  if (node.type === 'TEXT') return true;
  return node.type === 'FRAME' && node.layoutMode !== 'NONE';
}

function toConstraint(c: LayoutSpec['constraints'] extends undefined ? never : 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE'): ConstraintType {
  return c as ConstraintType;
}

/* ----------------------------------------------------------------- utils -- */

function countNodes(root: IRNode): number {
  let n = 0;
  for (const _ of walk(root)) n++;
  return n;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
