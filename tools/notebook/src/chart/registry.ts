import type { ChartRenderer } from './types';

const renderers = new Map<string, ChartRenderer>();

export function registerRenderer(type: string, renderer: ChartRenderer): void {
  if (typeof renderer !== 'function') throw new Error('Chart renderer must be a function');
  renderers.set(type, renderer);
}

export function getRenderer(type: string): ChartRenderer {
  const renderer = renderers.get(type);
  if (!renderer) throw new Error(`No renderer registered for chart type '${type}'`);
  return renderer;
}

export function rendererTypes(): string[] {
  return [...renderers.keys()];
}
