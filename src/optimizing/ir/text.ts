import { FrameState } from "../../deopt/frame-state.js";
import {
  CFGBlock,
  CFGFunction,
  CFGInstruction,
  IR_PARAMETER,
  IR_PHI,
  isOpcode,
  type IRMetadata,
  type IRMetadataValue,
} from "./index.js";

export class IRTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IRTextError";
  }
}

export class OpaqueValue {
  constructor(readonly label: string) {}
}

const OPAQUE_PATTERN = /^<opaque:([A-Za-z0-9_]+)>$/;

function opaqueLabel(value: object): string {
  const named = value.constructor?.name ?? "Object";
  const sanitized = named.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized === "" ? "Object" : sanitized;
}
const FRAME_STATE_MARK = "!fs";
const LOOP_HEADER_MARK = "loop-header";
const INDENT = "  ";

function printNumber(value: number): string {
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return String(value);
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function printValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (value instanceof CFGInstruction) return `v${value.id}`;
  if (value instanceof CFGBlock) return `B${value.id}`;
  switch (typeof value) {
    case "number":
      return printNumber(value);
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "string":
      return JSON.stringify(value);
    default:
      break;
  }
  if (value instanceof OpaqueValue) return `<opaque:${value.label}>`;
  if (value instanceof Map) {
    const entries = [...value.entries()];
    return `Map{${entries.map(([key, held]) => `${printValue(key)}: ${printValue(held)}`).join(", ")}}`;
  }
  if (value instanceof Set) return `Set{${[...value].map(printValue).join(", ")}}`;
  if (Array.isArray(value)) return `[${value.map(printValue).join(", ")}]`;
  if (typeof value === "object" && isPlainRecord(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, held]) => `${key}: ${printValue(held)}`).join(", ")}}`;
  }
  return `<opaque:${opaqueLabel(value as object)}>`;
}

function printProps(props: IRMetadata): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return "";
  return ` [${entries.map(([key, value]) => `${key}=${printValue(value)}`).join(", ")}]`;
}

function printNode(node: CFGInstruction): string {
  const inputs = node.inputs.map((input) => `v${input.id}`).join(", ");
  const frameState = node.frameState === null ? "" : ` ${FRAME_STATE_MARK}`;
  return `v${node.id} = ${node.type}${inputs === "" ? "" : ` ${inputs}`}${printProps(node.props)}${frameState}`;
}

function printBlockHeader(block: CFGBlock): string {
  const parts = [`B${block.id}`];
  if (block.isLoopHeader) parts.push(LOOP_HEADER_MARK);
  parts.push(`succs=${block.successors.map((next) => `B${next.id}`).join(",")}`);
  parts.push(`preds=${block.predecessors.map((prior) => `B${prior.id}`).join(",")}`);
  return `${parts.join(" ")}:`;
}

export const GRAPH_FIELDS = [
  "isAsync",
  "isGenerator",
  "resumable",
  "receiver",
  "internal",
  "reentrant",
  "recoversThrows",
  "gatheredArguments",
  "classOwner",
  "bailout",
  "returnRepresentation",
  "declaredSignature",
  "calleeSignatures",
  "emits",
  "classes",
  "stringEscapes",
  "osrParamSlots",
  "osrCandidates",
] as const;

type GraphField = (typeof GRAPH_FIELDS)[number];
type GraphState = Record<GraphField, unknown>;

function isDefaultValue(value: unknown, pristine: unknown): boolean {
  if (value === pristine) return true;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  return false;
}

function printGraphAttributes(graph: CFGFunction): string | null {
  const pristine = new CFGFunction(graph.name) as unknown as GraphState;
  const state = graph as unknown as GraphState;
  const entries = GRAPH_FIELDS.filter(
    (field) => !isDefaultValue(state[field], pristine[field]),
  ).map((field) => `${field}=${printValue(state[field])}`);
  return entries.length === 0 ? null : `graph [${entries.join(", ")}]`;
}

const GRAPH_BY_NAME = new Set<string>(GRAPH_FIELDS);

export function printIR(graph: CFGFunction): string {
  const lines = [`fn ${graph.name} params=${graph.parameters.length} {`];
  const attributes = printGraphAttributes(graph);
  if (attributes !== null) lines.push(`${INDENT}${attributes}`);
  for (const parameter of graph.parameters) lines.push(`${INDENT}${printNode(parameter)}`);
  for (const block of graph.blocks) {
    lines.push(`${INDENT}${printBlockHeader(block)}`);
    for (const node of block.nodes) lines.push(`${INDENT}${INDENT}${printNode(node)}`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

interface PendingNode {
  readonly node: CFGInstruction;
  readonly inputs: readonly string[];
  readonly props: readonly (readonly [string, string])[];
}

class Cursor {
  private at = 0;

  constructor(private readonly text: string) {}

  get rest(): string {
    return this.text.slice(this.at);
  }

  get done(): boolean {
    this.skipSpace();
    return this.at >= this.text.length;
  }

  skipSpace(): void {
    while (this.at < this.text.length && /\s/.test(this.text[this.at]!)) this.at++;
  }

  take(pattern: RegExp): string | null {
    this.skipSpace();
    const anchored = new RegExp(`^(?:${pattern.source})`, pattern.flags.replace("g", ""));
    const found = anchored.exec(this.text.slice(this.at));
    if (found === null) return null;
    this.at += found[0].length;
    return found[0];
  }

  expect(pattern: RegExp, what: string): string {
    const found = this.take(pattern);
    if (found === null) {
      throw new IRTextError(`expected ${what} at "${this.rest.slice(0, 24)}"`);
    }
    return found;
  }
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const character = text[at]!;
    if (quoted) {
      if (character === "\\") at++;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[" || character === "{") depth++;
    else if (character === "]" || character === "}") depth--;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, at));
      start = at + 1;
    }
  }
  const tail = text.slice(start);
  if (tail.trim() !== "" || parts.length > 0) parts.push(tail);
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

function parseValue(text: string, nodeOf: (name: string) => CFGInstruction): IRMetadataValue {
  const token = text.trim();
  if (token === "null") return null;
  if (token === "undefined") return undefined;
  if (token === "true") return true;
  if (token === "false") return false;
  const opaque = OPAQUE_PATTERN.exec(token);
  if (opaque !== null) return new OpaqueValue(opaque[1]!) as unknown as IRMetadataValue;
  if (/^v\d+$/.test(token)) return nodeOf(token);
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      throw new IRTextError(`malformed string ${token}`);
    }
  }
  if (/^-?\d+n$/.test(token)) return BigInt(token.slice(0, -1)) as unknown as IRMetadataValue;
  if (token.startsWith("Map{") && token.endsWith("}")) {
    const held = new Map<IRMetadataValue, IRMetadataValue>();
    for (const entry of splitTopLevel(token.slice(4, -1))) {
      const split = entry.indexOf(":");
      if (split < 0) throw new IRTextError(`malformed map entry ${entry}`);
      held.set(parseValue(entry.slice(0, split), nodeOf), parseValue(entry.slice(split + 1), nodeOf));
    }
    return held;
  }
  if (token.startsWith("Set{") && token.endsWith("}")) {
    return new Set(splitTopLevel(token.slice(4, -1)).map((part) => parseValue(part, nodeOf)));
  }
  if (token.startsWith("[") && token.endsWith("]")) {
    return splitTopLevel(token.slice(1, -1)).map((part) => parseValue(part, nodeOf));
  }
  if (token.startsWith("{") && token.endsWith("}")) {
    const record: Record<string, IRMetadataValue> = {};
    for (const entry of splitTopLevel(token.slice(1, -1))) {
      const split = entry.indexOf(":");
      if (split < 0) throw new IRTextError(`malformed record entry ${entry}`);
      record[entry.slice(0, split).trim()] = parseValue(entry.slice(split + 1), nodeOf);
    }
    return record;
  }
  if (token === "NaN") return Number.NaN;
  if (token === "Infinity") return Infinity;
  if (token === "-Infinity") return -Infinity;
  if (token === "-0") return -0;
  const numeric = Number(token);
  if (token !== "" && Number.isFinite(numeric)) return numeric;
  throw new IRTextError(`cannot parse property value ${token}`);
}

const NODE_LINE = /^v(\d+)\s*=\s*([A-Za-z][A-Za-z0-9_]*)(.*)$/;
const BLOCK_LINE = /^B(\d+)([^:]*):$/;

function parseNodeLine(
  line: string,
): { readonly id: number; readonly opcode: string; readonly tail: string } {
  const found = NODE_LINE.exec(line);
  if (found === null) throw new IRTextError(`malformed instruction "${line}"`);
  return { id: Number(found[1]), opcode: found[2]!, tail: found[3]! };
}

function splitTail(tail: string): {
  readonly inputs: readonly string[];
  readonly props: readonly (readonly [string, string])[];
  readonly frameState: boolean;
} {
  let rest = tail.trim();
  const frameState = rest.endsWith(FRAME_STATE_MARK);
  if (frameState) rest = rest.slice(0, -FRAME_STATE_MARK.length).trim();
  let propText = "";
  const opened = rest.indexOf("[");
  if (opened >= 0) {
    if (!rest.endsWith("]")) throw new IRTextError(`unterminated property list in "${tail}"`);
    propText = rest.slice(opened + 1, -1);
    rest = rest.slice(0, opened).trim();
  }
  const props = splitTopLevel(propText).map((entry) => {
    const split = entry.indexOf("=");
    if (split < 0) throw new IRTextError(`malformed property "${entry}"`);
    return [entry.slice(0, split).trim(), entry.slice(split + 1).trim()] as const;
  });
  return { inputs: splitTopLevel(rest), props, frameState };
}

function blockList(header: string, key: string): readonly number[] | null {
  const found = new RegExp(`${key}=([B0-9,]*)`).exec(header);
  if (found === null) return null;
  return found[1]!
    .split(",")
    .filter((name) => name !== "")
    .map((name) => Number(name.slice(1)));
}

export function parseIR(text: string): CFGFunction {
  const cursor = new Cursor(text);
  cursor.expect(/fn/, '"fn"');
  const name = cursor.expect(/[^\s{]+/, "a function name");
  const params = Number(cursor.expect(/params=\d+/, "params=<n>").slice("params=".length));
  cursor.expect(/\{/, '"{"');

  const graph = new CFGFunction(name);
  const nodes = new Map<number, CFGInstruction>();
  const pending: PendingNode[] = [];
  const blocksById = new Map<number, CFGBlock>();
  const successorsOf = new Map<number, readonly number[]>();
  const predecessorsOf = new Map<number, readonly number[] | null>();
  const nodeOf = (label: string): CFGInstruction => {
    const held = nodes.get(Number(label.slice(1)));
    if (held === undefined) throw new IRTextError(`unknown value ${label}`);
    return held;
  };

  let current: CFGBlock | null = null;
  const graphAttributes: (readonly [string, string])[] = [];
  const body = cursor.rest;
  const closing = body.lastIndexOf("}");
  if (closing < 0) throw new IRTextError('missing closing "}"');
  for (const raw of body.slice(0, closing).split("\n")) {
    const line = raw.replace(/;.*$/, "").trim();
    if (line === "") continue;
    if (line.startsWith("graph ")) {
      if (current !== null) throw new IRTextError("graph attributes must precede every block");
      graphAttributes.push(...splitTail(line.slice("graph".length)).props);
      continue;
    }
    const block = BLOCK_LINE.exec(line);
    if (block !== null) {
      const id = Number(block[1]);
      const header = block[2]!;
      current = graph.addBlock();
      current.id = id;
      current.isLoopHeader = header.includes(LOOP_HEADER_MARK);
      blocksById.set(id, current);
      successorsOf.set(id, blockList(header, "succs") ?? []);
      predecessorsOf.set(id, blockList(header, "preds"));
      continue;
    }
    const { id, opcode, tail } = parseNodeLine(line);
    const { inputs, props, frameState } = splitTail(tail);
    if (!isOpcode(opcode)) throw new IRTextError(`unknown opcode ${opcode}`);
    const node = new CFGInstruction(opcode, {});
    node.id = id;
    if (frameState) node.frameState = new FrameState(null, 0);
    if (nodes.has(id)) throw new IRTextError(`duplicate value v${id}`);
    nodes.set(id, node);
    pending.push({ node, inputs, props });
    if (opcode === IR_PARAMETER && current === null) {
      graph.parameters.push(node);
      continue;
    }
    if (current === null) throw new IRTextError(`instruction v${id} appears before any block`);
    node.block = current;
    current.nodes.push(node);
    if (opcode === IR_PHI) current.phis.push(node);
  }

  if (graph.parameters.length !== params) {
    throw new IRTextError(
      `header declares params=${params} but ${graph.parameters.length} were listed`,
    );
  }

  for (const { node, inputs, props } of pending) {
    for (const label of inputs) node.addInput(nodeOf(label));
    for (const [key, value] of props) node.props[key] = parseValue(value, nodeOf);
    node.rep = node.props._rep ?? null;
  }

  for (const [id, successors] of successorsOf) {
    const block = blocksById.get(id)!;
    for (const next of successors) {
      const target = blocksById.get(next);
      if (target === undefined) throw new IRTextError(`B${id} points at unknown block B${next}`);
      block.successors.push(target);
    }
  }
  for (const [id, predecessors] of predecessorsOf) {
    const block = blocksById.get(id)!;
    if (predecessors === null) {
      for (const other of graph.blocks) {
        for (const next of other.successors) if (next === block) block.predecessors.push(other);
      }
      continue;
    }
    for (const prior of predecessors) {
      const source = blocksById.get(prior);
      if (source === undefined) throw new IRTextError(`B${id} names unknown block B${prior}`);
      block.predecessors.push(source);
    }
  }

  const state = graph as unknown as Record<string, unknown>;
  for (const [field, value] of graphAttributes) {
    if (!GRAPH_BY_NAME.has(field)) throw new IRTextError(`unknown graph attribute ${field}`);
    state[field] = parseValue(value, nodeOf);
  }

  graph.entry = graph.blocks[0] ?? null;
  graph.parameterCount = graph.parameters.length;
  graph.rebuildUses();
  return graph;
}
