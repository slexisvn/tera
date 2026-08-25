export const MIN_ZOOM_RATIO = 0.001;

export type NumericDomain = [number, number];

export function zoomDomain(domain: NumericDomain, anchor: number, factor: number, bounds: NumericDomain): NumericDomain {
  const baseSpan = span(bounds);
  const currentSpan = span(domain);
  const nextSpan = clamp(currentSpan * factor, baseSpan * MIN_ZOOM_RATIO, baseSpan);
  const ratio = currentSpan === 0 ? 0.5 : (anchor - domain[0]) / currentSpan;
  const next: NumericDomain = [anchor - nextSpan * ratio, anchor + nextSpan * (1 - ratio)];
  return clampDomain(next, bounds);
}

export function panDomain(domain: NumericDomain, shift: number, bounds: NumericDomain): NumericDomain {
  return clampDomain([domain[0] + shift, domain[1] + shift], bounds);
}

export function clampDomain(domain: NumericDomain, bounds: NumericDomain): NumericDomain {
  const width = Math.min(span(domain), span(bounds));
  let min = domain[0];
  let max = min + width;
  if (min < bounds[0]) {
    min = bounds[0];
    max = min + width;
  }
  if (max > bounds[1]) {
    max = bounds[1];
    min = max - width;
  }
  return [min, max];
}

export function domainsEqual(left: NumericDomain, right: NumericDomain, epsilon = 1e-10): boolean {
  return Math.abs(left[0] - right[0]) <= epsilon && Math.abs(left[1] - right[1]) <= epsilon;
}

function span(domain: NumericDomain): number {
  return domain[1] - domain[0];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
