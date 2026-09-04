import {
  IR_CALL_BUILTIN,
  IR_CALL_KNOWN_FUNCTION,
  IR_CONSTANT,
  IR_GENERIC_CALL,
  IR_LOAD_ELEMENT,
  IR_LOAD_FIELD,
  IR_LOAD_GLOBAL,
  IR_LOAD_TEXT,
  IR_PARAMETER,
  IR_PHI,
  IR_RETURN,
  IR_STORE_ELEMENT,
  IR_STORE_FIELD,
  IR_STORE_GLOBAL,
  IR_STORE_TEXT,
  type CFGFunction,
  type CFGInstruction,
} from "../ir/index.js";
import {
  builtinMethodIntrinsicByName,
  callsBuiltin,
  INPUT_BUILTIN,
  STRING_TYPE,
} from "../metadata/builtin-methods.js";

const ASCII_LIMIT = 0x7f;
const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

export function isAsciiRepresentable(value: string): boolean {
  return utf8ByteLength(value) === value.length;
}

function wideConstant(node: CFGInstruction): boolean {
  if (node.type !== IR_CONSTANT) return false;
  const value = node.props.value;
  return typeof value === "string" && !isAsciiRepresentable(value);
}

function readsUnknownText(node: CFGInstruction): boolean {
  return callsBuiltin(node, INPUT_BUILTIN);
}

function seedsWideText(node: CFGInstruction): boolean {
  return wideConstant(node) || readsUnknownText(node);
}

const ENTERS_FROM_THE_HEAP: ReadonlySet<string> = new Set<string>([
  IR_PARAMETER,
  IR_LOAD_FIELD,
  IR_LOAD_ELEMENT,
  IR_LOAD_GLOBAL,
  IR_LOAD_TEXT,
]);

const LEAVES_FOR_THE_HEAP: ReadonlySet<string> = new Set<string>([
  IR_RETURN,
  IR_STORE_FIELD,
  IR_STORE_ELEMENT,
  IR_STORE_GLOBAL,
  IR_STORE_TEXT,
  IR_CALL_KNOWN_FUNCTION,
  IR_GENERIC_CALL,
]);

export interface WideTextModel {
  readonly escapes: boolean;
  readonly reason: string | null;
}

export const NARROW_TEXT: WideTextModel = { escapes: false, reason: null };

function spellsWideText(graph: CFGFunction): boolean {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (seedsWideText(node)) return true;
    }
  }
  return false;
}

export function wideValuesIn(
  graph: CFGFunction,
  escapes: boolean,
  isText: (value: CFGInstruction) => boolean,
): ReadonlySet<CFGInstruction> {
  const wide = new Set<CFGInstruction>();
  const pending: CFGInstruction[] = [];
  const mark = (node: CFGInstruction): void => {
    if (wide.has(node) || (node.type !== IR_PHI && !isText(node))) return;
    wide.add(node);
    pending.push(node);
  };

  if (escapes) {
    for (const parameter of graph.parameters) mark(parameter);
  }
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (seedsWideText(node) || (escapes && ENTERS_FROM_THE_HEAP.has(node.type))) mark(node);
    }
  }
  while (pending.length > 0) {
    for (const use of pending.pop()!.uses) mark(use);
  }
  return wide;
}

function letsTextEscape(
  graph: CFGFunction,
  wide: ReadonlySet<CFGInstruction>,
): boolean {
  for (const block of graph.blocks) {
    for (const node of block.nodes) {
      if (!LEAVES_FOR_THE_HEAP.has(node.type)) continue;
      if (node.inputs.some((input) => wide.has(input))) return true;
    }
  }
  return false;
}

export interface WideTextUnit {
  readonly graph: CFGFunction;
  readonly isText: (value: CFGInstruction) => boolean;
}

export function summarizeWideText(units: readonly WideTextUnit[]): WideTextModel {
  if (!units.some(({ graph }) => spellsWideText(graph))) return NARROW_TEXT;

  let escapes = false;
  let escaping: string | null = null;
  for (const { graph, isText } of units) {
    if (!letsTextEscape(graph, wideValuesIn(graph, false, isText))) continue;
    escapes = true;
    escaping = graph.name;
    break;
  }
  return { escapes, reason: escaping };
}

export const COUNTS_CHARACTERS: ReadonlySet<string> = new Set<string>([
  "length",
  "char_at",
  "char_code_at",
  "slice",
  "index_of",
  "pad_start",
  "pad_end",
  "to_upper_case",
  "to_lower_case",
  "trim",
  "trim_start",
  "trim_end",
]);

export const BYTEWISE_PROP = "bytewise";

export function countsCharacters(node: CFGInstruction): boolean {
  if (node.type !== IR_CALL_BUILTIN || node.props[BYTEWISE_PROP] === true) return false;
  const intrinsic = builtinMethodIntrinsicByName(String(node.props.name));
  return (
    intrinsic !== null && intrinsic.owner === STRING_TYPE && COUNTS_CHARACTERS.has(intrinsic.name)
  );
}

export function isAsciiCharacterCode(code: number): boolean {
  return code <= ASCII_LIMIT;
}

export function wideTextReason(what: string): string {
  return (
    `${what} counts characters, and this text holds some outside ASCII, which a compiled ` +
    `string stores as several bytes each; print it, join it, compare it or search it for a ` +
    `substring, or keep this part interpreted`
  );
}
