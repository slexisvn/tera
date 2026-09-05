import { TEXT_UNIT_BYTES } from "../types/scalar.js";

const PRINTABLE_LIMIT = 0x7e;
const FIRST_PRINTABLE = 0x20;
const OCTAL_DIGITS = 3;
const LOW_BYTE = 0xff;
const BYTE_BITS = 8;

const encoder = new TextEncoder();

export function codeUnitsOf(value: string): readonly number[] {
  const units: number[] = [];
  for (let at = 0; at < value.length; at += 1) units.push(value.charCodeAt(at));
  return units;
}

export function codeUnitBytes(value: string): readonly number[] {
  const bytes: number[] = [];
  for (const unit of [...codeUnitsOf(value), 0]) {
    bytes.push(unit & LOW_BYTE, (unit >>> BYTE_BITS) & LOW_BYTE);
  }
  return bytes;
}

export function codeUnitByteLength(value: string): number {
  return (value.length + 1) * TEXT_UNIT_BYTES;
}

export function codeUnitCapacity(bytes: number): number {
  return Math.floor(bytes / TEXT_UNIT_BYTES);
}

export function characterCapacity(bytes: number): number {
  return codeUnitCapacity(bytes) - 1;
}

export function codeUnitList(units: readonly number[]): string {
  return units.map((unit) => `0x${unit.toString(16)}`).join(", ");
}

export function terminatedCodeUnits(value: string): readonly number[] {
  return [...codeUnitsOf(value), 0];
}

export function codeUnitArrayLiteral(value: string): string {
  return `{${codeUnitList(terminatedCodeUnits(value))}}`;
}

export function byteEscapedLiteral(value: string): string {
  let out = '"';
  for (const byte of encoder.encode(value)) {
    const character = String.fromCharCode(byte);
    if (character === '"' || character === "\\") out += `\\${character}`;
    else if (character === "\n") out += "\\n";
    else if (character === "\t") out += "\\t";
    else if (byte < FIRST_PRINTABLE || byte > PRINTABLE_LIMIT) {
      out += `\\${byte.toString(8).padStart(OCTAL_DIGITS, "0")}`;
    } else out += character;
  }
  return `${out}"`;
}
