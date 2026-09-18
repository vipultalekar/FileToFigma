/**
 * A mock of the Figma Plugin API, good enough to run the real builder in plain
 * Node (PRD section 15: "run the builder against a mock Figma API").
 *
 * It implements the parts the builder touches, and — critically — an auto
 * layout solver, so a test can widen the root frame and assert that children
 * actually reflow. Without that, an Auto Layout assertion proves nothing.
 */

export type MockPaint = Record<string, unknown> & { type: string };

export interface MockFont {
  family: string;
  style: string;
}

let idCounter = 0;

export class MockNode {
  readonly id = `mock-${++idCounter}`;
  type = 'FRAME';
  name = '';
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  opacity = 1;
  visible = true;
  rotation = 0;
  blendMode = 'NORMAL';
  fills: MockPaint[] = [];
  strokes: MockPaint[] = [];
  strokeWeight = 1;
  strokeAlign = 'INSIDE';
  dashPattern: number[] = [];
  effects: Record<string, unknown>[] = [];
  clipsContent = false;
  topLeftRadius = 0;
  topRightRadius = 0;
  bottomRightRadius = 0;
  bottomLeftRadius = 0;
  parent: MockNode | null = null;
  children: MockNode[] = [];
  constraints = { horizontal: 'MIN', vertical: 'MIN' };

  // Auto layout
  layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL' = 'NONE';
  layoutWrap: 'NO_WRAP' | 'WRAP' = 'NO_WRAP';
  paddingTop = 0;
  paddingRight = 0;
  paddingBottom = 0;
  paddingLeft = 0;
  itemSpacing = 0;
  counterAxisSpacing: number | null = null;
  primaryAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN' = 'MIN';
  counterAxisAlignItems: 'MIN' | 'CENTER' | 'MAX' | 'BASELINE' = 'MIN';
  primaryAxisSizingMode: 'FIXED' | 'AUTO' = 'FIXED';
  counterAxisSizingMode: 'FIXED' | 'AUTO' = 'FIXED';
  layoutPositioning: 'AUTO' | 'ABSOLUTE' = 'AUTO';
  layoutSizingHorizontal: 'FIXED' | 'HUG' | 'FILL' = 'FIXED';
  layoutSizingVertical: 'FIXED' | 'HUG' | 'FILL' = 'FIXED';

  private pluginData: Record<string, string> = {};

  /** Style bindings, so tests can assert what the styles pass applied. */
  fillStyleId = '';
  textStyleId = '';

  async setFillStyleIdAsync(id: string): Promise<void> {
    this.fillStyleId = id;
  }

  async setTextStyleIdAsync(id: string): Promise<void> {
    this.textStyleId = id;
  }

  appendChild(child: MockNode): void {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
  }

  insertChild(index: number, child: MockNode): void {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.splice(index, 0, child);
  }

  removeChild(child: MockNode): void {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
  }

  remove(): void {
    this.parent?.removeChild(this);
    this.parent = null;
  }

  resize(w: number, h: number): void {
    this.width = Math.max(0.01, w);
    this.height = Math.max(0.01, h);
  }

  resizeWithoutConstraints(w: number, h: number): void {
    this.resize(w, h);
  }

  setPluginData(key: string, value: string): void {
    this.pluginData[key] = value;
  }

  getPluginData(key: string): string {
    return this.pluginData[key] ?? '';
  }

  async exportAsync(): Promise<Uint8Array> {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }
}

export class MockTextNode extends MockNode {
  override type = 'TEXT';
  characters = '';
  fontName: MockFont = { family: 'Inter', style: 'Regular' };
  fontSize = 16;
  textAlignHorizontal = 'LEFT';
  textAlignVertical = 'TOP';
  textCase = 'ORIGINAL';
  textDecoration = 'NONE';
  textAutoResize: 'NONE' | 'HEIGHT' | 'WIDTH_AND_HEIGHT' = 'NONE';
  textTruncation: 'DISABLED' | 'ENDING' = 'DISABLED';
  maxLines: number | null = null;
  letterSpacing: Record<string, unknown> = { unit: 'PIXELS', value: 0 };
  lineHeight: Record<string, unknown> = { unit: 'AUTO' };
  ranges: {
    start: number;
    end: number;
    font?: MockFont;
    size?: number;
    fills?: MockPaint[];
    decoration?: string;
    link?: { type: string; value: string };
  }[] = [];

  private range(start: number, end: number) {
    let entry = this.ranges.find((r) => r.start === start && r.end === end);
    if (!entry) {
      entry = { start, end };
      this.ranges.push(entry);
    }
    return entry;
  }

  setRangeFontName(start: number, end: number, font: MockFont): void {
    if (!loadedFonts.has(fontKeyOf(font))) {
      throw new Error(`font ${font.family} ${font.style} is not loaded`);
    }
    this.range(start, end).font = font;
  }

  setRangeFontSize(start: number, end: number, size: number): void {
    this.range(start, end).size = size;
  }

  setRangeFills(start: number, end: number, fills: MockPaint[]): void {
    this.range(start, end).fills = fills;
  }

  setRangeTextDecoration(start: number, end: number, decoration: string): void {
    this.range(start, end).decoration = decoration;
  }

  setRangeHyperlink(start: number, end: number, link: { type: string; value: string }): void {
    this.range(start, end).link = link;
  }

  /**
   * Average glyph advance. It starts at a crude 0.55em and is calibrated the
   * moment the builder resizes the node to its captured box: the browser
   * already measured this exact string at this exact size, so that measurement
   * is far better than any guess, and reflow predictions land close to reality.
   */
  private charWidth: number | null = null;

  override resize(w: number, h: number): void {
    super.resize(w, h);
    this.calibrate(w, h);
  }

  private calibrate(w: number, h: number): void {
    const chars = this.characters.length;
    if (chars === 0 || w <= 0 || h <= 0) return;
    const lineHeightPx = this.lineHeightPx();
    const lines = Math.max(1, Math.round(h / lineHeightPx));
    const perLine = Math.max(1, Math.ceil(chars / lines));
    this.charWidth = w / perLine;
  }

  private lineHeightPx(): number {
    return this.lineHeight.unit === 'PIXELS'
      ? (this.lineHeight.value as number)
      : this.fontSize * 1.4;
  }

  /** Deterministic text metrics: enough to test reflow. */
  measure(width: number): { w: number; h: number } {
    const charWidth = this.charWidth ?? this.fontSize * 0.55;
    const lineHeightPx = this.lineHeightPx();
    const perLine = Math.max(1, Math.floor(width / charWidth));
    const lines = Math.max(1, Math.ceil(this.characters.length / perLine));
    return { w: Math.min(width, this.characters.length * charWidth), h: lines * lineHeightPx };
  }
}

export const loadedFonts = new Set<string>();

export function fontKeyOf(font: MockFont): string {
  return `${font.family}|${font.style}`;
}
