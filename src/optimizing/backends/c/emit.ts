import {
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_CHECK_NUMBER,
  IR_CHECK_SMI,
  IR_PARAMETER,
  IR_PHI,
  IR_CONSTANT,
  IR_RETURN,
  IR_JUMP,
  IR_BRANCH,
  IR_NEG,
  IR_FLOAT64_ADD,
  IR_FLOAT64_SUB,
  IR_FLOAT64_MUL,
  IR_FLOAT64_DIV,
  IR_INT32_ADD,
  IR_INT32_SUB,
  IR_INT32_MUL,
  IR_INT32_COMPARE,
  IR_FLOAT64_COMPARE,
} from "../../ir/index.js";
import { buildDispatch } from "../../infra/dispatch.js";

export const C_HEADER_PREAMBLE = "#include <stdint.h>\n#include <stdlib.h>";
export const C_RUNTIME_SUPPORT = `static inline double tera_i32_to_double(uint32_t value) {
  return value <= (uint32_t)INT32_MAX ? (double)value : -((double)(UINT32_MAX - value) + 1.0);
}

static inline int tera_is_smi_double(double value) {
  return value >= (double)INT32_MIN && value <= (double)INT32_MAX && value == (double)(int32_t)value;
}

static inline void tera_aot_trap(void) {
  abort();
}`;
export const C_SOURCE_PREAMBLE = `${C_HEADER_PREAMBLE}\n\n${C_RUNTIME_SUPPORT}`;

export type CEmitResult =
  | {
      readonly ok: true;
      readonly symbol: string;
      readonly prototype: string;
      readonly source: string;
      readonly headerPreamble: string;
      readonly sourcePreamble: string;
      readonly translationUnitPreamble: string;
    }
  | { readonly ok: false; readonly reason: string };

const FLOAT_BINOP = new Map<string, string>([
  [IR_FLOAT64_ADD, "+"],
  [IR_FLOAT64_SUB, "-"],
  [IR_FLOAT64_MUL, "*"],
  [IR_FLOAT64_DIV, "/"],
]);

const INT_BINOP = new Map<string, string>([
  [IR_INT32_ADD, "+"],
  [IR_INT32_SUB, "-"],
  [IR_INT32_MUL, "*"],
]);

const COMPARE_OP = new Map<string, string>([
  ["==", "=="],
  ["loose==", "=="],
  ["!=", "!="],
  ["loose!=", "!="],
  ["<", "<"],
  [">", ">"],
  ["<=", "<="],
  [">=", ">="],
]);

