import { VMTypeError } from "../core/errors/index.js";
import { getPayload, isFunction, isObject, type RuntimeFunctionPayload, type TaggedValue } from "../core/value/index.js";
import { DEFAULT_CLASS_VISIBILITY, type ClassVisibility } from "../core/class-visibility.js";

export type ClassAccessInterpreter = {
  currentClassOwnerName?(): string | null;
  currentClassConstructor?(): RuntimeFunctionPayload | null;
};

type RuntimeObjectLike = {
  constructorRef?: TaggedValue | RuntimeFunctionPayload | null;
  prototype?: RuntimeObjectLike | null;
};

type MemberAccess = {
  owner: RuntimeFunctionPayload;
  ownerName: string;
  visibility: ClassVisibility;
};

export function currentClassOwnerName(interpreter?: unknown): string | null {
  return (interpreter as ClassAccessInterpreter | null | undefined)?.currentClassOwnerName?.() ?? null;
}

export function currentClassConstructor(interpreter?: unknown): RuntimeFunctionPayload | null {
  return (interpreter as ClassAccessInterpreter | null | undefined)?.currentClassConstructor?.() ?? null;
}

export function constructorPayload(value: TaggedValue | RuntimeFunctionPayload | null | undefined): RuntimeFunctionPayload | null {
  if (!value) return null;
  if (isFunction(value as TaggedValue)) return getPayload(value as TaggedValue) as RuntimeFunctionPayload;
  return value as RuntimeFunctionPayload;
}

export function objectConstructor(obj: RuntimeObjectLike | null | undefined): RuntimeFunctionPayload | null {
  if (!obj) return null;
  const direct = constructorPayload(obj.constructorRef);
  if (direct) return direct;
  return constructorPayload(obj.prototype?.constructorRef);
}

export function assertConstructorAccess(callee: RuntimeFunctionPayload, interpreter?: unknown): void {
  if (callee.classAbstract) {
    throw new VMTypeError(`Cannot instantiate abstract class '${ownerNameOf(callee)}'`);
  }
  const visibility = callee.classConstructorVisibility ?? DEFAULT_CLASS_VISIBILITY;
  if (visibility === "public") return;
  const ownerName = ownerNameOf(callee);
  if (constructorAccessAllowed(visibility, ownerName, interpreter)) return;
  throw new VMTypeError(`Cannot access ${visibility} constructor '${ownerName}'`);
}

export function assertObjectMemberAccess(
  receiver: RuntimeObjectLike,
  owner: RuntimeObjectLike | null,
  propName: string,
  interpreter?: unknown,
): void {
  const access = instanceMemberAccess(receiver, owner, propName);
  if (!access || memberAccessAllowed(access, objectConstructor(receiver), interpreter)) return;
  throwAccess(access, propName);
}

export function assertFunctionMemberAccess(
  receiver: RuntimeFunctionPayload,
  propName: string,
  interpreter?: unknown,
  owner: RuntimeFunctionPayload | null = null,
): void {
  const access = staticMemberAccess(owner ?? receiver, propName);
  if (!access || memberAccessAllowed(access, receiver, interpreter)) return;
  throwAccess(access, propName);
}

export function canAccessObjectMember(
  receiver: RuntimeObjectLike,
  owner: RuntimeObjectLike | null,
  propName: string,
  interpreter?: unknown,
): boolean {
  const access = instanceMemberAccess(receiver, owner, propName);
  return !access || memberAccessAllowed(access, objectConstructor(receiver), interpreter);
}

export function canAccessFunctionMember(
  receiver: RuntimeFunctionPayload,
  propName: string,
  interpreter?: unknown,
  owner: RuntimeFunctionPayload | null = null,
): boolean {
  const access = staticMemberAccess(owner ?? receiver, propName);
  return !access || memberAccessAllowed(access, receiver, interpreter);
}

export function hasRestrictedObjectMember(receiver: RuntimeObjectLike, owner: RuntimeObjectLike | null, propName: string): boolean {
  const access = instanceMemberAccess(receiver, owner, propName);
  return !!access && access.visibility !== "public";
}

export function hasRestrictedFunctionMember(receiver: RuntimeFunctionPayload, propName: string, owner: RuntimeFunctionPayload | null = null): boolean {
  const access = staticMemberAccess(owner ?? receiver, propName);
  return !!access && access.visibility !== "public";
}

function instanceMemberAccess(receiver: RuntimeObjectLike, owner: RuntimeObjectLike | null, propName: string): MemberAccess | null {
  const ownerCtor = objectConstructor(owner);
  const targetCtor = objectConstructor(receiver);
  return findMemberAccess(ownerCtor ?? targetCtor, propName, "classInstanceMemberVisibility");
}

function staticMemberAccess(owner: RuntimeFunctionPayload, propName: string): MemberAccess | null {
  return findMemberAccess(owner, propName, "classStaticMemberVisibility");
}

function findMemberAccess(
  ctor: RuntimeFunctionPayload | null,
  propName: string,
  tableName: "classInstanceMemberVisibility" | "classStaticMemberVisibility",
): MemberAccess | null {
  for (let current = ctor; current; current = current.staticBase ?? null) {
    const table = current[tableName];
    const visibility = table?.[propName];
    if (!visibility) continue;
    return { owner: current, ownerName: ownerNameOf(current), visibility };
  }
  return null;
}

function memberAccessAllowed(
  access: MemberAccess,
  targetCtor: RuntimeFunctionPayload | null,
  interpreter?: unknown,
): boolean {
  if (access.visibility === "public") return true;
  const caller = currentClassOwnerName(interpreter);
  if (!caller) return false;
  if (access.visibility === "private") return caller === access.ownerName;
  return caller === access.ownerName || lineageIncludesBeforeOwner(targetCtor, caller, access.ownerName);
}

function constructorAccessAllowed(
  visibility: ClassVisibility,
  ownerName: string,
  interpreter?: unknown,
): boolean {
  if (visibility === "public") return true;
  const caller = currentClassOwnerName(interpreter);
  if (!caller) return false;
  if (visibility === "private") return caller === ownerName;
  const callerCtor = currentClassConstructor(interpreter);
  return caller === ownerName || lineageIncludes(callerCtor, ownerName);
}

function lineageIncludesBeforeOwner(
  targetCtor: RuntimeFunctionPayload | null,
  callerName: string,
  ownerName: string,
): boolean {
  let sawCaller = callerName === ownerName;
  for (let current = targetCtor; current; current = current.staticBase ?? null) {
    const name = ownerNameOf(current);
    if (name === callerName) sawCaller = true;
    if (name === ownerName) return sawCaller;
  }
  return false;
}

function lineageIncludes(ctor: RuntimeFunctionPayload | null, ownerName: string): boolean {
  for (let current = ctor; current; current = current.staticBase ?? null) {
    if (ownerNameOf(current) === ownerName) return true;
  }
  return false;
}

function ownerNameOf(ctor: RuntimeFunctionPayload): string {
  return ctor.classOwnerName || ctor.name || "<anonymous>";
}

function throwAccess(access: MemberAccess, propName: string): never {
  throw new VMTypeError(`Cannot access ${access.visibility} member '${propName}' of '${access.ownerName}'`);
}
