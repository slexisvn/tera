const renderers = new Map();

export function registerRenderer(type, renderer) {
  if (typeof renderer !== 'function') throw new Error('Chart renderer must be a function');
  renderers.set(type, renderer);
}

export function getRenderer(type) {
  const renderer = renderers.get(type);
  if (!renderer) throw new Error(`No renderer registered for chart type '${type}'`);
  return renderer;
}

export function rendererTypes() {
  return [...renderers.keys()];
}