function formatNumber(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  const text = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

function cIdentifier(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(sanitized) ? sanitized : `fn_${sanitized}`;
}

interface EmitContext {
  readonly node: CFGInstruction;
  nameOf(value: CFGInstruction): string;
  emit(line: string): void;
  copyEdge(from: CFGBlock, to: CFGBlock): void;
  labelOf(block: CFGBlock): string;
  fail(reason: string): void;
}

class CFunctionEmitter {
  private readonly names = new Map<CFGInstruction, string>();
  private readonly blockPhis: CFGInstruction[] = [];
  private readonly body: string[] = [];
  private readonly dispatch = buildDispatch<string, EmitContext>(this.handlers());
  private tempSeq = 0;
  private returnCount = 0;
  private failure: string | null = null;

  constructor(private readonly graph: CFGFunction) {}

  emit(): CEmitResult {
    if (this.graph.bailout !== null) return this.bail(`graph bailed: ${this.graph.bailout}`);
    const entry = this.graph.entry;
    if (entry === null) return this.bail("function has no entry block");
    if (entry !== this.graph.blocks[0]) return this.bail("entry is not the first block");
    if (entry.phis.length > 0) return this.bail("entry block has phis");

    this.assignNames();

    for (const block of this.graph.blocks) {
      if (this.failure !== null) return this.bail(this.failure);
      this.emitBlock(block);
    }
    if (this.failure !== null) return this.bail(this.failure);
    if (this.returnCount === 0) return this.bail("function has no return");

    const symbol = cIdentifier(this.graph.name);
    const signature = this.signature(symbol);
    return {
      ok: true,
      symbol,
      prototype: `${signature};`,
      source: this.render(signature),
      headerPreamble: C_HEADER_PREAMBLE,
      sourcePreamble: C_SOURCE_PREAMBLE,
      translationUnitPreamble: C_RUNTIME_SUPPORT,
    };
  }

  private assignNames(): void {
    for (const param of this.graph.parameters) {
      this.names.set(param, `p${Number(param.props.index)}`);
    }
    for (const block of this.graph.blocks) {
      for (const phi of block.phis) {
        this.names.set(phi, `b${phi.id}`);
        this.blockPhis.push(phi);
      }
    }
  }

  private emitBlock(block: CFGBlock): void {
    if (block.predecessors.length > 0) this.body.push(`${this.labelOf(block)}:;`);

    let terminated = false;
    for (const node of block.nodes) {
      if (this.failure !== null) return;
      if (node.type === IR_PARAMETER || node.type === IR_PHI) continue;
      const handled = this.dispatch(node.type, this.contextFor(node));
      if (!handled) {
        this.failure = `unsupported opcode ${node.type}`;
        return;
      }
      if (node.type === IR_RETURN || node.type === IR_JUMP || node.type === IR_BRANCH) {
        terminated = true;
      }
    }
    if (this.failure === null && !terminated && this.returnCount === 0) {
      this.failure = "function has no return";
    } else if (this.failure === null && !terminated) {
      this.failure = `block ${block.id} has no terminator`;
    }
  }

  private handlers(): Array<readonly [string, (ctx: EmitContext) => void]> {
    const entries: Array<readonly [string, (ctx: EmitContext) => void]> = [];

    entries.push([
      IR_CONSTANT,
      (ctx) => {
        const value = ctx.node.props.value;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          ctx.fail(`unsupported constant ${String(value)}`);
          return;
        }
        ctx.emit(`const double ${ctx.nameOf(ctx.node)} = ${formatNumber(value)};`);
      },
    ]);

    for (const [opcode, op] of FLOAT_BINOP) {
      entries.push([
        opcode,
        (ctx) => {
          const left = ctx.nameOf(ctx.node.inputs[0]!);
          const right = ctx.nameOf(ctx.node.inputs[1]!);
          ctx.emit(`const double ${ctx.nameOf(ctx.node)} = ${left} ${op} ${right};`);
        },
      ]);
    }

    for (const [opcode, op] of INT_BINOP) {
      entries.push([
        opcode,
        (ctx) => {
          const left = ctx.nameOf(ctx.node.inputs[0]!);
          const right = ctx.nameOf(ctx.node.inputs[1]!);
          ctx.emit(
            `const double ${ctx.nameOf(ctx.node)} = tera_i32_to_double((uint32_t)(int32_t)${left} ${op} (uint32_t)(int32_t)${right});`,
          );
        },
      ]);
    }

    entries.push([
      IR_NEG,
      (ctx) => {
        ctx.emit(`const double ${ctx.nameOf(ctx.node)} = -${ctx.nameOf(ctx.node.inputs[0]!)};`);
      },
    ]);

    entries.push([IR_INT32_COMPARE, (ctx) => this.emitCompare(ctx, true)]);
    entries.push([IR_FLOAT64_COMPARE, (ctx) => this.emitCompare(ctx, false)]);

    entries.push([
      IR_CHECK_SMI,
      (ctx) => {
        const input = ctx.nameOf(ctx.node.inputs[0]!);
        ctx.emit(`if (!tera_is_smi_double(${input})) tera_aot_trap();`);
        ctx.emit(`const double ${ctx.nameOf(ctx.node)} = ${input};`);
      },
    ]);

    entries.push([
      IR_CHECK_NUMBER,
      (ctx) => {
        ctx.emit(`const double ${ctx.nameOf(ctx.node)} = ${ctx.nameOf(ctx.node.inputs[0]!)};`);
      },
    ]);

    entries.push([
      IR_RETURN,
      (ctx) => {
        if (ctx.node.inputs.length === 0) {
          ctx.fail("return without a value");
          return;
        }
        this.returnCount++;
        ctx.emit(`return ${ctx.nameOf(ctx.node.inputs[0]!)};`);
      },
    ]);

    entries.push([
      IR_JUMP,
      (ctx) => {
        const target = this.successorByProp(ctx.node.block!, "targetBlock");
        if (target === null) {
          ctx.fail("jump has no target block");
          return;
        }
        ctx.copyEdge(ctx.node.block!, target);
        ctx.emit(`goto ${ctx.labelOf(target)};`);
      },
    ]);

    entries.push([
      IR_BRANCH,
      (ctx) => {
        const source = ctx.node.block!;
        const trueBlock = this.successorByProp(source, "trueBlock");
        const falseBlock = this.successorByProp(source, "falseBlock");
        if (trueBlock === null || falseBlock === null) {
          ctx.fail("branch has an unresolved successor");
          return;
        }
        ctx.emit(`if (${ctx.nameOf(ctx.node.inputs[0]!)} != 0.0) {`);
        ctx.copyEdge(source, trueBlock);
        ctx.emit(`goto ${ctx.labelOf(trueBlock)};`);
        ctx.emit(`} else {`);
        ctx.copyEdge(source, falseBlock);
        ctx.emit(`goto ${ctx.labelOf(falseBlock)};`);
        ctx.emit(`}`);
      },
    ]);

    return entries;
  }

  private emitCompare(ctx: EmitContext, asInt32: boolean): void {
    const op = COMPARE_OP.get(String(ctx.node.props.op));
    if (op === undefined) {
      ctx.fail(`unsupported comparison ${String(ctx.node.props.op)}`);
      return;
    }
    const cast = asInt32 ? "(int32_t)" : "";
    const left = `${cast}${ctx.nameOf(ctx.node.inputs[0]!)}`;
    const right = `${cast}${ctx.nameOf(ctx.node.inputs[1]!)}`;
    ctx.emit(`const double ${ctx.nameOf(ctx.node)} = (${left} ${op} ${right}) ? 1.0 : 0.0;`);
  }

  private successorByProp(block: CFGBlock, prop: string): CFGBlock | null {
    const terminator = block.getTerminator();
    if (terminator === null) return null;
    const targetId = terminator.props[prop];
    if (typeof targetId !== "number") return null;
    for (const successor of block.successors) {
      if (successor.id === targetId) return successor;
    }
    return null;
  }

  private copyEdge(from: CFGBlock, to: CFGBlock): void {
    const phis = to.phis;
    if (phis.length === 0) return;
    const predIndex = to.predecessors.indexOf(from);
    if (predIndex < 0) {
      this.failure = `edge B${from.id}->B${to.id} is not a predecessor edge`;
      return;
    }
    const temps: string[] = [];
    for (const phi of phis) {
      const temp = `t${this.tempSeq++}`;
      temps.push(temp);
      this.body.push(`const double ${temp} = ${this.nameOf(phi.inputs[predIndex]!)};`);
    }
    for (let i = 0; i < phis.length; i++) {
      this.body.push(`${this.nameOf(phis[i]!)} = ${temps[i]!};`);
    }
  }

  private contextFor(node: CFGInstruction): EmitContext {
    return {
      node,
      nameOf: (value) => this.nameOf(value),
      emit: (line) => this.body.push(line),
      copyEdge: (from, to) => this.copyEdge(from, to),
      labelOf: (block) => this.labelOf(block),
      fail: (reason) => {
        if (this.failure === null) this.failure = reason;
      },
    };
  }

  private nameOf(value: CFGInstruction): string {
    return this.names.get(value) ?? `v${value.id}`;
  }

  private labelOf(block: CFGBlock): string {
    return `L${block.id}`;
  }

  private signature(symbol: string): string {
    const params = this.graph.parameters
      .map((param) => `double p${Number(param.props.index)}`)
      .join(", ");
    return `double ${symbol}(${params.length > 0 ? params : "void"})`;
  }

  private render(signature: string): string {
    const declarations = this.blockPhis.map((phi) => `  double ${this.nameOf(phi)};`);
    const unusedParams = this.graph.parameters
      .filter((param) => param.uses.length === 0)
      .map((param) => `  (void)p${Number(param.props.index)};`);
    const statements = this.body.map((line) =>
      line.endsWith(":;") ? line : `  ${line}`,
    );
    const lines = [...declarations, ...unusedParams, ...statements];
    const bodyText = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    return `${C_SOURCE_PREAMBLE}\n\n${signature} {\n${bodyText}}\n`;
  }

  private bail(reason: string): CEmitResult {
    return { ok: false, reason };
  }
}

export function emitNumericFunction(graph: CFGFunction): CEmitResult {
  return new CFunctionEmitter(graph).emit();
}
