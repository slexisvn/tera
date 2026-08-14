import { VMTypeError } from "../core/errors/index.js";
import type { RuntimeFunctionPayload } from "../core/value/index.js";

export type RuntimeInterfaceMember = {
  name: string;
  optional: boolean;
};

export type RuntimeInterfaceContract = {
  name: string;
  members: RuntimeInterfaceMember[];
};

export function runtimeInterfaceBaseName(name: string): string {
  const match = name.match(/^([A-Za-z_$][\w$]*)\s*</);
  return match ? match[1] : name;
}

export function assertClassImplementsRuntime(ctor: RuntimeFunctionPayload, contracts: RuntimeInterfaceContract[]): void {
  if (!contracts.length) return;
  const className = ctor.classOwnerName || ctor.name || "<anonymous>";
  const names = new Set(ctor.classImplementedInterfaces ?? []);
  for (const contract of contracts) {
    names.add(contract.name);
    for (const member of contract.members) {
      if (member.optional || hasPublicInstanceMember(ctor, member.name)) continue;
      throw new VMTypeError(`Class '${className}' is missing '${member.name}' required by interface '${contract.name}'`);
    }
  }
  ctor.classImplementedInterfaces = [...names];
}

function hasPublicInstanceMember(ctor: RuntimeFunctionPayload | null | undefined, name: string): boolean {
  for (let current = ctor; current; current = current.staticBase ?? null) {
    if (current.classInstancePublicMembers?.[name]) return true;
  }
  return false;
}
