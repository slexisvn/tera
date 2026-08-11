import {
  type CFGFunction,
  type CFGInstruction,
  isTerminator,
  IR_PARAMETER,
  IR_PHI,
  IR_CONSTANT,
  IR_RETURN,
  IR_JUMP,
  IR_BRANCH,
  IR_NEG,
  IR_NOT,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_MUL,
  IR_FLOAT64_DIV,
  IR_FLOAT64_COMPARE,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_INT32_AND,
  IR_INT32_OR,
  IR_INT32_XOR,
  IR_INT32_NOT,
  IR_INT32_SHL,
  IR_INT32_SHR,
  IR_INT32_USHR,
  IR_INT32_COMPARE,
  IR_CALL_KNOWN_FUNCTION,
  IR_CALL_BUILTIN,
  IR_NEW_ARRAY,
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_GENERIC_GET_PROP,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_GENERIC_CALL,
  IR_GENERIC_ADD,
  IR_LOAD_GLOBAL,
} from "../ir/index.js";
import { analysisId, type AnalysisPass } from "../infra/analysis-manager.js";
import { latticeFromDeclaredType } from "../types/declared.js";
import {
  aotElementScalarOf,
  aotScalarOf,
  SCALAR_FLOAT64,
  SCALAR_INT32,
  SCALAR_STRING,
  type AotScalar,
} from "../types/scalar.js";
import { joinTypes, type LatticeType } from "../types/lattice.js";
import {
  builtinIntrinsicByName,
  qualifiedMethodName,
} from "../metadata/builtin-methods.js";
import { typeInferenceAnalysisId, type TypeInference } from "./type-inference.js";

export const AOT_OPCODES: ReadonlySet<string> = new Set<string>([
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  IR_INT32_DIV,
  IR_INT32_MOD,
  IR_INT32_AND,
  IR_INT32_OR,
  IR_INT32_XOR,
  IR_INT32_NOT,
  IR_INT32_SHL,
  IR_INT32_SHR,
  IR_INT32_USHR,
  IR_INT32_COMPARE,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_MUL,
  IR_FLOAT64_DIV,
  IR_FLOAT64_COMPARE,
  IR_NEG,
  IR_NOT,
  IR_CALL_KNOWN_FUNCTION,
  IR_CALL_BUILTIN,
  IR_NEW_ARRAY,
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
  IR_LOAD_GLOBAL,
  IR_RETURN,
  IR_JUMP,
  IR_BRANCH,
]);

export const AOT_CHAR_AT = qualifiedMethodName("string", "char_at");
export const AOT_INT_TO_STRING = qualifiedMethodName("int", "to_string");

export const AOT_STRING_BUILTINS: ReadonlySet<string> = new Set<string>([
  AOT_CHAR_AT,
  AOT_INT_TO_STRING,
]);

export const AOT_BUILTINS: ReadonlySet<string> = new Set<string>([
  qualifiedMethodName("Math", "abs"),
  qualifiedMethodName("Math", "floor"),
  qualifiedMethodName("Math", "ceil"),
  qualifiedMethodName("Math", "sqrt"),
  qualifiedMethodName("Math", "trunc"),
  qualifiedMethodName("Math", "round"),
  qualifiedMethodName("Math", "min"),
  qualifiedMethodName("Math", "max"),
  qualifiedMethodName("string", "char_code_at"),
  qualifiedMethodName("string", "length"),
  ...AOT_STRING_BUILTINS,
]);

const ARRAY_OPS: ReadonlySet<string> = new Set<string>([
  IR_LOAD_ELEMENT,
  IR_STORE_ELEMENT,
  IR_LOAD_ARRAY_LENGTH,
  IR_GENERIC_GET_INDEX,
  IR_GENERIC_SET_INDEX,
]);

const STATEMENT_WHEN_UNUSED: ReadonlySet<string> = new Set<string>([
  IR_CALL_KNOWN_FUNCTION,
  IR_STORE_ELEMENT,
  IR_GENERIC_SET_INDEX,
]);

const REJECTIONS = new Map<string, (node: CFGInstruction) => string>([
  [IR_GENERIC_GET_PROP, (node) => `unsupported property ${String(node.props.propName)}`],
  [IR_GENERIC_CALL, () => "unsupported generic call"],
]);

const ASCII_LIMIT = 0x7f;

export const AOT_STRING_BUFFER_CAPACITY = 1024;

export interface AotArray {
  readonly allocation: CFGInstruction;
  readonly length: number;
  readonly element: AotScalar;
}

export interface AotStringBuffer {
  readonly producer: CFGInstruction;
  readonly capacity: number;
}

