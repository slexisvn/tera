import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(handle);
  }, [delayMs, value]);

  return settled;
}
