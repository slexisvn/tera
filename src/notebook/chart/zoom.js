export const MIN_ZOOM_RATIO = 0.001;

export function zoomDomain(domain, anchor, factor, bounds) {
  const baseSpan = span(bounds);
  const currentSpan = span(domain);
  const nextSpan = clamp(currentSpan * factor, baseSpan * MIN_ZOOM_RATIO, baseSpan);
  const ratio = currentSpan === 0 ? 0.5 : (anchor - domain[0]) / currentSpan;
  const next = [anchor - nextSpan * ratio, anchor + nextSpan * (1 - ratio)];
  return clampDomain(next, bounds);
}

export function panDomain(domain, shift, bounds) {
  return clampDomain([domain[0] + shift, domain[1] + shift], bounds);
}

export function clampDomain(domain, bounds) {
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

export function domainsEqual(left, right, epsilon = 1e-10) {
  return Math.abs(left[0] - right[0]) <= epsilon && Math.abs(left[1] - right[1]) <= epsilon;
}

function span(domain) {
  return domain[1] - domain[0];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
