import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

function initialTheme(storageKey: string): Theme {
  const stored = localStorage.getItem(storageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(storageKey: string): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => initialTheme(storageKey));
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(storageKey, theme);
  }, [storageKey, theme]);
  const toggle = useCallback(() => setTheme((current) => (current === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
