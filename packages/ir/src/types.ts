/**
 * Web2Figma Intermediate Representation.
 *
 * This file is THE contract (PRD section 4). It is plain JSON-serialisable
 * TypeScript: no DOM types, no Figma types, no runtime dependencies. Every
 * module depends on it; it depends on nothing.
 *
 * Changing a shape here means bumping IR_VERSION and updating every consumer in
 * the same commit.
 */

export const IR_VERSION = 1;

export type SourceKind = 'url' | 'html' | 'image';

export interface IRDocument {
  version: number;
  source: { kind: SourceKind; ref: string; capturedAt: string };
  viewport: { width: number; height: number; dpr: number };
  root: IRNode;
  /** Deduped, collected at capture time. */
  fonts: FontRequest[];
  /** assetId -> payload. Emptied on the wire when assets stream out-of-band. */
  images: Record<string, ImageAsset>;
  warnings: Warning[];
}

export type IRNode = FrameNode | TextNode | VectorNode | ImageNode;
export type IRNodeKind = IRNode['kind'];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlexInfo {
  direction: 'row' | 'row-reverse' | 'column' | 'column-reverse';
  wrap: 'nowrap' | 'wrap' | 'wrap-reverse';
  justifyContent: string;
  alignItems: string;
  rowGap: number;
  columnGap: number;
  /** Per-child properties, recorded on the child node itself. */
  grow?: number;
  shrink?: number;
  basis?: string;
  alignSelf?: string;
}

export interface GridInfo {
  templateColumns: string[];
  templateRows: string[];
  rowGap: number;
  columnGap: number;
  justifyContent: string;
  alignItems: string;
  /** Per-child placement, resolved from computed styles. */
  cell?: { rowStart: number; rowEnd: number; colStart: number; colEnd: number };
}

export interface NodeMeta {
  tag: string;
  classes: string[];
  role?: string;
  testId?: string;
  ariaLabel?: string;
  /** Kept for layout inference; never reaches Figma. */
  display?: string;
  position?: string;
  zIndex?: number;
  /** data-role, emitted by the image pipeline's synthesised HTML. */
  dataRole?: string;
  /** Raw flex/grid info from computed styles, consumed by Tier 1. */
  flex?: FlexInfo;
  grid?: GridInfo;
  /** Offsets from position: absolute/fixed, used to derive constraints. */
  inset?: { top: string; right: string; bottom: string; left: string };
  /** Declared CSS width/height keywords, used by HUG/FILL decisions. */
  declaredSize?: { w: string; h: string };
  /** Intrinsic content extent where the DOM could measure it. */
  intrinsic?: { w: number; h: number };
  /** Marks a node synthesised from ::before / ::after. */
  pseudo?: 'before' | 'after';
  href?: string;
}

export interface BaseNode {
  /** Stable, derived from the DOM path. */
  id: string;
  /** Layer name in Figma. */
  name: string;
  kind: string;
  /** Absolute at capture (CSS px, document space); parent-relative after normalisation. */
  rect: Rect;
  opacity: number;
  visible: boolean;
  /** Degrees, only from 2D rotate(). CSS convention (clockwise); the builder negates. */
  rotation?: number;
  blendMode?: BlendMode;
  effects: Effect[];
  meta: NodeMeta;
}

export interface FrameNode extends BaseNode {
  kind: 'frame';
  children: IRNode[];
  fills: Paint[];
  strokes: Stroke[];
  /** topLeft, topRight, bottomRight, bottomLeft. */
  corner: [number, number, number, number];
  /** From overflow. */
  clip: boolean;
  /** Filled by the inference engine, not by capture. */
  layout: LayoutSpec;
}

export interface TextNode extends BaseNode {
  kind: 'text';
  characters: string;
  /** Ranged styles for mixed inline formatting. */
  segments: TextSegment[];
  /** Paragraph-level defaults. */
  style: TextStyle;
  /** How this text sizes inside its parent auto-layout frame. */
  layout: LayoutSpec;
}

export interface TextSegment {
  start: number;
  end: number;
  font: FontRequest;
  size: number;
  color: Paint;
  decoration?: 'UNDERLINE' | 'STRIKETHROUGH';
  link?: string;
}

export interface TextStyle {
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  verticalAlign: 'TOP' | 'CENTER' | 'BOTTOM';
  lineHeight: { unit: 'PIXELS' | 'PERCENT' | 'AUTO'; value?: number };
  letterSpacing: { unit: 'PIXELS' | 'PERCENT'; value: number };
  case?: 'UPPER' | 'LOWER' | 'TITLE';
  autoResize: 'NONE' | 'WIDTH_AND_HEIGHT' | 'HEIGHT';
  truncate?: boolean;
  maxLines?: number;
}

export interface VectorNode extends BaseNode {
  kind: 'vector';
  /** Serialised, self-contained SVG string. */
  svg: string;
  layout: LayoutSpec;
}

export interface ImageNode extends BaseNode {
  kind: 'image';
  /** Key into IRDocument.images. */
  assetId: string;
  scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  corner: [number, number, number, number];
  strokes: Stroke[];
  layout: LayoutSpec;
}

export interface ImageAsset {
  /** Base64, without the data: prefix. */
  bytes: string;
  mime: string;
  width: number;
  height: number;
  /** Content hash used for dedupe. */
  hash: string;
}

/* ---------------------------------------------------------------- layout -- */