export interface AotLegality {
  readonly returnScalar: AotScalar;
  readonly declaredReturn: boolean;
  readonly parameterScalars: readonly AotScalar[];
  readonly constants: readonly CFGInstruction[];
  readonly arrays: readonly AotArray[];
  readonly stringBuffers: readonly AotStringBuffer[];
  scalarOf(value: CFGInstruction): AotScalar;
  arrayOf(value: CFGInstruction): AotArray | null;
  stringBufferOf(value: CFGInstruction): AotStringBuffer | null;
}

export type AotLegalityResult =
  | { readonly ok: true; readonly legality: AotLegality }
  | { readonly ok: false; readonly reason: string };

export function calleeSymbolName(node: CFGInstruction): string | null {
  const target = node.props.target as { name?: unknown } | undefined;
  return typeof target?.name === "string" ? target.name : null;
}

export function isAsciiRepresentable(value: string): boolean {
  for (const character of value) {
    if (character.codePointAt(0)! > ASCII_LIMIT) return false;
  }
  return true;
}

export function builtinOperandScalar(declared: string | null): AotScalar | null {
  return aotScalarOf(latticeFromDeclaredType(declared));
}

class LegalityAnalyzer implements AotLegality {
  private readonly scalars = new Map<CFGInstruction, AotScalar>();
  private readonly arrayByValue = new Map<CFGInstruction, AotArray>();
  private readonly bufferByValue = new Map<CFGInstruction, AotStringBuffer>();
  private readonly seenConstants = new Set<CFGInstruction>();
  readonly constants: CFGInstruction[] = [];
  readonly arrays: AotArray[] = [];
  readonly stringBuffers: AotStringBuffer[] = [];
  returnScalar: AotScalar = SCALAR_FLOAT64;
  declaredReturn = false;
  parameterScalars: AotScalar[] = [];
  private failure: string | null = null;

  constructor(
    private readonly graph: CFGFunction,
    private readonly types: TypeInference,
  ) {}

  analyze(): AotLegalityResult {
    if (this.graph.bailout !== null) {
      return this.bail(`graph bailed: ${this.graph.bailout}`);
    }
    this.graph.rebuildUses();
    const entry = this.graph.entry;
    if (entry === null) return this.bail("function has no entry block");
    if (entry !== this.graph.blocks[0]) return this.bail("entry is not the first block");
    if (entry.phis.length > 0) return this.bail("entry block has phis");

    this.collectArrays();
    if (this.failure !== null) return this.bail(this.failure);
    this.collectStringBuffers();
    if (this.failure !== null) return this.bail(this.failure);
    this.collectConstants();
    if (this.failure !== null) return this.bail(this.failure);
    this.checkBlocks();
    if (this.failure !== null) return this.bail(this.failure);
    this.checkSignature();
    if (this.failure !== null) return this.bail(this.failure);

    return { ok: true, legality: this };
  }

  scalarOf(value: CFGInstruction): AotScalar {
    const scalar = this.scalars.get(value) ?? aotScalarOf(this.types.typeOf(value));
    if (scalar === null) {
      throw new Error(`legality admitted v${value.id} without a scalar type`);
    }
    return scalar;
  }

  arrayOf(value: CFGInstruction): AotArray | null {
    return this.arrayByValue.get(value) ?? null;
  }

  stringBufferOf(value: CFGInstruction): AotStringBuffer | null {
    return this.bufferByValue.get(value) ?? null;
  }

  private fail(reason: string): void {
    if (this.failure === null) this.failure = reason;
  }

  private bail(reason: string): AotLegalityResult {
    return { ok: false, reason };
  }

  private require(value: CFGInstruction, context: string): AotScalar | null {
    const cached = this.scalars.get(value);
    if (cached !== undefined) return cached;
    const scalar = aotScalarOf(this.types.typeOf(value));
    if (scalar === null) {
      this.fail(`value has an unsupported type in ${context}`);
      return null;
    }
    this.scalars.set(value, scalar);
    return scalar;
  }

