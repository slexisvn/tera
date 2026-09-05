import {
  type CFGBlock,
  type CFGFunction,
  type CFGInstruction,
  IR_CONSTANT,
  IR_PARAMETER,
  IR_PHI,
  IR_RUNTIME_BASE,
  type IRSourcePosition,
} from "../ir/index.js";
import { buildDispatch } from "../infra/dispatch.js";
import { rootSlotsOf } from "../analyses/aot-legality.js";
import type { AotLegality } from "../analyses/aot-legality.js";
import { SCALAR_POINTER, type AotScalar } from "../types/scalar.js";
import { argumentLocations, outgoingArgumentBytes } from "../target/abi.js";
import { TERA_ROOT_ENTRY_BYTES } from "../target/runtime-layout.js";
import type { RegisterClassId } from "../target/registers.js";
import { BackendLoweringError } from "../target/errors.js";
import {
  def,
  sym,
  MachineFunction,
  use,
  type MachineBlock,
  type MachineInstruction,
  type MachineOperand,
  type RegisterOperand,

  type VirtualRegister,
} from "./ir.js";
import type { MachineLowering, SelectionContext, SelectionFork } from "./lowering.js";
import { sequenceParallelCopies } from "./parallel-copy.js";

const STRUCTURAL: ReadonlySet<string> = new Set<string>([
  IR_PARAMETER,
  IR_PHI,
  IR_CONSTANT,
]);

export class MachineSelectionError extends BackendLoweringError {
  constructor(reason: string) {
    super(reason);
    this.name = "MachineSelectionError";
  }
}

class Selector {
  private readonly fn: MachineFunction;
  private readonly dispatch: (key: string, context: SelectionContext) => boolean;
  private readonly machineOf = new Map<CFGBlock, MachineBlock>();
  private readonly registers = new Map<CFGInstruction, VirtualRegister>();
  private readonly rootSlots = new Map<CFGInstruction, number>();
  private readonly edgeTargets = new Map<string, MachineBlock>();
  private readonly fusedConditions = new Set<CFGInstruction>();
  private readonly fusionOf = new Map<CFGInstruction, CFGInstruction>();
  private current: MachineBlock;
  private currentCfg: CFGBlock;
  private source: IRSourcePosition | null = null;
  private guards = 0;

  constructor(
    private readonly graph: CFGFunction,
    private readonly legality: AotLegality,
    private readonly lowering: MachineLowering,
    private readonly layout: readonly CFGBlock[],
    symbol: string,
  ) {
    this.fn = new MachineFunction(graph.name, symbol);
    this.dispatch = buildDispatch<string, SelectionContext>(lowering.rules());
    for (const block of layout) {
      this.machineOf.set(block, this.fn.createBlock(`.L${symbol}_${block.id}`));
    }
    this.currentCfg = layout[0]!;
    this.current = this.machineOf.get(this.currentCfg)!;
  }

  run(): MachineFunction {
    this.planFusion();
    this.reserveRoots();
    this.bindPhis();
    this.bindParameters();
    for (const block of this.layout) {
      this.currentCfg = block;
      this.current = this.machineOf.get(block)!;
      for (const node of block.nodes) {
        this.source = node.position;
        if (STRUCTURAL.has(node.type)) continue;
        if (this.fusedConditions.has(node)) continue;
        if (!this.dispatch(node.type, this.contextFor(node))) {
          throw new Error(
            `${this.lowering.target.name} has no lowering for admitted opcode ${node.type}`,
          );
        }
        this.emitRoot(node);
      }
    }
    return this.fn;
  }

  private planFusion(): void {
    for (const block of this.layout) {
      for (let at = 1; at < block.nodes.length; at++) {
        const node = block.nodes[at]!;
        const condition = node.inputs[0];
        if (condition === undefined || condition !== block.nodes[at - 1]) continue;
        if (condition.uses.length !== 1) continue;
        if (!this.lowering.fusesFlagsOf(node, condition)) continue;
        this.fusedConditions.add(condition);
        this.fusionOf.set(node, condition);
      }
    }
    this.planTargetFusion();
  }

  private planTargetFusion(): void {
    for (const block of this.layout) {
      for (const node of block.nodes) {
        if (this.fusedConditions.has(node) || this.fusionOf.has(node)) continue;
        const folded = this.lowering.fusedInputOf(node);
        if (folded === null || folded.uses.length !== 1 || folded.block !== block) continue;
        if (this.fusedConditions.has(folded)) continue;
        this.fusedConditions.add(folded);
        this.fusionOf.set(node, folded);
      }
    }
  }

  private reserveRoots(): void {
    const values = [
      ...this.graph.parameters,
      ...this.layout.flatMap((block) => [...block.phis, ...block.nodes]),
    ];
    for (const [value, slot] of rootSlotsOf(this.legality, values)) {
      this.rootSlots.set(value, slot);
    }
    if (this.rootSlots.size === 0) return;
    this.fn.roots = this.rootSlots.size;
    this.fn.rootFrame = this.fn.createSlot(TERA_ROOT_ENTRY_BYTES, TERA_ROOT_ENTRY_BYTES);
    this.fn.hasCalls = true;
  }

