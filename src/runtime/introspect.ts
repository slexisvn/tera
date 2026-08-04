import {
  getPayload,
  isFunction,
  isObject,
  type RuntimeFunctionPayload,
  type TaggedValue,
} from "../core/value/index.js";
import { AccessorPair, type JSObject } from "../objects/heap/js-object.js";
import type { FunctionAccessor } from "../core/value/index.js";
import type { ClassVisibility } from "../core/class-visibility.js";
import type { GlobalCellMap } from "./intrinsics/global-cells.js";

export type IntrospectedMemberKind = "method" | "property" | "field";
export type IntrospectedMember = { name: string; kind: IntrospectedMemberKind };

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function parseReceiverPath(expr: string): string[] | null {
  const segments = expr.split(".").map((segment) => segment.trim());
  if (segments.some((segment) => !IDENTIFIER.test(segment))) return null;
  return segments;
}

export function resolveReceiverValue(globals: GlobalCellMap, expr: string): TaggedValue | null {
  const path = parseReceiverPath(expr);
  if (!path) return null;
  let value = globals.read(path[0]);
  for (let index = 1; value !== undefined && index < path.length; index++) {
    if (!isObject(value)) return null;
    value = readDataProperty(getPayload(value), path[index]);
  }
  return value ?? null;
}

export function introspectReceiverMembers(globals: GlobalCellMap, expr: string): IntrospectedMember[] | null {
  const value = resolveReceiverValue(globals, expr);
  return value === null ? null : memberNamesOf(value);
}

export function memberNamesOf(value: TaggedValue): IntrospectedMember[] | null {
  if (isObject(value)) return objectMembers(getPayload(value));
  if (isFunction(value)) return functionMembers(getPayload(value));
  return null;
}

function readDataProperty(obj: JSObject, name: string): TaggedValue | undefined {
  const found = obj.lookupPrototypeChain(name);
  if (!found.found || found.value === undefined || found.value instanceof AccessorPair) return undefined;
  return found.value;
}

function objectMembers(obj: JSObject): IntrospectedMember[] {
  const collected = new Map<string, IntrospectedMemberKind>();
  for (let level: JSObject | null = obj; level; level = level.prototype) {
    const visibility = memberVisibility(level, false);
    for (const name of level.getOwnPropertyNames()) {
      if (collected.has(name) || !isVisible(visibility, name)) continue;
      collected.set(name, classifyOwnMember(level, name));
    }
  }
  return toMembers(collected);
}

function functionMembers(fn: RuntimeFunctionPayload): IntrospectedMember[] | null {
  const collected = new Map<string, IntrospectedMemberKind>();
  for (let level: RuntimeFunctionPayload | null | undefined = fn; level; level = level.staticBase) {
    const visibility = level.classStaticMemberVisibility;
    collectRecord(collected, level.properties, visibility);
    collectAccessors(collected, level.accessors, visibility);
  }
  return collected.size ? toMembers(collected) : null;
}

function collectRecord(
  target: Map<string, IntrospectedMemberKind>,
  record: Record<string, TaggedValue> | undefined,
  visibility: Record<string, ClassVisibility> | undefined,
): void {
  if (!record) return;
  for (const [name, value] of Object.entries(record)) {
    if (target.has(name) || !isVisible(visibility, name)) continue;
    target.set(name, isFunction(value) ? "method" : "field");
  }
}

function collectAccessors(
  target: Map<string, IntrospectedMemberKind>,
  accessors: Record<string, FunctionAccessor> | undefined,
  visibility: Record<string, ClassVisibility> | undefined,
): void {
  if (!accessors) return;
  for (const name of Object.keys(accessors)) {
    if (target.has(name) || !isVisible(visibility, name)) continue;
    target.set(name, "property");
  }
}

function classifyOwnMember(level: JSObject, name: string): IntrospectedMemberKind {
  const descriptor = level.getOwnPropertyDescriptor(name);
  if (!descriptor) return "field";
  if (descriptor.kind === "accessor") return "property";
  return descriptor.value !== undefined && isFunction(descriptor.value) ? "method" : "field";
}

function memberVisibility(obj: JSObject, staticMember: boolean): Record<string, ClassVisibility> | undefined {
  const ctor = constructorPayload(obj);
  if (!ctor) return undefined;
  return staticMember ? ctor.classStaticMemberVisibility : ctor.classInstanceMemberVisibility;
}

function constructorPayload(obj: JSObject): RuntimeFunctionPayload | null {
  const ref = obj.constructorRef;
  if (ref === null || ref === undefined) return null;
  if (typeof ref === "number") return isFunction(ref) ? getPayload(ref) : null;
  return ref;
}

function isVisible(visibility: Record<string, ClassVisibility> | undefined, name: string): boolean {
  if (name === "constructor") return false;
  const declared = visibility?.[name];
  return declared === undefined || declared === "public";
}

function toMembers(collected: Map<string, IntrospectedMemberKind>): IntrospectedMember[] {
  return Array.from(collected, ([name, kind]) => ({ name, kind }));
}
