import { expect } from "vitest";
import { nodeEngine } from "./engine.js";

export function assemblyLinesOf(source: string): string[] {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-linux",
  });
  expect(program.skipped).toEqual([]);
  const file = program.files.find((candidate) => candidate.name.endsWith(".s"))!;
  return String(file.contents).split("\n");
}

export function bodyOf(source: string, name: string): string[] {
  const lines = assemblyLinesOf(source);
  const from = lines.indexOf(`${name}:`);
  expect(from).toBeGreaterThanOrEqual(0);
  const body: string[] = [];
  for (const line of lines.slice(from + 1)) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith(".")) continue;
    if (text.endsWith(":")) break;
    body.push(text);
  }
  return body;
}

export function mnemonicsOf(source: string, name: string): string[] {
  return bodyOf(source, name).map((line) => line.split(/\s+/)[0]!);
}
