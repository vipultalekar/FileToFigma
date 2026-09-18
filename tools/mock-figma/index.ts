import { MockNode, MockTextNode, fontKeyOf, loadedFonts, type MockFont } from './nodes.js';
import { solveLayout } from './layout.js';

export * from './nodes.js';
export * from './layout.js';
export * from './render.js';

/**
 * Installs a mock `figma` global so the real builder runs in Node.
 * `uninstall()` restores whatever was there, which keeps tests isolated.
 */

export interface MockStyle {
  id: string;
  name: string;
  type: 'PAINT' | 'TEXT';
  paints?: unknown[];
  fontName?: MockFont;
  fontSize?: number;
  lineHeight?: unknown;
  letterSpacing?: unknown;
}

export interface MockFigma {
  root: MockNode;
  created: MockNode[];
  images: { hash: string; bytes: Uint8Array }[];
  notifications: string[];
  messages: unknown[];
  styles: MockStyle[];
  uninstall: () => void;
  /** Re-solve auto layout across the whole built tree. */
  solve: () => void;
}

const DEFAULT_FONTS: MockFont[] = [
  { family: 'Inter', style: 'Thin' },
  { family: 'Inter', style: 'Light' },
  { family: 'Inter', style: 'Regular' },
  { family: 'Inter', style: 'Medium' },
  { family: 'Inter', style: 'Semi Bold' },
  { family: 'Inter', style: 'Bold' },
  { family: 'Inter', style: 'Black' },
  { family: 'Inter', style: 'Italic' },
  { family: 'Inter', style: 'Bold Italic' },
  { family: 'Roboto Mono', style: 'Regular' },
  { family: 'Roboto Mono', style: 'Bold' },
  { family: 'Source Serif Pro', style: 'Regular' },
  { family: 'Source Serif Pro', style: 'Bold' },
  { family: 'Roboto', style: 'Regular' },
];

export function installMockFigma(options: { fonts?: MockFont[] } = {}): MockFigma {
  const fonts = options.fonts ?? DEFAULT_FONTS;
  const page = new MockNode();
  page.name = 'Page 1';
  page.type = 'PAGE';
  const created: MockNode[] = [];
  const images: { hash: string; bytes: Uint8Array }[] = [];
  const notifications: string[] = [];
  const messages: unknown[] = [];
  const styles: MockStyle[] = [];
  loadedFonts.clear();

  const track = <T extends MockNode>(node: T): T => {
    created.push(node);
    page.appendChild(node);
    return node;
  };

  const api = {
    root: page,
    currentPage: page,
    createFrame: () => {
      const n = track(new MockNode());
      n.type = 'FRAME';
      n.width = 100;
      n.height = 100;
      return n;
    },
    createText: () => {
      const n = track(new MockTextNode());
      return n;
    },
    createRectangle: () => {
      const n = track(new MockNode());
      n.type = 'RECTANGLE';
      return n;
    },
    createNodeFromSvg: (svg: string) => {
      if (!svg.includes('<svg')) throw new Error('not an SVG');
      const n = track(new MockNode());
      n.type = 'FRAME';
      n.name = 'svg';
      return n;
    },
    createPaintStyle: () => {
      const style: MockStyle = { id: `S:paint${styles.length + 1}`, name: '', type: 'PAINT' };
      styles.push(style);
      return style;
    },
    createTextStyle: () => {
      const style: MockStyle = { id: `S:text${styles.length + 1}`, name: '', type: 'TEXT' };
      styles.push(style);
      return style;
    },
    createImage: (bytes: Uint8Array) => {
      const hash = `img${images.length + 1}`;
      images.push({ hash, bytes });
      return { hash };
    },
    listAvailableFontsAsync: async () => fonts.map((f) => ({ fontName: f })),
    loadFontAsync: async (font: MockFont) => {
      if (!fonts.some((f) => f.family === font.family && f.style === font.style)) {
        throw new Error(`font not available: ${font.family} ${font.style}`);
      }
      loadedFonts.add(fontKeyOf(font));
    },
    notify: (message: string) => {
      notifications.push(message);
      return { cancel: () => undefined };
    },
    ui: {
      postMessage: (message: unknown) => messages.push(message),
      onmessage: null,
      resize: () => undefined,
    },
    showUI: () => undefined,
    closePlugin: () => undefined,
    viewport: {
      scrollAndZoomIntoView: () => undefined,
      center: { x: 0, y: 0 },
      zoom: 1,
    },
  };

  const globals = globalThis as Record<string, unknown>;
  const previous = globals.figma;
  globals.figma = api;

  return {
    root: page,
    created,
    images,
    notifications,
    messages,
    styles,
    solve: () => {
      for (const child of page.children) solveLayout(child);
    },
    uninstall: () => {
      globals.figma = previous;
    },
  };
}

/** Find a built node by its layer name; convenient in assertions. */
export function findByName(root: MockNode, name: string): MockNode | undefined {
  if (root.name === name) return root;
  for (const child of root.children) {
    const hit = findByName(child, name);
    if (hit) return hit;
  }
  return undefined;
}

export function describeTree(node: MockNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  const layout = node.layoutMode !== 'NONE' ? ` [${node.layoutMode}]` : '';
  const lines = [
    `${pad}${node.type} "${node.name}" ${Math.round(node.x)},${Math.round(node.y)} ${Math.round(node.width)}x${Math.round(node.height)}${layout}`,
  ];
  for (const child of node.children) lines.push(describeTree(child, depth + 1));
  return lines.join('\n');
}
