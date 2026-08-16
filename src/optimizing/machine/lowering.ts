import type { NominalTypes } from "../types/declared.js";
import type { CFGInstruction } from "../ir/index.js";
import type { AotLegality } from "../analyses/aot-legality.js";
import type { AotScalar } from "../types/scalar.js";
import type { MachineTargetModel } from "../target/model.js";
import type { RegisterClassId } from "../target/registers.js";
import type { FrameLayout } from "./frame.js";
import type {
  MachineBlock,
  MachineDataPool,
  MachineFunction,
  MachineInstruction,
  MachineOperand,
  RegisterOperand,
  StackSlot,
  VirtualRegister,
} from "./ir.js";

export interface SelectionFork {
  readonly taken: MachineBlock;
  readonly rejoin: MachineBlock;
  enterTaken(): void;
  enterRejoin(): void;
}

export interface SelectionContext {
  readonly node: CFGInstruction;
  readonly fn: MachineFunction;
  readonly legality: AotLegality;
  readonly classes: NominalTypes | null;
  readonly target: MachineTargetModel;
  readonly data: MachineDataPool;
  emit(node: MachineInstruction): MachineInstruction;
  registerOf(value: CFGInstruction): VirtualRegister;
  resultOf(): RegisterOperand;
  resultRegister(): VirtualRegister;
  temp(scalar: AotScalar): VirtualRegister;
  tempIn(classId: RegisterClassId, width: number): VirtualRegister;
  scalarOf(value: CFGInstruction): AotScalar;
  widthOf(scalar: AotScalar): number;
  classOf(scalar: AotScalar): RegisterClassId;
  constantOf(value: CFGInstruction): unknown;
  successorFor(prop: string): MachineBlock;
  guard(name: string): SelectionFork;
  emitCall(
    symbol: string,
    args: readonly VirtualRegister[],
    destination: VirtualRegister | null,
  ): void;
  reference(symbol: string): void;
  external(symbol: string): void;
  isSoleUseOfTerminator(value: CFGInstruction): boolean;
}

export type SelectionHandler = (context: SelectionContext) => void;

export interface MachineLowering {
  readonly target: MachineTargetModel;
  rules(): Iterable<readonly [string, SelectionHandler]>;
  materialize(context: SelectionContext, constant: CFGInstruction): VirtualRegister;
  convert(
    context: SelectionContext,
    source: VirtualRegister,
    from: AotScalar,
    to: AotScalar,
  ): VirtualRegister;
  copy(destination: RegisterOperand, source: RegisterOperand): MachineInstruction;
  reload(destination: RegisterOperand, slot: StackSlot): MachineInstruction;
  spill(slot: StackSlot, source: RegisterOperand): MachineInstruction;
  loadIncoming(destination: RegisterOperand, slot: StackSlot): MachineInstruction;
  storeOutgoing(offset: number, source: RegisterOperand): MachineInstruction;
  jump(target: MachineBlock): MachineInstruction;
  call(symbol: string, operands: MachineOperand[]): MachineInstruction;
  storeRoot(
    frame: StackSlot,
    index: number,
    value: RegisterOperand,
    address: VirtualRegister,
  ): readonly MachineInstruction[];
  prologue(frame: FrameLayout): readonly MachineInstruction[];
  epilogue(frame: FrameLayout): readonly MachineInstruction[];
}