  private emitRoot(value: CFGInstruction): void {
    const index = this.rootSlots.get(value);
    const frame = this.fn.rootFrame;
    const register = this.registers.get(value);
    if (index === undefined || frame === null || register === undefined) return;
    const address = this.fn.createVirtual(
      this.classOf(SCALAR_POINTER),
      TERA_ROOT_ENTRY_BYTES,
    );
    for (const node of this.lowering.storeRoot(
      frame,
      index,
      use(register, register.width),
      address,
    )) {
      this.emit(node);
    }
  }

  private bindPhis(): void {
    for (const block of this.layout) {
      for (const phi of block.phis) this.registerFor(phi);
    }
  }

  private bindParameters(): void {
    const convention = this.lowering.target.abi.callingConvention;
    const scalars = this.legality.parameterScalars;
    const locations = argumentLocations(
      convention,
      scalars.map((scalar) => this.classOf(scalar)),
    );
    for (let index = 0; index < this.graph.parameters.length; index++) {
      const parameter = this.graph.parameters[index]!;
      if (parameter.uses.length === 0) continue;
      const scalar = scalars[index]!;
      const destination = def(this.registerFor(parameter), this.widthOf(scalar));
      const location = locations[index]!;
      this.emit(
        location.kind === "register"
          ? this.lowering.copy(destination, use(location.register, this.widthOf(scalar)))
          : this.lowering.loadIncoming(
              destination,
              this.fn.createIncomingSlot(location.offset, this.widthOf(scalar)),
            ),
      );
      this.emitRoot(parameter);
    }
  }

  private scalarOf(value: CFGInstruction): AotScalar {
    return this.legality.scalarOf(value);
  }

  private widthOf(scalar: AotScalar): number {
    return this.lowering.target.locationOf(scalar).width;
  }

  private classOf(scalar: AotScalar): RegisterClassId {
    return this.lowering.target.locationOf(scalar).classId;
  }

  private registerFor(value: CFGInstruction): VirtualRegister {
    const existing = this.registers.get(value);
    if (existing !== undefined) return existing;
    const scalar = this.scalarOf(value);
    const created = this.fn.createVirtual(this.classOf(scalar), this.widthOf(scalar));
    this.registers.set(value, created);
    return created;
  }

  private emit(node: MachineInstruction): MachineInstruction {
    if (node.source === null) node.source = this.source;
    this.current.instructions.push(node);
    return node;
  }

  private valueRegister(value: CFGInstruction): VirtualRegister {
    if (value.type !== IR_CONSTANT) return this.registerFor(value);
    return this.lowering.materialize(this.contextFor(value), value);
  }

  private incoming(phi: CFGInstruction, input: CFGInstruction): VirtualRegister {
    const source = this.valueRegister(input);
    const from = this.scalarOf(input);
    const to = this.scalarOf(phi);
    if (from === to) return source;
    return this.lowering.convert(this.contextFor(phi), source, from, to);
  }

  private guard(name: string): SelectionFork {
    const entry = this.current;
    const suffix = `${name}_${this.guards++}`;
    const taken = this.fn.createBlock(`${entry.label}_${suffix}`);
    const rejoin = this.fn.createBlock(`${entry.label}_${suffix}_join`);
    this.fn.insertAfter(entry, taken);
    this.fn.insertAfter(taken, rejoin);
    this.linkBlocks(entry, taken);
    this.linkBlocks(entry, rejoin);
    this.linkBlocks(taken, rejoin);
    return {
      taken,
      rejoin,
      enterTaken: () => {
        this.current = taken;
      },
      enterRejoin: () => {
        this.current = rejoin;
      },
    };
  }

  private linkBlocks(from: MachineBlock, to: MachineBlock): void {
    if (from.successors.includes(to)) return;
    from.successors.push(to);
    to.predecessors.push(from);
  }

  private successorFor(node: CFGInstruction, prop: string): MachineBlock {
    const targetId = node.props[prop];
    for (const successor of this.currentCfg.successors) {
      if (successor.id === targetId) return this.edgeTarget(successor);
    }
    throw new Error(`block ${this.currentCfg.id} has no successor for ${prop}`);
  }

  private edgeTarget(successor: CFGBlock): MachineBlock {
    const key = `${this.currentCfg.id}->${successor.id}`;
    const cached = this.edgeTargets.get(key);
    if (cached !== undefined) return cached;

    const phis = successor.phis;
    const landing = this.machineOf.get(successor)!;
    const source = this.current;
    let entry = landing;

    if (phis.length > 0) {
      if (this.currentCfg.successors.length > 1) {
        entry = this.fn.createBlock(`${source.label}_to_${landing.label.slice(1)}`);
        this.fn.insertAfter(source, entry);
        this.current = entry;
        this.emitPhiCopies(successor, phis);
        this.emit(this.lowering.jump(landing));
        this.current = source;
        this.linkBlocks(entry, landing);
      } else {
        this.emitPhiCopies(successor, phis);
      }
    }

    this.linkBlocks(source, entry);
    this.edgeTargets.set(key, entry);
    return entry;
  }

