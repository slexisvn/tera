const NS = 'http://www.w3.org/2000/svg';

type SvgAttributes = Record<string, string | number | boolean | null | undefined>;

export function svgElement(name: string, attrs: SvgAttributes = {}): SVGElement {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) element.setAttribute(key, String(value));
  }
  return element;
}

export function svgText(text: string | number, attrs: SvgAttributes = {}): SVGElement {
  const element = svgElement('text', attrs);
  element.textContent = String(text);
  return element;
}

export function formatTick(value: string | number): string {
  if (typeof value !== 'number') return String(value);
  const abs = Math.abs(value);
  if ((abs >= 1000000 || (abs > 0 && abs < 0.001))) return value.toExponential(2);
  return Number(value.toPrecision(5)).toString();
}

export function formatValue(value: unknown): string {
  return typeof value === 'number' ? Number(value.toPrecision(6)).toString() : String(value);
}
