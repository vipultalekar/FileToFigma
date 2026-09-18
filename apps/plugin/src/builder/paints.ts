import type { Effect as IREffect, Paint as IRPaint, Stroke } from '@web2figma/ir';

/**
 * IR paints and effects -> Figma paints and effects.
 *
 * Purely mechanical: every decision was made in the transform package. If a
 * branch here needs a heuristic, the logic is in the wrong module.
 */

export type ImageHashMap = Map<string, string>;

export function toFigmaPaint(paint: IRPaint, images: ImageHashMap): Paint | null {
  if (paint.type === 'SOLID') {
    return {
      type: 'SOLID',
      color: paint.color,
      opacity: paint.opacity,
    };
  }
  if (paint.type === 'IMAGE') {
    const hash = images.get(paint.assetId);
    if (!hash) return null;
    // Figma's paint types are readonly, so each paint is built as one literal.
    return {
      type: 'IMAGE',
      imageHash: hash,
      scaleMode: paint.scaleMode,
      ...(paint.opacity !== undefined ? { opacity: paint.opacity } : {}),
      ...(paint.scaleMode === 'TILE' ? { scalingFactor: paint.scalingFactor ?? 1 } : {}),
      ...(paint.imageTransform ? { imageTransform: paint.imageTransform as Transform } : {}),
    } as ImagePaint;
  }
  return {
    type: paint.type,
    gradientTransform: paint.transform as Transform,
    gradientStops: paint.stops.map((s) => ({
      position: s.position,
      color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
    })),
    ...(paint.opacity !== undefined ? { opacity: paint.opacity } : {}),
  } as GradientPaint;
}

export function toFigmaPaints(paints: readonly IRPaint[], images: ImageHashMap): Paint[] {
  const out: Paint[] = [];
  for (const p of paints) {
    const mapped = toFigmaPaint(p, images);
    if (mapped) out.push(mapped);
  }
  return out;
}

export function toFigmaEffect(effect: IREffect): Effect {
  if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
    return {
      type: effect.type,
      color: effect.color,
      offset: effect.offset,
      radius: effect.radius,
      spread: effect.spread,
      visible: true,
      blendMode: 'NORMAL',
    } as DropShadowEffect;
  }
  return { type: effect.type, radius: effect.radius, visible: true } as BlurEffect;
}

export function applyStrokes(
  node: GeometryMixin & MinimalStrokesMixin,
  strokes: readonly Stroke[],
  images: ImageHashMap,
): void {
  if (strokes.length === 0) return;
  const first = strokes[0] as Stroke;
  const paint = toFigmaPaint(first.paint, images);
  if (!paint) return;
  node.strokes = [paint];
  node.strokeAlign = first.align;
  node.strokeWeight = typeof first.weight === 'number' ? first.weight : Math.max(...first.weight);
  if (first.dash) node.dashPattern = first.dash;
}
