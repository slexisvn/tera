export const SYNC = 'sync';
export const ASYNC = 'async';

export function joinEffect(...effects) {
  return effects.some(effect => effect === ASYNC) ? ASYNC : SYNC;
}

export function isAsyncEffect(effect) {
  return effect === ASYNC;
}

export const BUILTIN_EFFECTS = new Map([
  ['print', ASYNC],
  ['compile', ASYNC],
  ['backtest', ASYNC],
  ['walk_forward', ASYNC],
  ['sharpe', ASYNC],
  ['deflated_sharpe', ASYNC],
  ['pbo', ASYNC],
  ['min_track_record_length', ASYNC],
  ['risk_parity', ASYNC],
  ['hrp', ASYNC],
  ['mean_variance', ASYNC],
]);

export const METHOD_EFFECTS = new Map([
  ['DataFrame', new Map([
    ['collect', ASYNC],
    ['toArray', ASYNC],
    ['to_array', ASYNC],
    ['count', ASYNC],
    ['show', ASYNC],
    ['chunks', ASYNC],
    ['toTensor', ASYNC],
    ['to_tensor', ASYNC],
    ['encode', ASYNC],
  ])],
  ['Tensor', new Map([
    ['to', ASYNC],
    ['item', ASYNC],
    ['toArray', ASYNC],
    ['tolist', ASYNC],
  ])],
  ['Model', new Map([
    ['to', ASYNC],
  ])],
  ['Compiled', new Map([
    ['result', ASYNC],
  ])],
  ['chart', new Map([
    ['line', ASYNC],
    ['bar', ASYNC],
    ['scatter', ASYNC],
    ['histogram', ASYNC],
    ['area', ASYNC],
    ['box', ASYNC],
    ['violin', ASYNC],
    ['density', ASYNC],
    ['correlation', ASYNC],
    ['hexbin', ASYNC],
    ['heatmap', ASYNC],
    ['regression', ASYNC],
    ['ecdf', ASYNC],
    ['bubble', ASYNC],
    ['funnel', ASYNC],
    ['waterfall', ASYNC],
  ])],
]);

export function builtinEffect(name) {
  return BUILTIN_EFFECTS.get(name) ?? SYNC;
}

export function methodEffect(typeName, property) {
  return METHOD_EFFECTS.get(typeName)?.get(property) ?? SYNC;
}
