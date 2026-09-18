import type { Warning, WarningSeverity } from '@web2figma/ir';

/**
 * A collector every module threads through its calls. PRD section 16 rule 6:
 * log, never swallow. A silent catch is a bug, so degradation always lands here.
 */
export class WarningSink {
  private readonly items: Warning[] = [];

  push(
    nodeId: string,
    severity: WarningSeverity,
    property: string,
    message: string,
    fallbackApplied?: string,
  ): void {
    const w: Warning = { nodeId, severity, property, message };
    if (fallbackApplied !== undefined) w.fallbackApplied = fallbackApplied;
    this.items.push(w);
  }

  info(nodeId: string, property: string, message: string, fallback?: string): void {
    this.push(nodeId, 'info', property, message, fallback);
  }

  degraded(nodeId: string, property: string, message: string, fallback?: string): void {
    this.push(nodeId, 'degraded', property, message, fallback);
  }

  dropped(nodeId: string, property: string, message: string, fallback?: string): void {
    this.push(nodeId, 'dropped', property, message, fallback);
  }

  absorb(warnings: readonly Warning[]): void {
    this.items.push(...warnings);
  }

  get all(): Warning[] {
    return this.items;
  }

  get count(): number {
    return this.items.length;
  }

  /** Grouped by property, for the conversion report. */
  byProperty(): Record<string, Warning[]> {
    const out: Record<string, Warning[]> = {};
    for (const w of this.items) (out[w.property] ??= []).push(w);
    return out;
  }
}

export function groupWarnings(warnings: readonly Warning[]): {
  property: string;
  severity: WarningSeverity;
  count: number;
  nodeIds: string[];
  message: string;
}[] {
  const map = new Map<
    string,
    { property: string; severity: WarningSeverity; count: number; nodeIds: string[]; message: string }
  >();
  for (const w of warnings) {
    const key = `${w.property}::${w.severity}`;
    const entry = map.get(key);
    if (entry) {
      entry.count++;
      entry.nodeIds.push(w.nodeId);
    } else {
      map.set(key, {
        property: w.property,
        severity: w.severity,
        count: 1,
        nodeIds: [w.nodeId],
        message: w.message,
      });
    }
  }
  // Most severe first, then most frequent.
  const rank: Record<WarningSeverity, number> = { dropped: 0, degraded: 1, info: 2 };
  return [...map.values()].sort(
    (a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count,
  );
}