  private collectArrays(): void {
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_NEW_ARRAY) continue;
        const element = aotElementScalarOf(this.types.typeOf(node));
        const holdsString = node.inputs.some((input) => this.isStringValue(input));
        if (element === null || element === SCALAR_STRING || holdsString) {
          this.fail("array has an unsupported element type");
          return;
        }
        const model: AotArray = {
          allocation: node,
          length: node.inputs.length,
          element,
        };
        if (!this.bindArrayAliases(model)) return;
        this.arrays.push(model);
      }
    }
  }

  private bindArrayAliases(model: AotArray): boolean {
    const aliases = new Set<CFGInstruction>([model.allocation]);
    const pending: CFGInstruction[] = [model.allocation];
    while (pending.length > 0) {
      for (const use of pending.pop()!.uses) {
        if (use.type !== IR_PHI || aliases.has(use)) continue;
        aliases.add(use);
        pending.push(use);
      }
    }

    for (const value of aliases) {
      if (value.type === IR_PHI && !value.inputs.every((input) => aliases.has(input))) {
        this.fail(`array escapes to ${IR_PHI}`);
        return false;
      }
      for (const use of value.uses) {
        if (use.type === IR_PHI) continue;
        if (!ARRAY_OPS.has(use.type) || !aliases.has(use.inputs[0]!)) {
          this.fail(`array escapes to ${use.type}`);
          return false;
        }
      }
    }

    for (const value of aliases) this.arrayByValue.set(value, model);
    return true;
  }

  private isStringValue(value: CFGInstruction): boolean {
    return aotScalarOf(this.types.typeOf(value)) === SCALAR_STRING;
  }

  private buildsString(node: CFGInstruction): boolean {
    if (node.type === IR_GENERIC_ADD) {
      return this.isStringValue(node) && node.inputs.every((input) => this.isStringValue(input));
    }
    return node.type === IR_CALL_BUILTIN && AOT_STRING_BUILTINS.has(String(node.props.name));
  }

  private collectStringBuffers(): void {
    const producers: CFGInstruction[] = [];
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (this.buildsString(node)) producers.push(node);
      }
    }
    if (producers.length === 0) return;

    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_CALL_KNOWN_FUNCTION) continue;
        this.fail(
          `string building cannot cross a call to ${calleeSymbolName(node) ?? "an unknown function"}`,
        );
        return;
      }
    }

    for (const producer of producers) {
      const model: AotStringBuffer = { producer, capacity: AOT_STRING_BUFFER_CAPACITY };
      if (!this.bindStringBufferAliases(model)) return;
      this.stringBuffers.push(model);
    }

    for (const buffer of this.stringBuffers) {
      for (const input of buffer.producer.inputs.slice(1)) {
        if (this.bufferByValue.get(input) === buffer) {
          this.fail("string buffer is used as a trailing operand of its own producer");
          return;
        }
      }
    }
  }

  private bindStringBufferAliases(model: AotStringBuffer): boolean {
    const aliases = new Set<CFGInstruction>([model.producer]);
    const pending: CFGInstruction[] = [model.producer];
    let phis = 0;
    while (pending.length > 0) {
      for (const use of pending.pop()!.uses) {
        if (use.type !== IR_PHI || aliases.has(use)) continue;
        aliases.add(use);
        pending.push(use);
        phis++;
      }
    }
    if (phis > 1) {
      this.fail("string buffer has more than one loop-carried alias");
      return false;
    }

    for (const value of aliases) {
      for (const use of value.uses) {
        if (use.type === IR_PHI || use.type === IR_RETURN) continue;
        if (!this.buildsString(use) && !this.readsString(use)) {
          this.fail(`string buffer escapes to ${use.type}`);
          return false;
        }
      }
    }

    for (const value of aliases) this.bufferByValue.set(value, model);
    return true;
  }

  private readsString(node: CFGInstruction): boolean {
    return node.type === IR_CALL_BUILTIN && AOT_BUILTINS.has(String(node.props.name));
  }

  private collectConstants(): void {
    const visit = (value: CFGInstruction | undefined): void => {
      if (value === undefined || value.type !== IR_CONSTANT) return;
      if (this.seenConstants.has(value)) return;
      this.seenConstants.add(value);
      this.constants.push(value);
      this.checkConstant(value);
    };
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        visit(node);
        for (const input of node.inputs) visit(input);
      }
      for (const phi of block.phis) {
        for (const input of phi.inputs) visit(input);
      }
    }
  }

  private checkConstant(node: CFGInstruction): void {
    const value = node.props.value;
    if (typeof value === "string") {
      if (!isAsciiRepresentable(value)) {
        this.fail("string constant is not representable as ASCII");
      } else {
        this.scalars.set(node, SCALAR_STRING);
      }
      return;
    }
    if (this.require(node, node.type) === null) return;
    if (typeof value === "boolean") return;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.fail(`unsupported constant ${String(value)}`);
    }
  }

  private checkBlocks(): void {
    let returns = 0;
    for (const block of this.graph.blocks) {
      for (const phi of block.phis) {
        if (this.arrayByValue.has(phi)) continue;
        this.require(phi, IR_PHI);
      }
      for (const node of block.nodes) {
        if (node.type === IR_RETURN) returns++;
        this.checkNode(node);
        if (this.failure !== null) return;
      }
      if (block.getTerminator() !== null) continue;
      this.fail(returns === 0 ? "function has no return" : `block ${block.id} has no terminator`);
      return;
    }
    if (returns === 0) this.fail("function has no return");
  }

  private checkNode(node: CFGInstruction): void {
    if (node.type === IR_PARAMETER || node.type === IR_PHI || node.type === IR_CONSTANT) {
      return;
    }
    const rejection = REJECTIONS.get(node.type);
    if (rejection !== undefined) {
      this.fail(rejection(node));
      return;
    }
    if (!AOT_OPCODES.has(node.type) && this.bufferByValue.get(node)?.producer !== node) {
      this.fail(`unsupported opcode ${node.type}`);
      return;
    }
    if (node.type === IR_LOAD_GLOBAL) {
      if (node.uses.length > 0) this.fail("load of a global value");
      return;
    }
    if (node.type === IR_CALL_KNOWN_FUNCTION && calleeSymbolName(node) === null) {
      this.fail("call to a function without a resolvable name");
      return;
    }
    if (node.type === IR_CALL_BUILTIN) {
      this.checkBuiltin(node);
      if (this.failure !== null) return;
    }
    if (node.type === IR_RETURN && node.inputs[0] === undefined) {
      this.fail("return without a value");
      return;
    }
    if (ARRAY_OPS.has(node.type)) {
      const array = this.arrayOf(node.inputs[0]!);
      if (array === null) {
        this.fail(
          node.type === IR_LOAD_ARRAY_LENGTH
            ? "array length of an unsupported array"
            : `${node.type} on a value that is not a local array`,
        );
        return;
      }
      const stored = node.inputs[2];
      if (stored !== undefined && this.isStringValue(stored) && array.element !== SCALAR_STRING) {
        this.fail("array has an unsupported element type");
        return;
      }
    }
    for (const input of node.inputs) {
      if (this.arrayByValue.has(input)) continue;
      if (this.require(input, node.type) === null) return;
    }
    if (isTerminator(node.type) || this.arrayByValue.has(node)) return;
    if (node.uses.length === 0 && STATEMENT_WHEN_UNUSED.has(node.type)) return;
    this.require(node, node.type);
  }

  private checkBuiltin(node: CFGInstruction): void {
    const name = String(node.props.name);
    const intrinsic = builtinIntrinsicByName(name);
    if (intrinsic === null || !AOT_BUILTINS.has(name)) {
      this.fail(`unsupported builtin ${name}`);
      return;
    }
    if (node.inputs.length !== intrinsic.requiredArgCount) {
      this.fail(`${name} has an unsupported argument count`);
      return;
    }
    for (let index = 0; index < node.inputs.length; index++) {
      const expected = builtinOperandScalar(intrinsic.signature.params[index] ?? null);
      const actual = this.require(node.inputs[index]!, node.type);
      if (actual === null) return;
      const stringMismatch =
        (expected === SCALAR_STRING || actual === SCALAR_STRING) && expected !== actual;
      if (expected === null || stringMismatch) {
        this.fail(`${name} has an unsupported argument type`);
        return;
      }
    }
  }

  private checkSignature(): void {
    const returnScalar = this.inferReturnScalar();
    if (returnScalar === null) {
      this.fail("function has an unsupported return type");
      return;
    }
    if (returnScalar !== SCALAR_STRING && this.returnsAString()) {
      this.fail("function returns a string but its return type is not a string");
      return;
    }
    this.returnScalar = returnScalar;
    for (const param of this.graph.parameters) {
      const scalar = aotScalarOf(this.types.typeOf(param));
      if (scalar === null) {
        this.fail("function has an unsupported parameter type");
        return;
      }
      this.scalars.set(param, scalar);
      this.parameterScalars.push(scalar);
    }
  }

  private returnsAString(): boolean {
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_RETURN) continue;
        const returned = node.inputs[0];
        if (returned !== undefined && this.isStringValue(returned)) return true;
      }
    }
    return false;
  }

  private inferReturnScalar(): AotScalar | null {
    const declared = this.graph.declaredSignature?.returns;
    if (declared !== null && declared !== undefined) {
      const scalar = aotScalarOf(latticeFromDeclaredType(declared));
      if (scalar !== null) {
        this.declaredReturn = true;
        return scalar;
      }
    }
    let merged: LatticeType | null = null;
    for (const block of this.graph.blocks) {
      for (const node of block.nodes) {
        if (node.type !== IR_RETURN) continue;
        const returned = node.inputs[0];
        if (returned !== undefined) merged = joinTypes(merged, this.types.typeOf(returned));
      }
    }
    return merged === null ? SCALAR_FLOAT64 : aotScalarOf(merged);
  }
}

export function analyzeAotLegality(
  graph: CFGFunction,
  types: TypeInference,
): AotLegalityResult {
  return new LegalityAnalyzer(graph, types).analyze();
}

export const aotLegalityAnalysisId = analysisId<AotLegalityResult>("aot-legality");

export const aotLegalityAnalysis: AnalysisPass<CFGFunction, AotLegalityResult> = {
  id: aotLegalityAnalysisId,
  run: (graph, analyses) =>
    analyzeAotLegality(graph, analyses.get(typeInferenceAnalysisId)),
};
