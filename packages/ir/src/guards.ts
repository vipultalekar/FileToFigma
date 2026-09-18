import type {
  FrameNode,
  IRNode,
  ImageNode,
  LayoutSpec,
  TextNode,
  VectorNode,
} from './types.js';

export const isFrame = (n: IRNode): n is FrameNode => n.kind === 'frame';
export const isText = (n: IRNode): n is TextNode => n.kind === 'text';
export const isVector = (n: IRNode): n is VectorNode => n.kind === 'vector';
export const isImage = (n: IRNode): n is ImageNode => n.kind === 'image';

export function childrenOf(n: IRNode): IRNode[] {
  return isFrame(n) ? n.children : [];
}

/** Every IR node carries a LayoutSpec; this is the uniform accessor. */
export function layoutOf(n: IRNode): LayoutSpec {
  return n.layout;
}

/** Depth-first pre-order walk. */
export function* walk(root: IRNode): Generator<IRNode> {
  yield root;
  for (const c of childrenOf(root)) yield* walk(c);
}

/** Depth-first walk yielding [node, parent]. */
export function* walkWithParent(
  root: IRNode,
  parent: FrameNode | null = null,
): Generator<[IRNode, FrameNode | null]> {
  yield [root, parent];
  if (isFrame(root)) for (const c of root.children) yield* walkWithParent(c, root);
}

export function countNodes(root: IRNode): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of walk(root)) n++;
  return n;
}

export function findNode(root: IRNode, id: string): IRNode | undefined {
  for (const n of walk(root)) if (n.id === id) return n;
  return undefined;
}
