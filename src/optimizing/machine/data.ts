import type { MachineDatum } from "./ir.js";
import {
  byteEscapedLiteral,
  codeUnitByteLength,
  codeUnitBytes,
  codeUnitList,
  terminatedCodeUnits,
} from "../target/text-literal.js";

export type MachineDataItem =
  | { readonly kind: "integer"; readonly value: bigint; readonly size: number }
  | { readonly kind: "ascii"; readonly text: string; readonly terminated: boolean }
  | { readonly kind: "utf16"; readonly text: string }
  | { readonly kind: "zero"; readonly size: number };

export interface DataSectionDirectives {
  readonly readOnly: string;
  readonly writable: string;
}

const INTEGER_DIRECTIVES = new Map<number, string>([
  [1, ".byte"],
  [2, ".short"],
  [4, ".long"],
  [8, ".quad"],
]);

const encoder = new TextEncoder();

export function integerData(value: bigint | number, size: number): MachineDataItem {
  return { kind: "integer", value: BigInt(value), size };
}

export function asciiData(text: string, terminated = true): MachineDataItem {
  return { kind: "ascii", text, terminated };
}

export function utf16Data(text: string): MachineDataItem {
  return { kind: "utf16", text };
}

export function zeroData(size: number): MachineDataItem {
  return { kind: "zero", size };
}

export function zeroFilledBuffer(bytes: number): readonly MachineDataItem[] {
  return [zeroData(bytes)];
}

export function dataItemSize(item: MachineDataItem): number {
  if (item.kind === "integer") return item.size;
  if (item.kind === "zero") return item.size;
  if (item.kind === "utf16") return codeUnitByteLength(item.text);
  return encoder.encode(item.text).length + (item.terminated ? 1 : 0);
}

export function dataItemBytes(item: MachineDataItem): number[] {
  if (item.kind === "zero") return new Array<number>(item.size).fill(0);
  if (item.kind === "utf16") return [...codeUnitBytes(item.text)];
  if (item.kind === "ascii") {
    const bytes = [...encoder.encode(item.text)];
    if (item.terminated) bytes.push(0);
    return bytes;
  }
  const bytes: number[] = [];
  let remaining = BigInt.asUintN(item.size * 8, item.value);
  for (let index = 0; index < item.size; index++) {
    bytes.push(Number(remaining & 0xffn));
    remaining >>= 8n;
  }
  return bytes;
}

export function machineDataBytes(items: readonly MachineDataItem[]): number[] {
  return items.flatMap((item) => dataItemBytes(item));
}

export function machineDataSize(items: readonly MachineDataItem[]): number {
  return items.reduce((total, item) => total + dataItemSize(item), 0);
}

export function dataItemText(item: MachineDataItem): string {
  if (item.kind === "zero") return `\t.zero ${item.size}`;
  if (item.kind === "ascii") {
    return `\t${item.terminated ? ".asciz" : ".ascii"} ${byteEscapedLiteral(item.text)}`;
  }
  if (item.kind === "utf16") {
    return `\t.short ${codeUnitList(terminatedCodeUnits(item.text))}`;
  }
  const directive = INTEGER_DIRECTIVES.get(item.size);
  if (directive === undefined) throw new Error(`no data directive for ${item.size} bytes`);
  const magnitude = BigInt.asUintN(item.size * 8, item.value);
  return `\t${directive} 0x${magnitude.toString(16).padStart(item.size * 2, "0")}`;
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
    for (const entry of item.items) lines.push(dataItemText(entry));
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

export const INT32_DECIMAL_BYTES = "-2147483648".length + 1;