  private emitPhiCopies(successor: CFGBlock, phis: readonly CFGInstruction[]): void {
    const predIndex = successor.predecessors.indexOf(this.currentCfg);
    if (predIndex < 0) {
      throw new Error(
        `edge B${this.currentCfg.id}->B${successor.id} is not a predecessor edge`,
      );
    }
    const copies = phis.map((phi) => ({
      destination: this.registerFor(phi),
      source: this.incoming(phi, phi.inputs[predIndex]!),
    }));
    sequenceParallelCopies(
      copies,
      (destination, source) =>
        void this.emit(
          this.lowering.copy(
            def(destination, destination.width),
            use(source, source.width),
          ),
        ),
      (like) => this.fn.createVirtual(like.classId, like.width),
    );
    for (const phi of phis) this.emitRoot(phi);
  }

  private emitCall(
    target: MachineOperand,
    args: readonly VirtualRegister[],
    destination: VirtualRegister | null,
  ): void {
    const convention = this.lowering.target.abi.callingConvention;
    const pointerWidth = this.lowering.target.abi.pointerWidthBytes;
    const locations = argumentLocations(
      convention,
      args.map((argument) => argument.classId),
    );

    const operands: MachineOperand[] = [];
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]!;
      const source = use(argument, argument.width);
      const location = locations[index]!;
      if (location.kind === "register") {
        this.emit(this.lowering.copy(def(location.register, argument.width), source));
        operands.push(use(location.register, argument.width));
      } else {
        this.emit(this.lowering.storeOutgoing(location.offset, source));
      }
    }
    for (const clobbered of convention.callerSaved) {
      operands.push(def(clobbered, pointerWidth));
    }

    this.fn.hasCalls = true;
    this.fn.outgoingBytes = Math.max(
      this.fn.outgoingBytes,
      outgoingArgumentBytes(convention, locations),
    );
    this.emit(this.lowering.call(target, operands));

    if (destination === null) return;
    const returned = convention.returnRegisters.get(destination.classId);
    if (returned === undefined) {
      throw new Error(`${convention.name} has no return register for ${destination.classId}`);
    }
    this.emit(
      this.lowering.copy(
        def(destination, destination.width),
        use(returned, destination.width),
      ),
    );
  }

  private contextFor(node: CFGInstruction): SelectionContext {
    return {
      node,
      fn: this.fn,
      legality: this.legality,
      classes: this.graph.classes,
      target: this.lowering.target,
      data: this.fn.data,
      emit: (created) => this.emit(created),
      registerOf: (value) => this.valueRegister(value),
      resultOf: () => {
        const register = this.registerFor(node);
        return def(register, register.width);
      },
      resultRegister: () => this.registerFor(node),
      temp: (scalar) => this.fn.createVirtual(this.classOf(scalar), this.widthOf(scalar)),
      tempIn: (classId, width) => this.fn.createVirtual(classId, width),
      scalarOf: (value) => this.scalarOf(value),
      widthOf: (scalar) => this.widthOf(scalar),
      classOf: (scalar) => this.classOf(scalar),
      constantOf: (value) => (value.type === IR_CONSTANT ? value.props.value : undefined),
      successorFor: (prop) => this.successorFor(node, prop),
      guard: (name) => this.guard(name),
      emitCall: (symbol, args, destination) => this.emitCall(sym(symbol), args, destination),
      emitCallThrough: (through, args, destination) =>
        this.emitCall(use(through, through.width), args, destination),
      reference: (symbol) => void this.fn.references.add(symbol),
      external: (symbol) => void this.fn.externals.add(symbol),
      isSoleUseOfTerminator: (value) => this.fusionOf.get(node) === value,
    };
  }
}

export function selectMachineFunction(
  graph: CFGFunction,
  legality: AotLegality,
  lowering: MachineLowering,
  layout: readonly CFGBlock[],
  symbol: string,
): MachineFunction {
  if (layout.length === 0) throw new MachineSelectionError("function has no reachable blocks");
  return new Selector(graph, legality, lowering, layout, symbol).run();
}

export function emittedOpcodesOf(lowering: MachineLowering): ReadonlySet<string> {
  return new Set([...lowering.rules()].map(([opcode]) => opcode));
}

export function fusedConditionOf(
  context: SelectionContext,
): CFGInstruction | null {
  const condition = context.node.inputs[0];
  if (condition === undefined) return null;
  return context.isSoleUseOfTerminator(condition) ? condition : null;
}

export function fusedInputOf(context: SelectionContext): CFGInstruction | null {
  for (const input of context.node.inputs) {
    if (context.isSoleUseOfTerminator(input)) return input;
  }
  return null;
}
