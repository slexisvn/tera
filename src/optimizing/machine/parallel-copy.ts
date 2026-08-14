export interface ParallelCopy<T> {
  readonly destination: T;
  readonly source: T;
}

export function sequenceParallelCopies<T>(
  copies: readonly ParallelCopy<T>[],
  emit: (destination: T, source: T) => void,
  createTemp: (like: T) => T,
): void {
  const predecessor = new Map<T, T>();
  const location = new Map<T, T>();
  const pending: T[] = [];

  for (const copy of copies) {
    if (copy.destination === copy.source) continue;
    predecessor.set(copy.destination, copy.source);
    location.set(copy.source, copy.source);
    pending.push(copy.destination);
  }

  const ready: T[] = [];
  for (const destination of predecessor.keys()) {
    if (!location.has(destination)) ready.push(destination);
  }

  while (pending.length > 0) {
    while (ready.length > 0) {
      const destination = ready.pop()!;
      const source = predecessor.get(destination)!;
      const current = location.get(source)!;
      emit(destination, current);
      location.set(source, destination);
      if (source === current && predecessor.has(source)) ready.push(source);
    }
    const destination = pending.pop()!;
    if (destination === location.get(predecessor.get(destination)!)) continue;
    const temp = createTemp(destination);
    emit(temp, destination);
    location.set(destination, temp);
    ready.push(destination);
  }
}
