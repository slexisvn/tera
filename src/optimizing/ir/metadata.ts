import * as ir from "./index.js";

export function metadataString(value: ir.IRMetadataValue): string | null {
  return typeof value === "string" ? value : null;
}

export function metadataNumber(value: ir.IRMetadataValue): number | null {
  return typeof value === "number" ? value : null;
}

export function metadataNumberArray(value: ir.IRMetadataValue): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number") return null;
    numbers.push(item);
  }
  return numbers;
}

export function metadataStringArray(value: ir.IRMetadataValue): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    strings.push(item);
  }
  return strings;
}
