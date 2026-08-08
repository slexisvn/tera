export type DispatchHandler<C> = (context: C) => void;

export function buildDispatch<K, C>(
  entries: Iterable<readonly [K, DispatchHandler<C>]>,
): (key: K, context: C) => boolean {
  const table = new Map<K, DispatchHandler<C>>(entries);
  return (key, context) => {
    const handler = table.get(key);
    if (handler === undefined) return false;
    handler(context);
    return true;
  };
}