export type Sizing = 'FIXED' | 'HUG' | 'FILL';
export type Constraint = 'MIN' | 'CENTER' | 'MAX' | 'STRETCH' | 'SCALE';
export type LayoutReason =
  | 'flex'
  | 'grid'
  | 'geometric'
  | 'fallback'
  | 'leaf'
  | 'single';

export interface LayoutSpec {
  mode: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'WRAP';
  /** top, right, bottom, left. */
  padding: [number, number, number, number];
  itemSpacing: number;
  /** WRAP only. */
  counterAxisSpacing?: number;
  primaryAlign: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAlign: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
  /** How this node sizes inside its parent. */
  sizing: { h: Sizing; v: Sizing };
  /** Escapes the parent auto layout. */
  absolute?: boolean;
  /** Used when absolute. */
  constraints?: { h: Constraint; v: Constraint };
  /** 0-1, from the inference pass. */
  confidence: number;
  reason: LayoutReason;
}

/* ---------------------------------------------------------------- paints -- */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface RGBA extends RGB {
  a: number;
}

export interface SolidPaint {
  type: 'SOLID';
  color: RGB;
  opacity: number;
}

export type GradientType =
  | 'GRADIENT_LINEAR'
  | 'GRADIENT_RADIAL'
  | 'GRADIENT_ANGULAR'
  | 'GRADIENT_DIAMOND';

export interface GradientPaint {
  type: GradientType;
  stops: { position: number; color: RGBA }[];
  transform: [[number, number, number], [number, number, number]];
  opacity?: number;
}

export type ScaleMode = 'FILL' | 'FIT' | 'CROP' | 'TILE';

export interface ImagePaint {
  type: 'IMAGE';
  assetId: string;
  scaleMode: ScaleMode;
  opacity?: number;
  /** For TILE. */
  scalingFactor?: number;
  imageTransform?: [[number, number, number], [number, number, number]];
}

export type Paint = SolidPaint | GradientPaint | ImagePaint;

export interface Stroke {
  paint: Paint;
  /** Uniform, or [top, right, bottom, left]. */
  weight: number | [number, number, number, number];
  align: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  dash?: number[];
}

export type Effect =
  | {
      type: 'DROP_SHADOW' | 'INNER_SHADOW';
      color: RGBA;
      offset: { x: number; y: number };
      radius: number;
      spread: number;
    }
  | { type: 'LAYER_BLUR' | 'BACKGROUND_BLUR'; radius: number };

export type BlendMode =
  | 'NORMAL'
  | 'DARKEN'
  | 'MULTIPLY'
  | 'COLOR_BURN'
  | 'LIGHTEN'
  | 'SCREEN'
  | 'COLOR_DODGE'
  | 'OVERLAY'
  | 'SOFT_LIGHT'
  | 'HARD_LIGHT'
  | 'DIFFERENCE'
  | 'EXCLUSION'
  | 'HUE'
  | 'SATURATION'
  | 'COLOR'
  | 'LUMINOSITY'
  | 'PASS_THROUGH';

/* ------------------------------------------------------- fonts, warnings -- */

export type FontClassification =
  | 'serif'
  | 'sans-serif'
  | 'monospace'
  | 'display'
  | 'handwriting';

export interface FontRequest {
  /** As written in CSS. */
  family: string;
  /** 100-900, resolved. */
  weight: number;
  italic: boolean;
  /** Remaining families from the CSS stack. */
  fallbackStack: string[];
  classification: FontClassification;
  /** Filled by the builder. */
  resolved?: { family: string; style: string };
}

export type WarningSeverity = 'info' | 'degraded' | 'dropped';

export interface Warning {
  nodeId: string;
  severity: WarningSeverity;
  /** 'backdrop-filter', 'font', 'transform', ... */
  property: string;
  message: string;
  fallbackApplied?: string;
}

/* ------------------------------------------------------------- transport -- */

export type Envelope =
  | { t: 'begin'; total: number; doc: IRDocument }
  | { t: 'asset'; seq: number; id: string; bytes: string; mime: string }
  | { t: 'commit' }
  | { t: 'abort'; reason: string };

export type BuilderMessage =
  | { t: 'progress'; done: number; total: number; stage: string }
  | { t: 'ack'; seq: number }
  | { t: 'done'; report: ConversionReport }
  | { t: 'error'; message: string };

export interface ConversionReport {
  nodesCreated: Record<string, number>;
  autoLayoutCoverage: {
    frames: number;
    withLayout: number;
    byReason: Record<string, number>;
  };
  fontSubstitutions: { requested: string; resolved: string }[];
  warnings: Warning[];
  elapsedMs: number;
  /** Present when the run created Figma colour and text styles. */
  stylesCreated?: { colors: number; texts: number; names: string[] };
}

/* -------------------------------------------------------------- defaults -- */

export function defaultLayout(): LayoutSpec {
  return {
    mode: 'NONE',
    padding: [0, 0, 0, 0],
    itemSpacing: 0,
    primaryAlign: 'MIN',
    counterAlign: 'MIN',
    sizing: { h: 'FIXED', v: 'FIXED' },
    confidence: 1,
    reason: 'fallback',
  };
}

/** Below this the builder applies the layout but records a warning (PRD section 4). */
export const LAYOUT_CONFIDENCE_THRESHOLD = 0.6;

/** Hard node ceiling (PRD section 11). */
export const NODE_CEILING = 12000;
