import { tracer } from "../../core/tracing/index.js";
import {
  dependencyRegistry,
  DEP_MAP,
  DEP_PROTO_VALIDITY,
} from "../../deopt/dependencies.js";

let nextHiddenClassId = 0;

const TRANSITION_ADD = "add";
const TRANSITION_DELETE = "delete";
const TRANSITION_RECONFIGURE = "reconfigure";
const TRANSITION_INTEGRITY = "integrity";

const INTEGRITY_NONE = "none";
const INTEGRITY_PREVENTEXTENSIONS = "preventExtensions";
const INTEGRITY_SEALED = "sealed";
const INTEGRITY_FROZEN = "frozen";

const MAX_TRANSITIONS_BEFORE_UNSTABLE = 32;
const MAX_DEPRECATIONS_BEFORE_FREEZE = 5;

const allHiddenClasses = new Map<number, HiddenClass>();
const deprecatedMaps = new Map<number, HiddenClass>();
const migrationTargetCache = new Map<string, HiddenClass>();

type TransitionType =
  | typeof TRANSITION_ADD
  | typeof TRANSITION_DELETE
  | typeof TRANSITION_RECONFIGURE
  | typeof TRANSITION_INTEGRITY;

type IntegrityLevel =
  | typeof INTEGRITY_NONE
  | typeof INTEGRITY_PREVENTEXTENSIONS
  | typeof INTEGRITY_SEALED
  | typeof INTEGRITY_FROZEN;

type PropertyKind = "data" | "accessor";

type PrototypeValidityCell = {
  version: number;
};

type TransitionMetadata = {
  type: TransitionType | null;
  key: string | null;
  fromId: number;
  toId: number;
};

type HiddenClassStatistics = {
  id: number;
  propertyCount: number;
  version: number;
  descriptorVersion: number;
  prototypeValidityVersion: number;
  objectCount: number;
  isStable: boolean;
  isDeprecated: boolean;
  migrationTargetId: number | null;
  integrityLevel: IntegrityLevel;
  totalTransitionCount: number;
  addTransitionCount: number;
  deleteTransitionCount: number;
  integrityTransitionCount: number;
  reconfigureTransitionCount: number;
};

export class PropertyDescriptor {
  offset: number;
  kind: PropertyKind;
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
  order: number;

  constructor(
    offset: number,
    kind: PropertyKind,
    writable: boolean,
    enumerable: boolean,
    configurable: boolean,
  ) {
    this.offset = offset;
    this.kind = kind;
    this.writable = writable;
    this.enumerable = enumerable;
    this.configurable = configurable;
    this.order = offset;
  }

  clone(): PropertyDescriptor {
    const copy = new PropertyDescriptor(
      this.offset,
      this.kind,
      this.writable,
      this.enumerable,
      this.configurable,
    );
    copy.order = this.order;
    return copy;
  }

  equals(other: PropertyDescriptor): boolean {
    return (
      this.offset === other.offset &&
      this.kind === other.kind &&
      this.writable === other.writable &&
      this.enumerable === other.enumerable &&
      this.configurable === other.configurable
    );
  }
}

export class DescriptorArray {
  entries: Map<string, PropertyDescriptor>;
  version: number;

  constructor(entries?: Iterable<[string, PropertyDescriptor]>) {
    this.entries = entries ? new Map(entries) : new Map<string, PropertyDescriptor>();
    this.version = 0;
  }

  clone(): DescriptorArray {
    const entries: Array<[string, PropertyDescriptor]> = [];
    for (const [key, desc] of this.entries) {
      entries.push([key, desc.clone()]);
    }
    const descriptors = new DescriptorArray(entries);
    descriptors.version = this.version;
    return descriptors;
  }

  get(name: string): PropertyDescriptor | null {
    return this.entries.get(name) || null;
  }

  set(name: string, descriptor: PropertyDescriptor): void {
    this.entries.set(name, descriptor);
    this.version++;
  }

