import { fitsSigned, writeInteger } from "../../../mc/buffer.js";
import { UnsupportedOperandError } from "../../../mc/errors.js";
import { fixup, type McFixup } from "../../../mc/fixup.js";
import { X64_ABSOLUTE_32, X64_PC_RELATIVE_32 } from "./fixups.js";
import { STACK_POINTER_NUMBER, FRAME_POINTER_NUMBER } from "./registers.js";

export const REX_BASE = 0x40;
export const REX_W = 0x08;
export const REX_R = 0x04;
export const REX_X = 0x02;
export const REX_B = 0x01;

export interface RmRegister {
  readonly kind: "register";
  readonly number: number;
  readonly legacyByte: boolean;
}

export interface RmMemory {
  readonly kind: "memory";
  readonly base: number | null;
  readonly index: number | null;
  readonly scale: number;
  readonly displacement: number;
  readonly symbol: string | null;
}

export type RmOperand = RmRegister | RmMemory;

export interface EncodeSink {
  readonly bytes: number[];
  readonly fixups: McFixup[];
}

export interface RexRequest {
  readonly wide: boolean;
}

export function sink(): EncodeSink {
  return { bytes: [], fixups: [] };
}

export function rmRegister(number: number, legacyByte = false): RmRegister {
  return { kind: "register", number, legacyByte };
}

function scaleBits(scale: number, opcode: string): number {
  const bits = [1, 2, 4, 8].indexOf(scale);
  if (bits < 0) throw new UnsupportedOperandError("x64", opcode, `scale ${scale}`);
  return bits;
}

function modrm(mod: number, reg: number, rm: number): number {
  return ((mod & 3) << 6) | ((reg & 7) << 3) | (rm & 7);
}

function sib(scale: number, index: number, base: number): number {
  return ((scale & 3) << 6) | ((index & 7) << 3) | (base & 7);
}

function extensionBits(rm: RmOperand, reg: number): number {
  let bits = (reg >> 3) & 1 ? REX_R : 0;
  if (rm.kind === "register") {
    if ((rm.number >> 3) & 1) bits |= REX_B;
    return bits;
  }
  if (rm.base !== null && (rm.base >> 3) & 1) bits |= REX_B;
  if (rm.index !== null && (rm.index >> 3) & 1) bits |= REX_X;
  return bits;
}

function forcesRex(rm: RmOperand): boolean {
  return rm.kind === "register" && rm.legacyByte;
}

export function emitPrefixes(
  out: EncodeSink,
  mandatory: number | undefined,
  rex: RexRequest,
  reg: number,
  rm: RmOperand,
): void {
  if (mandatory !== undefined) out.bytes.push(mandatory);
  const bits = extensionBits(rm, reg) | (rex.wide ? REX_W : 0);
  if (bits === 0 && !forcesRex(rm)) return;
  out.bytes.push(REX_BASE | bits);
}

function emitDisplacement(
  out: EncodeSink,
  value: number | bigint,
  size: number,
): void {
  const at = out.bytes.length;
  for (let index = 0; index < size; index++) out.bytes.push(0);
  writeInteger(out.bytes, at, value, size);
}

export function emitModRm(
  out: EncodeSink,
  reg: number,
  rm: RmOperand,
  opcode: string,
): void {
  if (rm.kind === "register") {
    out.bytes.push(modrm(3, reg, rm.number));
    return;
  }

  if (rm.symbol !== null) {
    if (rm.base !== null || rm.index !== null) {
      throw new UnsupportedOperandError("x64", opcode, "symbol with base or index");
    }
    out.bytes.push(modrm(0, reg, 5));
    out.fixups.push(fixup(out.bytes.length, X64_PC_RELATIVE_32, rm.symbol, rm.displacement));
    emitDisplacement(out, rm.displacement, 4);
    return;
  }

  if (rm.index === STACK_POINTER_NUMBER) {
    throw new UnsupportedOperandError("x64", opcode, "rsp cannot be an index register");
  }

  if (rm.base === null) {
    out.bytes.push(modrm(0, reg, 4));
    out.bytes.push(
      sib(
        rm.index === null ? 0 : scaleBits(rm.scale, opcode),
        rm.index ?? STACK_POINTER_NUMBER,
        FRAME_POINTER_NUMBER,
      ),
    );
    emitDisplacement(out, rm.displacement, 4);
    return;
  }

  const usesSib = rm.index !== null || (rm.base & 7) === STACK_POINTER_NUMBER;
  const anchored = rm.displacement === 0 && (rm.base & 7) !== FRAME_POINTER_NUMBER;
  const mod = anchored ? 0 : fitsSigned(rm.displacement, 8) ? 1 : 2;

  out.bytes.push(modrm(mod, reg, usesSib ? STACK_POINTER_NUMBER : rm.base));
  if (usesSib) {
    out.bytes.push(
      sib(
        rm.index === null ? 0 : scaleBits(rm.scale, opcode),
        rm.index ?? STACK_POINTER_NUMBER,
        rm.base,
      ),
    );
  }
  if (mod === 1) emitDisplacement(out, rm.displacement, 1);
  else if (mod === 2) emitDisplacement(out, rm.displacement, 4);
}

export function emitImmediate(out: EncodeSink, value: number | bigint, size: number): void {
  emitDisplacement(out, value, size);
}

export function emitAbsolute(out: EncodeSink, symbol: string, addend: number): void {
  out.fixups.push(fixup(out.bytes.length, X64_ABSOLUTE_32, symbol, addend));
  emitDisplacement(out, addend, 4);
}
