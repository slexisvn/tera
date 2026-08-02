import { useCallback, useEffect, useState } from "react";
import { THEME_KEY } from "../config/constants";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((current) => (current === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}
