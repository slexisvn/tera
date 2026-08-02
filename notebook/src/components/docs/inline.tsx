import type { ReactNode } from "react";

export function renderInline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`)/g)
    .filter(Boolean)
    .map((part, index) =>
      part.length > 1 && part.startsWith("`") && part.endsWith("`")
        ? <code key={index}>{part.slice(1, -1)}</code>
        : <span key={index}>{part}</span>);
}
