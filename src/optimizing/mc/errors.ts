export class MachineCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineCodeError";
  }
}

export class UnsupportedInstructionError extends MachineCodeError {
  constructor(target: string, opcode: string) {
    super(`${target} has no encoding for ${opcode}`);
    this.name = "UnsupportedInstructionError";
  }
}

export class UnsupportedOperandError extends MachineCodeError {
  constructor(target: string, opcode: string, reason: string) {
    super(`${target} cannot encode ${opcode}: ${reason}`);
    this.name = "UnsupportedOperandError";
  }
}

export class UndefinedSymbolError extends MachineCodeError {
  constructor(name: string) {
    super(`symbol ${name} is referenced but never defined`);
    this.name = "UndefinedSymbolError";
  }
}

export class FixupOutOfRangeError extends MachineCodeError {
  constructor(kind: string, value: number) {
    super(`fixup ${kind} cannot represent displacement ${value}`);
    this.name = "FixupOutOfRangeError";
  }
}

export class UnsupportedRelocationError extends MachineCodeError {
  constructor(kind: string, flavor: string, symbol: string) {
    super(`a ${flavor} object cannot relocate ${symbol} with fixup ${kind}`);
    this.name = "UnsupportedRelocationError";
  }
}

export class RelaxationLimitError extends MachineCodeError {
  constructor(opcode: string, kind: string) {
    super(`${opcode} has no wider form to satisfy ${kind}`);
    this.name = "RelaxationLimitError";
  }
}
