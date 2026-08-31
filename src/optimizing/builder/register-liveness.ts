import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import {
  closureCapturedSlots,
  controlEffectOf,
  forEachRegisterRead,
  forEachRegisterWrite,
  jumpTargetOf,
  registerEffectsOf,
} from "../../bytecode/register/ops/register-effects.js";
import { handlerStacksOf } from "./throw-recovery.js";

const WORD_BITS = 32;
const WORD_SHIFT = Math.log2(WORD_BITS);
const WORD_MASK = WORD_BITS - 1;

const wordOf = (slot: number): number => slot >>> WORD_SHIFT;
const bitOf = (slot: number): number => 1 << (slot & WORD_MASK);

export interface RegisterLiveness {
  isLive(offset: number, slot: number): boolean;
}

interface CacheEntry {
  readonly instructionCount: number;
  readonly liveness: RegisterLiveness | null;
}

const cache = new WeakMap<RegisterCompiledFunction, CacheEntry>();

export function registerLiveness(
  compiledFn: RegisterCompiledFunction | null | undefined,
): RegisterLiveness | null {
  if (!compiledFn || !Array.isArray(compiledFn.instructions)) return null;
  const cached = cache.get(compiledFn);
  if (cached && cached.instructionCount === compiledFn.instructions.length) {
    return cached.liveness;
  }
  const liveness = analyze(compiledFn);
  cache.set(compiledFn, {
    instructionCount: compiledFn.instructions.length,
    liveness,
  });
  return liveness;
}

function successorsOf(
  compiledFn: RegisterCompiledFunction,
  handlerStacks: ReadonlyArray<readonly number[]>,
): number[][] {
  const instructions = compiledFn.instructions;
  const successors: number[][] = new Array(instructions.length);
  for (let index = 0; index < instructions.length; index++) {
    const instruction = instructions[index]!;
    const control = controlEffectOf(instruction.opcode);
    const targets: number[] = [];
    const jump = jumpTargetOf(instruction);
    if (jump !== null) targets.push(jump);
    if (control !== "jump" && control !== "terminate") targets.push(index + 1);
    for (const handler of handlerStacks[index] ?? []) targets.push(handler);
    successors[index] = targets.filter(
      (target) => target >= 0 && target < instructions.length,
    );
  }
  return successors;
}

function analyze(compiledFn: RegisterCompiledFunction): RegisterLiveness | null {
  const instructions = compiledFn.instructions;
  const count = instructions.length;
  const slotCount = Math.max(
    compiledFn.registerCount,
    compiledFn.localCount,
    compiledFn.paramCount,
  );
  if (count === 0 || slotCount === 0) return null;
  for (const instruction of instructions) {
    if (!registerEffectsOf(instruction.opcode)) return null;
  }

  const width = Math.ceil(slotCount / WORD_BITS);
  const read = new Uint32Array(count * width);
  const written = new Uint32Array(count * width);
  const live = new Uint32Array(count * width);

  const inRange = (slot: number) => slot >= 0 && slot < slotCount;
  const captured = new Uint32Array(width);
  for (const slot of closureCapturedSlots(compiledFn)) {
    if (inRange(slot)) captured[wordOf(slot)]! |= bitOf(slot);
  }
  for (let index = 0; index < count; index++) {
    const base = index * width;
    const instruction = instructions[index]!;
    forEachRegisterWrite(instruction, (slot) => {
      if (inRange(slot)) written[base + wordOf(slot)] |= bitOf(slot);
    });
    forEachRegisterRead(instruction, (slot) => {
      if (inRange(slot)) read[base + wordOf(slot)] |= bitOf(slot);
    });
  }

  const hasHandlers = instructions.some(
    (instruction) => controlEffectOf(instruction.opcode) === "enter-handler",
  );
  const successors = successorsOf(
    compiledFn,
    hasHandlers ? handlerStacksOf(instructions) : [],
  );
  const predecessors: number[][] = Array.from({ length: count }, () => []);
  for (let index = 0; index < count; index++) {
    for (const target of successors[index]!) predecessors[target]!.push(index);
  }

  const queued = new Uint8Array(count).fill(1);
  const worklist: number[] = [];
  for (let index = 0; index < count; index++) worklist.push(index);
  const outgoing = new Uint32Array(width);

  while (worklist.length > 0) {
    const index = worklist.pop()!;
    queued[index] = 0;
    outgoing.fill(0);
    for (const target of successors[index]!) {
      const targetBase = target * width;
      for (let word = 0; word < width; word++) {
        outgoing[word]! |= live[targetBase + word]!;
      }
    }
    const base = index * width;
    let changed = false;
    for (let word = 0; word < width; word++) {
      const next =
        ((outgoing[word]! & ~written[base + word]!) | read[base + word]!) >>> 0;
      if (next === live[base + word]) continue;
      live[base + word] = next;
      changed = true;
    }
    if (!changed) continue;
    for (const source of predecessors[index]!) {
      if (queued[source]) continue;
      queued[source] = 1;
      worklist.push(source);
    }
  }

  return {
    isLive(offset: number, slot: number): boolean {
      if (offset < 0 || offset >= count) return true;
      if (!inRange(slot)) return true;
      const word = wordOf(slot);
      const held = live[offset * width + word]! | captured[word]!;
      return (held & bitOf(slot)) !== 0;
    },
  };
}
