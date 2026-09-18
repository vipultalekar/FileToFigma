import type { IRDocument } from '@web2figma/ir';
import { IR_VERSION, NODE_CEILING, countNodes } from '@web2figma/ir';
import { Stopwatch, WarningSink } from '@web2figma/shared';
import { inferDocumentLayout, type LayoutStats } from './layout/index.js';
import { normalise, type NormaliseStats } from './normalize/index.js';

/**
 * Raw IR -> final IR. Pure, isomorphic, no DOM and no Figma types: this is the
 * package that must compile and test in plain Node (PRD section 16 rule 2).
 */

export interface TransformOptions {
  /** Tier 2 axis score threshold. */
  threshold?: number;
  /** Leave everything absolutely positioned (the M1 milestone behaviour). */
  disableAutoLayout?: boolean;
  /** Refuse documents above the node ceiling rather than building them. */
  enforceNodeCeiling?: boolean;
}

export interface TransformResult {
  doc: IRDocument;
  stats: {
    nodesIn: number;
    nodesOut: number;
    normalise: NormaliseStats;
    layout: LayoutStats;
    timings: { stage: string; ms: number }[];
  };
}

export class NodeCeilingError extends Error {
  constructor(public readonly nodes: number) {
    super(
      `Document has ${nodes} nodes, above the ${NODE_CEILING} ceiling. Capture a section instead.`,
    );
    this.name = 'NodeCeilingError';
  }
}

export function transformDocument(
  doc: IRDocument,
  options: TransformOptions = {},
): TransformResult {
  if (doc.version !== IR_VERSION) {
    throw new Error(`Unsupported IR version ${doc.version}, expected ${IR_VERSION}`);
  }

  const watch = new Stopwatch();
  const warnings = new WarningSink();
  warnings.absorb(doc.warnings);

  const nodesIn = countNodes(doc.root);
  if (options.enforceNodeCeiling !== false && nodesIn > NODE_CEILING) {
    throw new NodeCeilingError(nodesIn);
  }

  const normaliseStats = normalise(doc, warnings);
  watch.mark('normalise');

  const layoutOptions: Parameters<typeof inferDocumentLayout>[1] = { warnings };
  if (options.threshold !== undefined) layoutOptions.threshold = options.threshold;
  if (options.disableAutoLayout) layoutOptions.disabled = true;
  const layoutStats = inferDocumentLayout(doc, layoutOptions);
  watch.mark('layout');

  doc.warnings = warnings.all;

  return {
    doc,
    stats: {
      nodesIn,
      nodesOut: countNodes(doc.root),
      normalise: normaliseStats,
      layout: layoutStats,
      timings: watch.timings,
    },
  };
}

/** Auto Layout coverage, the M4 acceptance metric (PRD section 14). */
export function autoLayoutCoverage(stats: LayoutStats): number {
  return stats.frames === 0 ? 0 : stats.withLayout / stats.frames;
}
