export type RegisterClassId = string;

export function allocationOrder(
  candidates: readonly string[],
  callerSaved: ReadonlySet<string>,
): readonly string[] {
  return [
    ...candidates.filter((name) => callerSaved.has(name)),
    ...candidates.filter((name) => !callerSaved.has(name)),
  ];
}

export interface PhysicalRegister {
  readonly kind: "physical";
  readonly index: number;
  readonly name: string;
  readonly classId: RegisterClassId;
}

export interface RegisterClassSpec {
  readonly id: RegisterClassId;
  readonly width: number;
  readonly saveBytes: number;
  readonly allocation: readonly string[];
  readonly scratch: readonly string[];
  readonly reserved?: readonly string[];
}

export interface RegisterClass {
  readonly id: RegisterClassId;
  readonly width: number;
  readonly saveBytes: number;
  readonly allocation: readonly PhysicalRegister[];
  readonly scratch: readonly PhysicalRegister[];
  readonly members: readonly PhysicalRegister[];
}

export class UnknownRegisterError extends Error {
  constructor(name: string) {
    super(`no physical register named ${name}`);
    this.name = "UnknownRegisterError";
  }
}

export class UnknownRegisterClassError extends Error {
  constructor(id: RegisterClassId) {
    super(`no register class named ${id}`);
    this.name = "UnknownRegisterClassError";
  }
}

export class RegisterFile {
  readonly classes: readonly RegisterClass[];
  readonly registers: readonly PhysicalRegister[];
  private readonly byName = new Map<string, PhysicalRegister>();
  private readonly byClass = new Map<RegisterClassId, RegisterClass>();

  constructor(specs: readonly RegisterClassSpec[]) {
    const registers: PhysicalRegister[] = [];
    const classes: RegisterClass[] = [];
    const intern = (name: string, classId: RegisterClassId): PhysicalRegister => {
      const existing = this.byName.get(name);
      if (existing !== undefined) return existing;
      const register: PhysicalRegister = {
        kind: "physical",
        index: registers.length,
        name,
        classId,
      };
      registers.push(register);
      this.byName.set(name, register);
      return register;
    };

    for (const spec of specs) {
      const allocation = spec.allocation.map((name) => intern(name, spec.id));
      const scratch = spec.scratch.map((name) => intern(name, spec.id));
      const reserved = (spec.reserved ?? []).map((name) => intern(name, spec.id));
      const machineClass: RegisterClass = {
        id: spec.id,
        width: spec.width,
        saveBytes: spec.saveBytes,
        allocation: Object.freeze(allocation),
        scratch: Object.freeze(scratch),
        members: Object.freeze([...allocation, ...scratch, ...reserved]),
      };
      classes.push(machineClass);
      this.byClass.set(spec.id, machineClass);
    }

    this.classes = Object.freeze(classes);
    this.registers = Object.freeze(registers);
  }

  get size(): number {
    return this.registers.length;
  }

  classOf(id: RegisterClassId): RegisterClass {
    const machineClass = this.byClass.get(id);
    if (machineClass === undefined) throw new UnknownRegisterClassError(id);
    return machineClass;
  }

  register(name: string): PhysicalRegister {
    const register = this.byName.get(name);
    if (register === undefined) throw new UnknownRegisterError(name);
    return register;
  }

  select(names: readonly string[]): readonly PhysicalRegister[] {
    return Object.freeze(names.map((name) => this.register(name)));
  }
}