  delete(name: string): boolean {
    const deleted = this.entries.delete(name);
    if (deleted) this.version++;
    return deleted;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  [Symbol.iterator](): IterableIterator<[string, PropertyDescriptor]> {
    return this.entries[Symbol.iterator]();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class HiddenClass {
  id: number;
  parent: HiddenClass | null;
  transitions: Map<string, HiddenClass>;
  deleteTransitions: Map<string, HiddenClass>;
  integrityTransitions: Map<string, HiddenClass>;
  reconfigureTransitions: Map<string, HiddenClass>;
  isStable: boolean;
  integrityLevel: IntegrityLevel;
  objectCount: number;
  totalTransitionCount: number;
  transitionType: TransitionType | null;
  transitionKey: string | null;
  instanceType: string | null;
  isDeprecated: boolean;
  migrationTarget: HiddenClass | null;
  deprecationCount: number;
  version: number;
  prototypeValidityCell: PrototypeValidityCell;
  descriptorVersion: number;
  _sharedExtended: boolean;
  _descMap: Map<string, PropertyDescriptor>;
  propertyCount: number;

  constructor(
    parent: HiddenClass | null,
    transitionType: TransitionType | null,
    transitionKey: string | null,
    offset: number,
  ) {
    this.id = nextHiddenClassId++;
    this.parent = parent;
    this.transitions = new Map();
    this.deleteTransitions = new Map();
    this.integrityTransitions = new Map();
    this.reconfigureTransitions = new Map();
    this.isStable = true;
    this.integrityLevel = INTEGRITY_NONE;
    this.objectCount = 0;
    this.totalTransitionCount = 0;
    this.transitionType = transitionType;
    this.transitionKey = transitionKey;

    this.instanceType = null;
    this.isDeprecated = false;
    this.migrationTarget = null;
    this.deprecationCount = 0;
    this.version = 0;
    this.prototypeValidityCell = { version: 0 };

    this.descriptorVersion = 0;
    this._sharedExtended = false;

    if (!parent) {
      this._descMap = new Map();
      this.propertyCount = 0;
    } else {
      this.integrityLevel = parent.integrityLevel;
      this.prototypeValidityCell = parent.prototypeValidityCell;
      this.descriptorVersion = parent.descriptorVersion + 1;
      if (transitionType === TRANSITION_ADD && transitionKey !== null) {
        const desc = new PropertyDescriptor(offset, "data", true, true, true);
        desc.order = parent.propertyCount;
        if (!parent._sharedExtended) {
          this._descMap = parent._descMap;
          this._descMap.set(transitionKey, desc);
          parent._sharedExtended = true;
        } else {
          this._descMap = new Map();
          for (const [k, d] of parent._descMap) {
            if (d.order < parent.propertyCount) this._descMap.set(k, d);
          }
          this._descMap.set(transitionKey, desc);
        }
        this.propertyCount = parent.propertyCount + 1;
      } else {
        this._descMap = new Map();
        let order = 0;
        for (const [k, d] of parent._ownEntries()) {
          const c = d.clone();
          c.order = order++;
          this._descMap.set(k, c);
        }
        if (transitionType === TRANSITION_DELETE && transitionKey !== null) {
          this._descMap.delete(transitionKey);
        }
        this.propertyCount = this._descMap.size;
      }
    }
    allHiddenClasses.set(this.id, this);
  }

  _ownEntries(): Array<[string, PropertyDescriptor]> {
    const out: Array<[string, PropertyDescriptor]> = [];
    for (const [name, d] of this._descMap) {
      if (d.order < this.propertyCount) out.push([name, d]);
    }
    return out;
  }

  get properties(): Array<[string, PropertyDescriptor]> {
    return this._ownEntries();
  }

  incrementObjectCount(): void {
    this.objectCount++;
  }

  decrementObjectCount(): void {
    if (this.objectCount > 0) this.objectCount--;
  }

  markUnstable(): void {
    this.isStable = false;
    this.version++;
  }

  invalidate(reason: string): void {
    const oldVersion = this.version;
    const oldProtoVersion = this.prototypeValidityCell.version;
    this.version++;
    this.prototypeValidityCell.version++;
    this.isStable = false;
    dependencyRegistry.invalidate(DEP_MAP, this.id, oldVersion, reason);
    dependencyRegistry.invalidate(
      DEP_PROTO_VALIDITY,
      this.id,
      oldProtoVersion,
      reason,
    );
    tracer.log("hidden-class", `HC${this.id} invalidated (${reason})`);
  }

  deprecate(reason: string): HiddenClass {
    if (this.isDeprecated) return this.migrationTarget!;

    this.isDeprecated = true;
    this.isStable = false;

    const target = this._buildMigrationTarget();
    this.migrationTarget = target;

    deprecatedMaps.set(this.id, target);
    tracer.log(
      "hidden-class",
      `HC${this.id} deprecated (${reason}) → migrate to HC${target.id}`,
    );

    return target;
  }

  _buildMigrationTarget(): HiddenClass {
    
    const keyParts: string[] = [];
    for (const [name, desc] of this.properties) {
      keyParts.push(
        `${name}:${desc.kind}:${desc.writable}:${desc.enumerable}:${desc.configurable}`,
      );
    }
    keyParts.push(`integrity:${this.integrityLevel}`);
    const cacheKey = keyParts.join("|");

    
    const cached = migrationTargetCache.get(cacheKey);
    if (cached) return cached;

    let target = new HiddenClass(null, null, null, 0);
    allHiddenClasses.set(target.id, target);

    for (const [name, desc] of this.properties) {
      const next = new HiddenClass(
        target,
        TRANSITION_ADD,
        name,
        target.propertyCount,
      );
      const newDesc = next.lookupProperty(name);
      if (!newDesc) throw new Error(`Missing descriptor for ${name}`);
      newDesc.kind = desc.kind;
      newDesc.writable = desc.writable;
      newDesc.enumerable = desc.enumerable;
      newDesc.configurable = desc.configurable;
      target.transitions.set(name, next);
      target = next;
    }

    target.integrityLevel = this.integrityLevel;

    
    migrationTargetCache.set(cacheKey, target);
    return target;
  }

  getMigrationTarget(): HiddenClass | null {
    if (!this.isDeprecated) return null;
    return this.migrationTarget;
  }

  tryDeprecate(): boolean {
    if (this.isDeprecated) return true;
    if (this.isStable) return false;

    this.deprecationCount++;
    if (this.deprecationCount >= MAX_DEPRECATIONS_BEFORE_FREEZE) {
      this.deprecate("too-many-transitions");
      return true;
    }
    return false;
  }

  checkStability(): void {
    this.totalTransitionCount++;
    if (this.totalTransitionCount > MAX_TRANSITIONS_BEFORE_UNSTABLE) {
      this.isStable = false;
      if (
        this.totalTransitionCount > MAX_TRANSITIONS_BEFORE_UNSTABLE * 2 &&
        !this.isDeprecated
      ) {
        this.deprecate("excessive-transitions");
      }
    }
  }

  transition(propertyName: string): HiddenClass | null {
    if (this.integrityLevel !== INTEGRITY_NONE) {
      return null;
    }

    if (this.transitions.has(propertyName)) {
      return this.transitions.get(propertyName)!;
    }

    const newClass = new HiddenClass(
      this,
      TRANSITION_ADD,
      propertyName,
      this.propertyCount,
    );
    this.transitions.set(propertyName, newClass);
    this.checkStability();

    tracer.hcTransition(this.id, newClass.id, propertyName);

    return newClass;
  }

  transitionWithAttributes(
    propertyName: string,
    kind: PropertyKind,
    writable: boolean,
    enumerable: boolean,
    configurable: boolean,
  ): HiddenClass | null {
    if (this.integrityLevel !== INTEGRITY_NONE) {
      return null;
    }

    const attrKey = `${propertyName}|${kind}|${writable}|${enumerable}|${configurable}`;

    if (this.reconfigureTransitions.has(attrKey)) {
      return this.reconfigureTransitions.get(attrKey)!;
    }

    const existing = this.lookupProperty(propertyName);
    let newClass: HiddenClass;

    if (existing) {
      newClass = new HiddenClass(
        this,
        TRANSITION_RECONFIGURE,
        propertyName,
        existing.offset,
      );
      const desc = newClass.lookupProperty(propertyName);
      if (!desc) throw new Error(`Missing descriptor for ${propertyName}`);
      desc.kind = kind;
      desc.writable = writable;
      desc.enumerable = enumerable;
      desc.configurable = configurable;
    } else {
      newClass = new HiddenClass(
        this,
        TRANSITION_ADD,
        propertyName,
        this.propertyCount,
      );
      const desc = newClass.lookupProperty(propertyName);
      if (!desc) throw new Error(`Missing descriptor for ${propertyName}`);
      desc.kind = kind;
      desc.writable = writable;
      desc.enumerable = enumerable;
      desc.configurable = configurable;
    }

    this.reconfigureTransitions.set(attrKey, newClass);
    this.invalidate(`reconfigure:${propertyName}`);
    this.checkStability();

    tracer.hcTransition(this.id, newClass.id, `${propertyName}[${attrKey}]`);

    return newClass;
  }

  deleteProperty(propertyName: string): HiddenClass | null {
    if (!this.hasProperty(propertyName)) {
      return this;
    }

    const desc = this.lookupProperty(propertyName);
    if (!desc) return this;
    if (!desc.configurable) {
      return null;
    }

    if (this.deleteTransitions.has(propertyName)) {
      return this.deleteTransitions.get(propertyName)!;
    }

    const newClass = new HiddenClass(this, TRANSITION_DELETE, propertyName, 0);

    const remaining = [...newClass._descMap.entries()].sort(
      (a, b) => a[1].order - b[1].order,
    );
    let nextOffset = 0;
    for (const [, d] of remaining) {
      d.offset = nextOffset;
      d.order = nextOffset;
      nextOffset++;
    }
    newClass.propertyCount = newClass._descMap.size;

    this.deleteTransitions.set(propertyName, newClass);
    this.invalidate(`delete:${propertyName}`);
    this.checkStability();

    tracer.hcTransition(this.id, newClass.id, `delete:${propertyName}`);

    return newClass;
  }

  transitionToPreventExtensions(): HiddenClass {
    if (this.integrityLevel !== INTEGRITY_NONE) {
      return this;
    }

    if (this.integrityTransitions.has(INTEGRITY_PREVENTEXTENSIONS)) {
      return this.integrityTransitions.get(INTEGRITY_PREVENTEXTENSIONS)!;
    }

    const newClass = new HiddenClass(
      this,
      TRANSITION_INTEGRITY,
      INTEGRITY_PREVENTEXTENSIONS,
      0,
    );
    newClass.integrityLevel = INTEGRITY_PREVENTEXTENSIONS;
    this.integrityTransitions.set(INTEGRITY_PREVENTEXTENSIONS, newClass);
    this.invalidate(INTEGRITY_PREVENTEXTENSIONS);
    this.checkStability();

    return newClass;
  }

  transitionToSealed(): HiddenClass {
    let base: HiddenClass = this;
    if (base.integrityLevel === INTEGRITY_NONE) {
      base = base.transitionToPreventExtensions();
    }

    if (base.integrityTransitions.has(INTEGRITY_SEALED)) {
      return base.integrityTransitions.get(INTEGRITY_SEALED)!;
    }

    const newClass = new HiddenClass(
      base,
      TRANSITION_INTEGRITY,
      INTEGRITY_SEALED,
      0,
    );
    newClass.integrityLevel = INTEGRITY_SEALED;
    for (const [key, desc] of newClass.properties) {
      desc.configurable = false;
    }
    base.integrityTransitions.set(INTEGRITY_SEALED, newClass);
    base.invalidate(INTEGRITY_SEALED);
    base.checkStability();

    return newClass;
  }

  transitionToFrozen(): HiddenClass {
    let base: HiddenClass = this;
    if (base.integrityLevel === INTEGRITY_NONE) {
      base = base.transitionToPreventExtensions();
    }
    if (base.integrityLevel === INTEGRITY_PREVENTEXTENSIONS) {
      base = base.transitionToSealed();
    }

    if (base.integrityTransitions.has(INTEGRITY_FROZEN)) {
      return base.integrityTransitions.get(INTEGRITY_FROZEN)!;
    }

    const newClass = new HiddenClass(
      base,
      TRANSITION_INTEGRITY,
      INTEGRITY_FROZEN,
      0,
    );
    newClass.integrityLevel = INTEGRITY_FROZEN;
    for (const [key, desc] of newClass.properties) {
      desc.configurable = false;
      if (desc.kind === "data") {
        desc.writable = false;
      }
    }
    base.integrityTransitions.set(INTEGRITY_FROZEN, newClass);
    base.invalidate(INTEGRITY_FROZEN);
    base.checkStability();

    return newClass;
  }

  lookupProperty(name: string): PropertyDescriptor | null {
    const desc = this._descMap.get(name);
    if (desc && desc.order < this.propertyCount) return desc;
    return null;
  }

  hasProperty(name: string): boolean {
    return this.lookupProperty(name) !== null;
  }

  getPropertyNames(): string[] {
    return this._ownEntries().map(([name]) => name);
  }

  getEnumerablePropertyNames(): string[] {
    const result: string[] = [];
    for (const [key, desc] of this.properties) {
      if (desc.enumerable) result.push(key);
    }
    return result;
  }

  getTransitionPath(): string[] {
    const path: string[] = [];
    let current: HiddenClass = this;
    while (current.parent) {
      path.push(current.transitionKey!);
      current = current.parent;
    }
    path.reverse();
    return path;
  }

  getTransitionMetadataPath(): TransitionMetadata[] {
    const path: TransitionMetadata[] = [];
    let current: HiddenClass = this;
    while (current.parent) {
      path.push({
        type: current.transitionType,
        key: current.transitionKey,
        fromId: current.parent.id,
        toId: current.id,
      });
      current = current.parent;
    }
    path.reverse();
    return path;
  }

  getBackPointerChain(): HiddenClass[] {
    const chain: HiddenClass[] = [];
    let current: HiddenClass | null = this;
    while (current) {
      chain.push(current);
      current = current.parent;
    }
    chain.reverse();
    return chain;
  }

  getRoot(): HiddenClass {
    let current: HiddenClass = this;
    while (current.parent) {
      current = current.parent;
    }
    return current;
  }

  collectTransitionTree(depth?: number): string {
    const maxDepth = depth !== undefined ? depth : 100;
    const lines: string[] = [];
    this._buildTreeLines(lines, "", true, 0, maxDepth);
    return lines.join("\n");
  }

  _buildTreeLines(
    lines: string[],
    prefix: string,
    isLast: boolean,
    currentDepth: number,
    maxDepth: number,
  ): void {
    const connector = currentDepth === 0 ? "" : isLast ? "└── " : "├── ";
    const label = this.transitionKey
      ? `${this.transitionType}:"${this.transitionKey}" → HC${this.id}[${this.propertyCount} props, ${this.objectCount} objs]`
      : `HC${this.id}[root, ${this.propertyCount} props, ${this.objectCount} objs]`;

    lines.push(`${prefix}${connector}${label}`);

    if (currentDepth >= maxDepth) return;

    const children: HiddenClass[] = [];
    for (const [, child] of this.transitions) {
      children.push(child);
    }
    for (const [, child] of this.deleteTransitions) {
      children.push(child);
    }
    for (const [, child] of this.integrityTransitions) {
      children.push(child);
    }
    for (const [, child] of this.reconfigureTransitions) {
      children.push(child);
    }

    const childPrefix =
      currentDepth === 0 ? "" : prefix + (isLast ? "    " : "│   ");
    for (let i = 0; i < children.length; i++) {
      children[i]!._buildTreeLines(
        lines,
        childPrefix,
        i === children.length - 1,
        currentDepth + 1,
        maxDepth,
      );
    }
  }

  toString(): string {
    const props: string[] = [];
    for (const [name, desc] of this.properties) {
      const attrs: string[] = [];
      if (!desc.writable) attrs.push("ro");
      if (!desc.enumerable) attrs.push("noEnum");
      if (!desc.configurable) attrs.push("noCfg");
      if (desc.kind === "accessor") attrs.push("acc");
      const attrStr = attrs.length > 0 ? `(${attrs.join(",")})` : "";
      props.push(`${name}@${desc.offset}${attrStr}`);
    }
    const stability = this.isDeprecated
      ? "DEPRECATED"
      : this.isStable
        ? "stable"
        : "UNSTABLE";
    const integrity =
      this.integrityLevel !== INTEGRITY_NONE ? `,${this.integrityLevel}` : "";
    const migration = this.migrationTarget
      ? `,→HC${this.migrationTarget.id}`
      : "";
    return `HC${this.id}{${props.join(", ")}|${stability}${integrity}${migration}|objs:${this.objectCount}}`;
  }

  dump(): string {
    const lines: string[] = [];
    lines.push(`=== HiddenClass HC${this.id} ===`);
    lines.push(`  Stable: ${this.isStable}`);
    lines.push(`  Deprecated: ${this.isDeprecated}`);
    if (this.migrationTarget) {
      lines.push(`  Migration target: HC${this.migrationTarget.id}`);
    }
    lines.push(`  Integrity: ${this.integrityLevel}`);
    lines.push(`  Object count: ${this.objectCount}`);
    lines.push(`  Total transitions fired: ${this.totalTransitionCount}`);
    lines.push(`  Property count: ${this.propertyCount}`);
    lines.push(`  Properties:`);
    for (const [name, desc] of this.properties) {
      lines.push(
        `    ${name}: offset=${desc.offset}, kind=${desc.kind}, writable=${desc.writable}, enumerable=${desc.enumerable}, configurable=${desc.configurable}`,
      );
    }
    lines.push(
      `  Add transitions: [${[...this.transitions.keys()].join(", ")}]`,
    );
    lines.push(
      `  Delete transitions: [${[...this.deleteTransitions.keys()].join(", ")}]`,
    );
    lines.push(
      `  Integrity transitions: [${[...this.integrityTransitions.keys()].join(", ")}]`,
    );
    lines.push(
      `  Reconfigure transitions: [${[...this.reconfigureTransitions.keys()].join(", ")}]`,
    );
    if (this.parent) {
      lines.push(`  Parent: HC${this.parent.id}`);
      lines.push(
        `  Transition: ${this.transitionType} "${this.transitionKey}"`,
      );
    } else {
      lines.push(`  Parent: none (root)`);
    }
    lines.push(
      `  Back pointer chain: ${this.getBackPointerChain()
        .map((hc) => `HC${hc.id}`)
        .join(" -> ")}`,
    );
    lines.push(`  Transition tree:`);
    const root = this.getRoot();
    lines.push(root.collectTransitionTree(5));
    return lines.join("\n");
  }

  getStatistics(): HiddenClassStatistics {
    return {
      id: this.id,
      propertyCount: this.propertyCount,
      version: this.version,
      descriptorVersion: this.descriptorVersion,
      prototypeValidityVersion: this.prototypeValidityCell.version,
      objectCount: this.objectCount,
      isStable: this.isStable,
      isDeprecated: this.isDeprecated,
      migrationTargetId: this.migrationTarget ? this.migrationTarget.id : null,
      integrityLevel: this.integrityLevel,
      totalTransitionCount: this.totalTransitionCount,
      addTransitionCount: this.transitions.size,
      deleteTransitionCount: this.deleteTransitions.size,
      integrityTransitionCount: this.integrityTransitions.size,
      reconfigureTransitionCount: this.reconfigureTransitions.size,
    };
  }
}

export const ROOT_HIDDEN_CLASS = new HiddenClass(null, null, null, 0);

export const INSTANCE_TYPE_OBJECT = "JS_OBJECT";
export const INSTANCE_TYPE_MAP = "JS_MAP";
export const INSTANCE_TYPE_SET = "JS_SET";
export const INSTANCE_TYPE_WEAKMAP = "JS_WEAKMAP";
export const INSTANCE_TYPE_STRING_WRAPPER = "JS_STRING_WRAPPER";
export const INSTANCE_TYPE_NUMBER_WRAPPER = "JS_NUMBER_WRAPPER";
export const INSTANCE_TYPE_BOOLEAN_WRAPPER = "JS_BOOLEAN_WRAPPER";

const initialMapCache = new Map<string, HiddenClass>();

export function getInitialMap(instanceType: string): HiddenClass {
  if (initialMapCache.has(instanceType)) return initialMapCache.get(instanceType)!;
  const hc = new HiddenClass(ROOT_HIDDEN_CLASS, null, null, 0);
  hc.instanceType = instanceType;
  ROOT_HIDDEN_CLASS.transitions.set(`@@${instanceType}`, hc);
  initialMapCache.set(instanceType, hc);
  return hc;
}

export function resetHiddenClasses(): void {
  nextHiddenClassId = 1;
  ROOT_HIDDEN_CLASS.id = 0;
  ROOT_HIDDEN_CLASS.transitions.clear();
  ROOT_HIDDEN_CLASS.deleteTransitions.clear();
  ROOT_HIDDEN_CLASS.integrityTransitions.clear();
  ROOT_HIDDEN_CLASS.reconfigureTransitions.clear();
  ROOT_HIDDEN_CLASS.isStable = true;
  ROOT_HIDDEN_CLASS.isDeprecated = false;
  ROOT_HIDDEN_CLASS.migrationTarget = null;
  ROOT_HIDDEN_CLASS.deprecationCount = 0;
  ROOT_HIDDEN_CLASS.version = 0;
  ROOT_HIDDEN_CLASS.prototypeValidityCell = { version: 0 };
  ROOT_HIDDEN_CLASS._descMap = new Map();
  ROOT_HIDDEN_CLASS._sharedExtended = false;
  ROOT_HIDDEN_CLASS.descriptorVersion = 0;
  ROOT_HIDDEN_CLASS.propertyCount = 0;
  ROOT_HIDDEN_CLASS.integrityLevel = INTEGRITY_NONE;
  ROOT_HIDDEN_CLASS.objectCount = 0;
  ROOT_HIDDEN_CLASS.totalTransitionCount = 0;
  allHiddenClasses.clear();
  allHiddenClasses.set(0, ROOT_HIDDEN_CLASS);
  deprecatedMaps.clear();
  migrationTargetCache.clear();
  initialMapCache.clear();
}

export function getHiddenClassById(id: number): HiddenClass | null {
  return allHiddenClasses.get(id) || null;
}

export function isMapDeprecated(hiddenClassId: number): boolean {
  return deprecatedMaps.has(hiddenClassId);
}

export function getMigrationTarget(hiddenClassId: number): HiddenClass | null {
  return deprecatedMaps.get(hiddenClassId) || null;
}

export function getDeprecatedMapCount(): number {
  return deprecatedMaps.size;
}

export {
  TRANSITION_ADD,
  TRANSITION_DELETE,
  TRANSITION_RECONFIGURE,
  TRANSITION_INTEGRITY,
  INTEGRITY_NONE,
  INTEGRITY_PREVENTEXTENSIONS,
  INTEGRITY_SEALED,
  INTEGRITY_FROZEN,
  MAX_TRANSITIONS_BEFORE_UNSTABLE,
  MAX_DEPRECATIONS_BEFORE_FREEZE,
};
