import type { FrameNode, IRNode } from '@web2figma/ir';
import { isFrame, isImage, isText, isVector } from '@web2figma/ir';

/**
 * Semantic layer naming (PRD section 7 stage 4).
 *
 * Priority: aria-label, data-testid, text content, semantic tag, first useful
 * class, tag. Never emit "div".
 */

const SEMANTIC_TAGS: Record<string, string> = {
  header: 'Header',
  nav: 'Nav',
  main: 'Main',
  footer: 'Footer',
  section: 'Section',
  article: 'Article',
  aside: 'Aside',
  form: 'Form',
  button: 'Button',
  a: 'Link',
  ul: 'List',
  ol: 'List',
  li: 'List item',
  table: 'Table',
  thead: 'Table head',
  tbody: 'Table body',
  tr: 'Row',
  td: 'Cell',
  th: 'Header cell',
  input: 'Input',
  textarea: 'Input',
  select: 'Select',
  label: 'Label',
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  h5: 'Heading 5',
  h6: 'Heading 6',
  img: 'Image',
  svg: 'Icon',
  video: 'Video',
  canvas: 'Canvas',
  iframe: 'Embed',
  picture: 'Image',
  figure: 'Figure',
  blockquote: 'Quote',
  hr: 'Divider',
};

/** Utility-class and hashed-class noise that says nothing about the layer. */
const NOISE = /^(css-[a-z0-9]+|sc-[a-z0-9]+|[a-z]+-[0-9a-f]{5,}|jsx-[0-9]+|[a-z]{1,2}[0-9]+|(p|m|px|py|mx|my|mt|mb|ml|mr|pt|pb|pl|pr|w|h|gap|text|bg|flex|grid|border|rounded|shadow|font|leading|tracking|items|justify|space|max|min|top|left|right|bottom|z|opacity|hover|focus|sm|md|lg|xl)([-:][\w./[\]%]+)*)$/i;

export function cleanClassName(cls: string): string | null {
  const c = cls.trim();
  if (c === '' || NOISE.test(c)) return null;
  if (/[0-9a-f]{6,}/i.test(c) && !/[aeiou]{2}/i.test(c)) return null;
  const words = c
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (words.length < 2) return null;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function truncate(s: string, n = 24): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : `${clean.slice(0, n - 1)}...`;
}

function firstText(node: IRNode, depth = 0): string | null {
  if (isText(node)) return node.characters.trim() || null;
  if (depth > 2 || !isFrame(node)) return null;
  for (const c of node.children) {
    const t = firstText(c, depth + 1);
    if (t) return t;
  }
  return null;
}

/* ------------------------------------------------------ pattern detection -- */

export function looksLikeButton(node: IRNode): boolean {
  if (!isFrame(node)) return false;
  const tag = node.meta.tag.toLowerCase();
  if (tag === 'button') return true;
  if (node.meta.role === 'button') return true;
  if (tag !== 'a' && tag !== 'div' && tag !== 'span') return false;
  const painted = node.fills.length > 0 || node.strokes.length > 0;
  const padded = node.layout.padding.some((p) => p > 0);
  const small = node.rect.h <= 72 && node.rect.w <= 420;
  const hasText = firstText(node) !== null;
  return painted && (padded || small) && hasText && small;
}

export function looksLikeCard(node: IRNode): boolean {
  if (!isFrame(node)) return false;
  const hasMedia = node.children.some((c) => isImage(c) || isVector(c));
  const hasText = node.children.some((c) => isText(c) || firstText(c) !== null);
  const framed =
    node.fills.length > 0 || node.strokes.length > 0 || node.effects.length > 0 ||
    node.corner.some((c) => c > 0);
  return hasMedia && hasText && framed;
}

export function looksLikeNav(node: IRNode, ancestorTags: readonly string[]): boolean {
  if (!isFrame(node)) return false;
  const tag = node.meta.tag.toLowerCase();
  if (tag === 'nav' || node.meta.role === 'navigation') return true;
  if (tag !== 'ul') return false;
  const inHeader = ancestorTags.includes('header');
  const links = node.children.filter((c) => c.meta.tag.toLowerCase() === 'a' || c.meta.href);
  return inHeader && links.length >= 2;
}

/* --------------------------------------------------------------- naming -- */

export function nameNode(node: IRNode, ancestorTags: readonly string[] = []): string {
  const tag = node.meta.tag.toLowerCase();

  if (node.meta.ariaLabel) return truncate(node.meta.ariaLabel);
  if (node.meta.testId) return truncate(node.meta.testId);
  if (node.meta.dataRole) {
    const r = node.meta.dataRole;
    return r.charAt(0).toUpperCase() + r.slice(1);
  }

  if (isText(node)) {
    const heading = SEMANTIC_TAGS[tag];
    const content = truncate(node.characters);
    if (content) return content;
    return heading ?? 'Text';
  }

  if (isVector(node)) return 'Icon';
  if (isImage(node)) return node.meta.ariaLabel ?? 'Image';

  if (looksLikeNav(node, ancestorTags)) return 'Nav';
  if (looksLikeButton(node)) {
    const label = firstText(node);
    return label ? `Button / ${truncate(label, 16)}` : 'Button';
  }
  if (looksLikeCard(node)) {
    const label = firstText(node);
    return label ? `Card / ${truncate(label, 16)}` : 'Card';
  }

  const semantic = SEMANTIC_TAGS[tag];
  if (semantic) return semantic;

  for (const cls of node.meta.classes) {
    const cleaned = cleanClassName(cls);
    if (cleaned) return truncate(cleaned);
  }

  const label = firstText(node);
  if (label) return truncate(label);

  if (tag === 'div' || tag === 'span') {
    return isFrame(node) && node.children.length > 1 ? 'Group' : 'Container';
  }
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

/** Name the whole tree, tracking ancestor tags for the nav heuristic. */
export function nameTree(root: IRNode, ancestors: string[] = []): void {
  root.name = nameNode(root, ancestors);
  if (!isFrame(root)) return;
  const next = [...ancestors, root.meta.tag.toLowerCase()];
  const seen = new Map<string, number>();
  for (const child of (root as FrameNode).children) {
    nameTree(child, next);
    // Disambiguate repeated siblings so the layer list stays navigable.
    const count = (seen.get(child.name) ?? 0) + 1;
    seen.set(child.name, count);
    if (count > 1) child.name = `${child.name} ${count}`;
  }
}
