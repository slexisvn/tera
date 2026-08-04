import fs from "fs";
import { HISTORY_LIMIT, historyFilePath } from "./config.js";

export type History = {
  entries: string[];
  push(line: string): void;
};

function loadEntries(file: string): string[] {
  try {
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n").map((line) => line.replace(/\r$/, "")).filter(Boolean);
    return lines.length > HISTORY_LIMIT ? lines.slice(lines.length - HISTORY_LIMIT) : lines;
  } catch {
    return [];
  }
}

export function createHistory(): History {
  const file = historyFilePath();
  const entries = loadEntries(file);
  return {
    entries,
    push(line) {
      const trimmed = line.replace(/\n+$/, "");
      if (!trimmed.trim()) return;
      if (entries[entries.length - 1] === trimmed) return;
      entries.push(trimmed);
      if (entries.length > HISTORY_LIMIT) entries.shift();
      try {
        fs.appendFileSync(file, `${trimmed.replace(/\n/g, " ")}\n`);
      } catch {}
    },
  };
}
