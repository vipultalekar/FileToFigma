import { LAYOUT_CONFIDENCE_THRESHOLD } from '@web2figma/ir';

/**
 * Post-build escape hatches (PRD section 12). Both operate on the current
 * selection and rely on the confidence/reason stored via setPluginData at build
 * time.
 */

interface PluginMeta {
  confidence: number;
  reason: string;
  id: string;
}

export function readMeta(node: SceneNode): PluginMeta | null {
  const raw = node.getPluginData('w2f');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PluginMeta;
  } catch {
    return null;
  }
}

function descendants(nodes: readonly SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (node: SceneNode): void => {
    out.push(node);
    if ('children' in node) for (const c of node.children) visit(c as SceneNode);
  };
  for (const n of nodes) visit(n);
  return out;
}

/**
 * Remove auto layout from every frame whose inference confidence was below the
 * threshold, restoring absolute positioning. Children keep their on-canvas
 * positions because Figma preserves x/y when layoutMode goes to NONE.
 */
export function flattenInferredLayouts(
  selection: readonly SceneNode[],
  threshold = LAYOUT_CONFIDENCE_THRESHOLD,
): number {
  let flattened = 0;
  for (const node of descendants(selection)) {
    if (node.type !== 'FRAME' || node.layoutMode === 'NONE') continue;
    const meta = readMeta(node);
    if (!meta) continue;
    if (meta.reason === 'flex') continue; // Tier 1 flex is never a guess.
    if (meta.confidence >= threshold) continue;
    node.layoutMode = 'NONE';
    flattened++;
  }
  return flattened;
}

/** Replace a subtree with a flattened image, for sections that imported badly. */
export async function rasteriseSubtree(selection: readonly SceneNode[]): Promise<number> {
  let replaced = 0;
  for (const node of selection) {
    if (!('exportAsync' in node)) continue;
    const parent = node.parent;
    if (!parent) continue;
    const bytes = await (node as SceneNode & ExportMixin).exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 2 },
    });
    const image = figma.createImage(bytes);
    const rect = figma.createRectangle();
    rect.resizeWithoutConstraints(Math.max(0.01, node.width), Math.max(0.01, node.height));
    rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
    rect.name = `${node.name} (rasterised)`;
    const index = parent.children.indexOf(node);
    parent.insertChild(index, rect);
    rect.x = node.x;
    rect.y = node.y;
    node.remove();
    replaced++;
  }
  return replaced;
}

/** Select every layer a warning points at, so a fix can be made in one pass. */
export function selectByIrIds(root: SceneNode, ids: readonly string[]): SceneNode[] {
  const wanted = new Set(ids);
  const hits: SceneNode[] = [];
  for (const node of descendants([root])) {
    const meta = readMeta(node);
    if (meta && wanted.has(meta.id)) hits.push(node);
  }
  return hits;
}
