import type { MachineDatum } from "./ir.js";

export interface DataSectionDirectives {
  readonly readOnly: string;
  readonly writable: string;
}

function log2(value: number): number {
  return Math.max(0, Math.round(Math.log2(value)));
}

function sectionText(directive: string, items: readonly MachineDatum[]): string[] {
  if (items.length === 0) return [];
  const lines = [directive];
  for (const item of items) {
    lines.push(`\t.p2align ${log2(item.alignment)}`);
    lines.push(`${item.label}:`);
    lines.push(...item.directives);
  }
  return lines;
}

export function machineDataText(
  items: readonly MachineDatum[],
  directives: DataSectionDirectives,
): string {
  if (items.length === 0) return "";
  const lines = [
    ...sectionText(
      directives.readOnly,
      items.filter((item) => !item.writable),
    ),
    ...sectionText(
      directives.writable,
      items.filter((item) => item.writable),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export function zeroFilledBuffer(bytes: number): readonly string[] {
  return [`\t.zero ${bytes}`];
}

export const INT32_DECIMAL_BYTES = "-2147483648".length + 1;
