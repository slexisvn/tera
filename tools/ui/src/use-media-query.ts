import { useCallback, useMemo, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const list = useMemo(() => window.matchMedia(query), [query]);
  const subscribe = useCallback(
    (changed: () => void) => {
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    [list],
  );
  return useSyncExternalStore(
    subscribe,
    () => list.matches,
    () => false,
  );
}
