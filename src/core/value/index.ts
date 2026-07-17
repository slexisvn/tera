import type { RegisterFrame } from "../../bytecode/register/interpreter/frame.js";
import type { RegisterCompiledFunction } from "../../bytecode/register/ops/bytecode.js";
import type { JSArray } from "../../objects/heap/js-array.js";
import type { JSObject } from "../../objects/heap/js-object.js";
import type { JSProxy } from "../../objects/exotic/js-proxy.js";
import type { Environment } from "../../runtime/intrinsics/environment.js";

export const TAG_SMI = "smi";
export const TAG_DOUBLE = "double";
export const TAG_BOOL = "bool";
export const TAG_STRING = "string";
export const TAG_OBJECT = "object";
export const TAG_FUNCTION = "function";
export const TAG_ARRAY = "array";
export const TAG_PROMISE = "promise";
export const TAG_ITERATOR = "iterator";
export const TAG_GENERATOR = "generator";
export const TAG_REGEX = "regex";
export const TAG_SYMBOL = "symbol";
export const TAG_UNDEFINED = "undefined";
export const TAG_NULL = "null";

export const SMI_MAX = 0x3fffffff;
export const SMI_MIN = -0x40000000;
export const TAG_BITS = 4;
export const TAG_MASK = 0xf;

export const CODE_SMI = 0;
export const CODE_FALSE = 1;
export const CODE_TRUE = 2;
export const CODE_UNDEFINED = 3;
export const CODE_NULL = 4;
export const CODE_DOUBLE = 5;
export const CODE_STRING = 6;
export const CODE_OBJECT = 7;
export const CODE_FUNCTION = 8;
export const CODE_ARRAY = 9;
export const CODE_PROMISE = 10;
export const CODE_ITERATOR = 11;
export const CODE_GENERATOR = 12;
export const CODE_REGEX = 13;
export const CODE_SYMBOL = 14;
export const CODE_MAX = CODE_SYMBOL;

export type ValueTag =
  | typeof TAG_SMI
  | typeof TAG_DOUBLE
  | typeof TAG_BOOL
  | typeof TAG_STRING
  | typeof TAG_OBJECT
  | typeof TAG_FUNCTION
  | typeof TAG_ARRAY
  | typeof TAG_PROMISE
  | typeof TAG_ITERATOR
  | typeof TAG_GENERATOR
  | typeof TAG_REGEX
  | typeof TAG_SYMBOL
  | typeof TAG_UNDEFINED
  | typeof TAG_NULL;

type TaggedValueBrand<Tag extends ValueTag> = number & {
  readonly __taggedValueBrand?: Tag;
};

export type SmiValue = TaggedValueBrand<typeof TAG_SMI>;
export type DoubleValue = TaggedValueBrand<typeof TAG_DOUBLE>;
export type BoolValue = TaggedValueBrand<typeof TAG_BOOL>;
export type StringValue = TaggedValueBrand<typeof TAG_STRING>;
export type ObjectValue = TaggedValueBrand<typeof TAG_OBJECT>;
export type FunctionValue = TaggedValueBrand<typeof TAG_FUNCTION>;
export type ArrayValue = TaggedValueBrand<typeof TAG_ARRAY>;
export type PromiseValue = TaggedValueBrand<typeof TAG_PROMISE>;
export type IteratorValue = TaggedValueBrand<typeof TAG_ITERATOR>;
export type GeneratorValue = TaggedValueBrand<typeof TAG_GENERATOR>;
export type RegexValue = TaggedValueBrand<typeof TAG_REGEX>;
export type SymbolValue = TaggedValueBrand<typeof TAG_SYMBOL>;
export type UndefinedValue = TaggedValueBrand<typeof TAG_UNDEFINED>;
export type NullValue = TaggedValueBrand<typeof TAG_NULL>;

export type TaggedValue =
  | SmiValue
  | DoubleValue
  | BoolValue
  | StringValue
  | ObjectValue
  | FunctionValue
  | ArrayValue
  | PromiseValue
  | IteratorValue
  | GeneratorValue
  | RegexValue
  | SymbolValue
  | UndefinedValue
  | NullValue;

export type HeapPrimitivePayload =
  | number
  | string
  | boolean
  | symbol
  | null
  | undefined;

export type HeapPayload =
  | HeapPrimitivePayload
  | JSObject
  | JSProxy
  | JSArray
  | RuntimeFunctionPayload
  | PromisePayload
  | IteratorPayload
  | GeneratorPayload
  | JSSymbol
  | RegExpPayload
  | HeapPayload[];

export type RegExpPayload = {
  nativeRegex: RegExp;
  lastIndex: number;
};

type RuntimeNativeCall = {
  bivarianceHack(
    args: TaggedValue[],
    thisValue?: TaggedValue,
    interpreter?: object,
  ): TaggedValue;
}["bivarianceHack"];

type RuntimeNativeConstruct = {
  bivarianceHack(args: TaggedValue[], interpreter?: object): TaggedValue;
}["bivarianceHack"];

export type RuntimeFunctionParameterMetadata = {
  name: string;
  type?: string;
  optional?: boolean;
  defaultValue?: unknown;
  rest?: boolean;
  named?: boolean;
};

export type RuntimeFunctionMetadata = {
  name: string;
  params?: RuntimeFunctionParameterMetadata[];
  returns?: string;
  effect?: "sync" | "async" | "io";
  callConvention?: "positional" | "named" | "positional_named" | "namespace";
};

export type RuntimeFunctionPayload = {
  __heapId?: number;
  name?: string;
  metadata?: RuntimeFunctionMetadata;
  paramCount?: number;
  isStrict?: boolean;
  isErrorConstructor?: boolean;
  slackCounter?: number;
  slackExpectedProperties?: number;
  slackTrackingComplete?: boolean;
  compiled?: RegisterCompiledFunction | null;
  closure?: Environment | null;
  properties?: Record<string, TaggedValue>;
  prototypeObj?: JSObject | null;
  constructorOf?: RuntimeFunctionPayload | null;
  call?: RuntimeNativeCall;
  construct?: RuntimeNativeConstruct;
  toString?: () => string;
};

export type PromisePayload = {
  __heapId?: number;
  state: string;
  result: TaggedValue;
  reactions: Array<(state: string, value: TaggedValue) => void>;
  fulfill(value: TaggedValue): void;
  reject(reason: TaggedValue): void;
  addReaction(reaction: (state: string, result: TaggedValue) => void): void;
  then?: (onFulfilled?: TaggedValue, onRejected?: TaggedValue) => TaggedValue;
};

export type IteratorPayload = {
  __heapId?: number;
  next(interpreter?: object | null): TaggedValue;
  nextValue(interpreter?: object | null): TaggedValue;
  [Symbol.iterator]?: () => IteratorPayload;
};

export type GeneratorPayload = {
  __heapId?: number;
  frame: RegisterFrame;
  state: string;
  next?: (value?: TaggedValue) => TaggedValue;
  throw?: (value?: TaggedValue) => TaggedValue;
  return?: (value?: TaggedValue) => TaggedValue;
};

const CODE_TO_TAG: ValueTag[] = [
  TAG_SMI,
  TAG_BOOL,
  TAG_BOOL,
  TAG_UNDEFINED,
  TAG_NULL,
  TAG_DOUBLE,
  TAG_STRING,
  TAG_OBJECT,
  TAG_FUNCTION,
  TAG_ARRAY,
  TAG_PROMISE,
  TAG_ITERATOR,
  TAG_GENERATOR,
  TAG_REGEX,
  TAG_SYMBOL,
];

const TAG_TO_CODE: Map<ValueTag, number> = new Map([
  [TAG_DOUBLE, CODE_DOUBLE],
  [TAG_STRING, CODE_STRING],
  [TAG_OBJECT, CODE_OBJECT],
  [TAG_FUNCTION, CODE_FUNCTION],
  [TAG_ARRAY, CODE_ARRAY],
  [TAG_PROMISE, CODE_PROMISE],
  [TAG_ITERATOR, CODE_ITERATOR],
  [TAG_GENERATOR, CODE_GENERATOR],
  [TAG_REGEX, CODE_REGEX],
  [TAG_SYMBOL, CODE_SYMBOL],
]);

const heapPayloads: Array<HeapPayload | null> = [null];
const heapFreeList: number[] = [];
const pinnedHeapIds = new Set<number>();

type HeapIdentifiedPayload = Extract<HeapPayload, object> & {
  __heapId?: number;
};

function hasHeapIdentity(payload: HeapPayload): payload is HeapIdentifiedPayload {
  return payload !== null && typeof payload === "object";
}

export function codeOf(v: RuntimeValue | HeapPayload): number {
  if (typeof v !== "number") return CODE_UNDEFINED;
  return v & TAG_MASK;
}

function heapId(v: number): number {
  return (v - (v & TAG_MASK)) * TAG_SHIFT_DIV;
}

function heapValue(tag: ValueTag, payload: HeapPayload): TaggedValue {
  const code = TAG_TO_CODE.get(tag);
  if (code === undefined) return CODE_UNDEFINED;
  const taggable = hasHeapIdentity(payload);
  if (
    taggable &&
    payload.__heapId !== undefined &&
    heapPayloads[payload.__heapId] === payload
  ) {
    return payload.__heapId * TAG_SHIFT_MULT + code;
  }
  let id: number;
  if (heapFreeList.length > 0) {
    id = heapFreeList.pop()!;
    heapPayloads[id] = payload;
  } else {
    id = heapPayloads.length;
    heapPayloads.push(payload);
  }
  if (taggable) payload.__heapId = id;
  return id * TAG_SHIFT_MULT + code;
}

export function freeHeapObjectSlot(obj: HeapPayload): boolean {
  if (!obj || typeof obj !== "object") return false;
  const payload = obj as HeapIdentifiedPayload;
  const id = payload.__heapId;
  if (id === undefined || id <= 0) return false;
  if (heapPayloads[id] !== obj) return false;
  if (pinnedHeapIds.has(id)) return false;
  heapPayloads[id] = null;
  heapFreeList.push(id);
  payload.__heapId = undefined;
  return true;
}

const TAG_SHIFT_MULT = 1 << TAG_BITS;

export function mkSmi(n: number): SmiValue {
  return ((n | 0) * TAG_SHIFT_MULT) as SmiValue;
}

export function mkDouble(n: number): DoubleValue {
  return heapValue(TAG_DOUBLE, +n) as DoubleValue;
}

export function mkBool(b: boolean): BoolValue {
  return (b ? CODE_TRUE : CODE_FALSE) as BoolValue;
}

export function mkString(s: string | number | boolean | symbol | null | undefined): StringValue {
  return heapValue(TAG_STRING, String(s)) as StringValue;
}

export function mkObject(obj: JSObject | JSProxy): ObjectValue {
  return heapValue(TAG_OBJECT, obj) as ObjectValue;
}

export function mkFunction(fn: RuntimeFunctionPayload): FunctionValue {
  return heapValue(TAG_FUNCTION, fn) as FunctionValue;
}

export function mkArray(arr: JSArray): ArrayValue {
  return heapValue(TAG_ARRAY, arr) as ArrayValue;
}

export function mkPromise(promise: PromisePayload): PromiseValue {
  return heapValue(TAG_PROMISE, promise) as PromiseValue;
}

export function mkIterator(iterator: IteratorPayload): IteratorValue {
  return heapValue(TAG_ITERATOR, iterator) as IteratorValue;
}

export function mkGenerator(gen: GeneratorPayload): GeneratorValue {
  return heapValue(TAG_GENERATOR, gen) as GeneratorValue;
}

export function mkRegex(nativeRegex: RegExp): RegexValue {
  return heapValue(TAG_REGEX, { nativeRegex, lastIndex: 0 }) as RegexValue;
}

export function mkSymbol(sym: symbol | JSSymbol): SymbolValue {
  return heapValue(TAG_SYMBOL, sym) as SymbolValue;
}

export function mkUndefined(): UndefinedValue {
  return CODE_UNDEFINED as UndefinedValue;
}

export function mkNull(): NullValue {
  return CODE_NULL as NullValue;
}

export function mkNumber(n: number): TaggedValue {
  if (n === 0 && (1 / n) === -Infinity) return mkDouble(n);
  if (Number.isInteger(n) && n >= SMI_MIN && n <= SMI_MAX) {
    return mkSmi(n);
  }
  return mkDouble(n);
}

export function getTag(v: RuntimeValue | HeapPayload): ValueTag {
  return CODE_TO_TAG[codeOf(v)] || TAG_UNDEFINED;
}

const TAG_SHIFT_DIV = 1 / TAG_SHIFT_MULT;

export function smiPayload(v: number): number {
  return v * TAG_SHIFT_DIV;
}

export function getPayload(v: SmiValue | DoubleValue): number;
export function getPayload(v: BoolValue): boolean;
export function getPayload(v: StringValue): string;
export function getPayload(v: ObjectValue): JSObject;
export function getPayload(v: FunctionValue): RuntimeFunctionPayload;
export function getPayload(v: ArrayValue): JSArray;
export function getPayload(v: PromiseValue): PromisePayload;
export function getPayload(v: IteratorValue): IteratorPayload;
export function getPayload(v: GeneratorValue): GeneratorPayload;
export function getPayload(v: RegexValue): RegExpPayload;
export function getPayload(v: SymbolValue): symbol | JSSymbol;
export function getPayload(v: UndefinedValue): undefined;
export function getPayload(v: NullValue): null;
export function getPayload(v: TaggedValue): HeapPayload;
export function getPayload(v: number): HeapPayload {
  const code = v & TAG_MASK;
  switch (code) {
    case CODE_SMI:
      return v * TAG_SHIFT_DIV;
    case CODE_FALSE:
      return false;
    case CODE_TRUE:
      return true;
    case CODE_NULL:
      return null;
    case CODE_UNDEFINED:
      return undefined;
    case CODE_DOUBLE:
    case CODE_STRING:
    case CODE_OBJECT:
    case CODE_FUNCTION:
    case CODE_ARRAY:
    case CODE_PROMISE:
    case CODE_ITERATOR:
    case CODE_GENERATOR:
    case CODE_REGEX:
    case CODE_SYMBOL:
      return heapPayloads[(v - code) * TAG_SHIFT_DIV] ?? undefined;
    default:
      return undefined;
  }
}

export function isTaggedValue(v: RuntimeValue | HeapPayload): v is TaggedValue {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const code = v & TAG_MASK;
  if (code === CODE_SMI) return Number.isInteger(v * TAG_SHIFT_DIV);
  if (
    code === CODE_FALSE ||
    code === CODE_TRUE ||
    code === CODE_UNDEFINED ||
    code === CODE_NULL
  )
    return v === code;
  const id = (v - code) * TAG_SHIFT_DIV;
  return id > 0 && id < heapPayloads.length && heapPayloads[id] !== undefined;
}

export function isSmi(v: RuntimeValue | HeapPayload): v is SmiValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_SMI;
}
export function isDouble(v: RuntimeValue | HeapPayload): v is DoubleValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_DOUBLE;
}
export function isNumber(v: RuntimeValue | HeapPayload): v is SmiValue | DoubleValue {
  if (typeof v !== "number") return false;
  const code = v & TAG_MASK;
  return code === CODE_SMI || code === CODE_DOUBLE;
}
export function isBool(v: RuntimeValue | HeapPayload): v is BoolValue {
  return v === CODE_TRUE || v === CODE_FALSE;
}
export function isString(v: RuntimeValue | HeapPayload): v is StringValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_STRING;
}
export function isObject(v: RuntimeValue | HeapPayload): v is ObjectValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_OBJECT;
}
export function isFunction(v: RuntimeValue | HeapPayload): v is FunctionValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_FUNCTION;
}
export function isArray(v: RuntimeValue | HeapPayload): v is ArrayValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_ARRAY;
}
export function isPromise(v: RuntimeValue | HeapPayload): v is PromiseValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_PROMISE;
}
export function isIterator(v: RuntimeValue | HeapPayload): v is IteratorValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_ITERATOR;
}
export function isGenerator(v: RuntimeValue | HeapPayload): v is GeneratorValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_GENERATOR;
}
export function isRegex(v: RuntimeValue | HeapPayload): v is RegexValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_REGEX;
}
export function isSymbol(v: RuntimeValue | HeapPayload): v is SymbolValue {
  return typeof v === "number" && (v & TAG_MASK) === CODE_SYMBOL;
}
export function isUndefined(v: RuntimeValue | HeapPayload): v is UndefinedValue {
  return v === CODE_UNDEFINED;
}
export function isNull(v: RuntimeValue | HeapPayload): v is NullValue {
  return v === CODE_NULL;
}
export function isNullish(v: RuntimeValue | HeapPayload): boolean {
  return v === CODE_NULL || v === CODE_UNDEFINED;
}
export function areBothSmi(a: RuntimeValue | HeapPayload, b: RuntimeValue | HeapPayload): boolean {
  return typeof a === "number" && typeof b === "number" && ((a | b) & TAG_MASK) === 0;
}
export function areBothNumber(a: RuntimeValue | HeapPayload, b: RuntimeValue | HeapPayload): boolean {
  if (typeof a !== "number" || typeof b !== "number") return false;
  const ac = a & TAG_MASK;
  const bc = b & TAG_MASK;
  return (ac === CODE_SMI || ac === CODE_DOUBLE) && (bc === CODE_SMI || bc === CODE_DOUBLE);
}

export function toPrimitive(v: TaggedValue, hint = "default"): TaggedValue {
  const obj = isObject(v) || isArray(v) ? getPayload(v) : null;
  if (obj === null || obj === undefined) return v;
  if (isObject(v)) {
    const objectPayload = getPayload(v);
    if (objectPayload._primitiveValue !== undefined) return objectPayload._primitiveValue;
  }

  if (hint === "number" || hint === "default") {
    if (isObject(v) && typeof getPayload(v).getProperty === "function") {
      const objectPayload = getPayload(v);
      const valueOfResult = objectPayload.getProperty("valueOf");
      if (
        valueOfResult !== undefined &&
        codeOf(valueOfResult) !== CODE_UNDEFINED
      ) {
        return valueOfResult;
      }
    }
    return mkString(isArray(v) ? toString(v) : "[object Object]");
  }

  return mkString(isArray(v) ? toString(v) : "[object Object]");
}

export function toNumber(v: TaggedValue): number {
  if (isNumber(v)) return getPayload(v);
  if (v === CODE_FALSE) return 0;
  if (v === CODE_TRUE) return 1;
  if (isString(v)) {
    const s = getPayload(v);
    return s === "" ? 0 : Number(s);
  }
  if (isNull(v)) return 0;
  if (isObject(v) || isArray(v)) {
    const prim = toPrimitive(v, "number");
    if (prim !== v) return toNumber(prim);
  }
  return NaN;
}

export function toBool(v: TaggedValue): boolean {
  if (isUndefined(v) || isNull(v) || v === CODE_FALSE) return false;
  if (v === CODE_TRUE) return true;
  if (isSmi(v)) return getPayload(v) !== 0;
  if (isDouble(v)) {
    const n = getPayload(v);
    return n !== 0 && !Number.isNaN(n);
  }
  if (isString(v)) return getPayload(v).length > 0;
  return true;
}

export function toString(v: TaggedValue, seen?: Set<HeapPayload>): string {
  switch (codeOf(v)) {
    case CODE_SMI:
      return String(getPayload(v as SmiValue));
    case CODE_DOUBLE:
      return String(getPayload(v as DoubleValue));
    case CODE_FALSE:
      return "false";
    case CODE_TRUE:
      return "true";
    case CODE_STRING:
      return getPayload(v as StringValue);
    case CODE_NULL:
      return "null";
    case CODE_UNDEFINED:
      return "undefined";
    case CODE_FUNCTION: {
      const fn = getPayload(v as FunctionValue);
      return `[Function: ${fn.name || "anonymous"}]`;
    }
    case CODE_OBJECT: {
      const obj = getPayload(v as ObjectValue);
      if (obj._mapData) return `Map(${obj._mapData.size})`;
      if (obj._setData) return `Set(${obj._setData.size})`;
      if (obj._weakMapData) return `WeakMap`;
      return "[object Object]";
    }
    case CODE_ARRAY: {
      const arr = getPayload(v as ArrayValue);
      const visited = seen || new Set();
      if (visited.has(arr)) return "";
      visited.add(arr);
      const result = arr.elements
        .map((el: TaggedValue | undefined) => {
          if (el === undefined) return "";
          const c = codeOf(el);
          return c === CODE_NULL || c === CODE_UNDEFINED
            ? ""
            : toString(el, visited);
        })
        .join(",");
      visited.delete(arr);
      return result;
    }
    case CODE_PROMISE:
      return `[Promise ${getPayload(v as PromiseValue).state}]`;
    case CODE_ITERATOR:
      return "[Iterator]";
    case CODE_GENERATOR:
      return "[Generator]";
    case CODE_REGEX: {
      const rv = getPayload(v as RegexValue);
      return "/" + rv.nativeRegex.source + "/" + rv.nativeRegex.flags;
    }
    case CODE_SYMBOL: {
      const sym = getPayload(v as SymbolValue);
      return sym.description !== undefined
        ? `Symbol(${sym.description})`
        : "Symbol()";
    }
    default:
      return String(getPayload(v));
  }
}

export function toDisplayString(v: TaggedValue, seen?: Set<HeapPayload>): string {
  if (isArray(v)) {
    const arr = getPayload(v);
    const visited = seen || new Set();
    if (visited.has(arr)) return "[Circular]";
    visited.add(arr);
    const items = arr.elements
      ? arr.elements.map((el: TaggedValue | undefined) =>
          el !== undefined ? toDisplayString(el, visited) : "undefined",
        )
      : [];
    for (const [name, desc] of arr.hiddenClass.properties) {
      const val =
        desc.offset < 10
          ? arr.slots[desc.offset]
          : arr.overflowProperties.get(name);
      items.push(`${name}: ${toDisplayString(val ?? mkUndefined(), visited)}`);
    }
    visited.delete(arr);
    return `[${items.join(", ")}]`;
  }
  if (isString(v)) {
    return getPayload(v);
  }
  if (isObject(v)) {
    const obj = getPayload(v);
    if (obj._mapData) return `Map(${obj._mapData.size})`;
    if (obj._setData) return `Set(${obj._setData.size})`;
    if (obj._weakMapData) return `WeakMap`;
    if (typeof obj.toString === "function") return obj.toString();
  }
  return toString(v);
}

export function typeOf(v: TaggedValue): string {
  switch (codeOf(v)) {
    case CODE_SMI:
    case CODE_DOUBLE:
      return "number";
    case CODE_FALSE:
    case CODE_TRUE:
      return "boolean";
    case CODE_STRING:
      return "string";
    case CODE_FUNCTION:
      return "function";
    case CODE_SYMBOL:
      return "symbol";
    case CODE_OBJECT:
    case CODE_ARRAY:
    case CODE_PROMISE:
    case CODE_ITERATOR:
    case CODE_GENERATOR:
    case CODE_REGEX:
    case CODE_NULL:
      return "object";
    case CODE_UNDEFINED:
      return "undefined";
    default:
      return "unknown";
  }
}

export function abstractLooseEqual(x: TaggedValue, y: TaggedValue): boolean {
  const xc = codeOf(x);
  const yc = codeOf(y);

  
  if (xc === yc) {
    return getPayload(x) === getPayload(y);
  }

  
  const xNull = xc === CODE_NULL || xc === CODE_UNDEFINED;
  const yNull = yc === CODE_NULL || yc === CODE_UNDEFINED;
  if (xNull && yNull) return true;
  if (xNull || yNull) return false;

  
  if (
    (xc === CODE_SMI || xc === CODE_DOUBLE) &&
    (yc === CODE_SMI || yc === CODE_DOUBLE)
  ) {
    return toNumber(x) === toNumber(y);
  }

  
  if ((xc === CODE_SMI || xc === CODE_DOUBLE) && yc === CODE_STRING) {
    return toNumber(x) === toNumber(y);
  }
  if (xc === CODE_STRING && (yc === CODE_SMI || yc === CODE_DOUBLE)) {
    return toNumber(x) === toNumber(y);
  }

  
  if (xc === CODE_TRUE || xc === CODE_FALSE) {
    const xn = xc === CODE_TRUE ? 1 : 0;
    return abstractLooseEqual(mkNumber(xn), y);
  }
  if (yc === CODE_TRUE || yc === CODE_FALSE) {
    const yn = yc === CODE_TRUE ? 1 : 0;
    return abstractLooseEqual(x, mkNumber(yn));
  }

  
  if (
    (xc === CODE_OBJECT || xc === CODE_ARRAY) &&
    (yc === CODE_SMI || yc === CODE_DOUBLE || yc === CODE_STRING)
  ) {
    const xp = toPrimitive(x, "number");
    if (xp !== x) return abstractLooseEqual(xp, y);
    return false;
  }
  if (
    (yc === CODE_OBJECT || yc === CODE_ARRAY) &&
    (xc === CODE_SMI || xc === CODE_DOUBLE || xc === CODE_STRING)
  ) {
    const yp = toPrimitive(y, "number");
    if (yp !== y) return abstractLooseEqual(x, yp);
    return false;
  }

  return false;
}

export function abstractRelational(left: TaggedValue, right: TaggedValue): number {
  const lp = toPrimitive(left, "number");
  const rp = toPrimitive(right, "number");
  if (codeOf(lp) === CODE_STRING && codeOf(rp) === CODE_STRING) {
    const a = getPayload(lp as StringValue);
    const b = getPayload(rp as StringValue);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const a = toNumber(lp);
  const b = toNumber(rp);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function strictEqual(a: TaggedValue, b: TaggedValue): boolean {
  const ac = codeOf(a);
  const bc = codeOf(b);
  if (ac !== bc) return false;
  switch (ac) {
    case CODE_NULL:
    case CODE_UNDEFINED:
      return true;
    default:
      return getPayload(a) === getPayload(b);
  }
}

export function isPrimitive(v: RuntimeValue | HeapPayload): boolean {
  if (typeof v !== "number") return true;
  const code = v & TAG_MASK;
  return code <= CODE_STRING || code === CODE_SYMBOL;
}

export function getHeapId(v: RuntimeValue | HeapPayload): number {
  if (typeof v !== "number") return -1;
  const code = v & TAG_MASK;
  if (code <= CODE_NULL) return -1;
  return (v - code) * TAG_SHIFT_DIV;
}

export function pinHeapSlot(v: TaggedValue): void {
  const id = getHeapId(v);
  if (id > 0) pinnedHeapIds.add(id);
}

export function sweepHeapPayloads(liveIds: Set<number>): number {
  let freed = 0;
  for (let i = 1; i < heapPayloads.length; i++) {
    if (heapPayloads[i] !== null && !pinnedHeapIds.has(i) && !liveIds.has(i)) {
      heapPayloads[i] = null;
      heapFreeList.push(i);
      freed++;
    }
  }
  return freed;
}

export function heapPayloadCount(): number {
  return heapPayloads.length - 1 - heapFreeList.length;
}

export function resetHeapPayloads(): void {
  heapPayloads.length = 1;
  heapPayloads[0] = null;
  heapFreeList.length = 0;
  pinnedHeapIds.clear();
}




export function heapPayloadLiveBytesEstimate(): number {
  return heapPayloads.length - heapFreeList.length;
}

const globalSymbolRegistry = new Map<string, TaggedValue>();
const globalSymbolReverseRegistry = new Map<JSSymbol | symbol, string>();
export function symbolFor(key: string): TaggedValue {
  if (globalSymbolRegistry.has(key)) return globalSymbolRegistry.get(key)!;
  const tagged = mkSymbol(new JSSymbol(key));
  globalSymbolRegistry.set(key, tagged);
  globalSymbolReverseRegistry.set(getPayload(tagged), key);
  return tagged;
}
export function symbolKeyFor(taggedSym: TaggedValue): string | undefined {
  if (!isSymbol(taggedSym)) return undefined;
  return globalSymbolReverseRegistry.get(getPayload(taggedSym));
}

export const wellKnownSymbols: Record<string, TaggedValue> = {};
export function initWellKnownSymbols(): void {
  wellKnownSymbols.iterator = mkSymbol(new JSSymbol("Symbol.iterator"));
  wellKnownSymbols.hasInstance = mkSymbol(new JSSymbol("Symbol.hasInstance"));
  wellKnownSymbols.toPrimitive = mkSymbol(new JSSymbol("Symbol.toPrimitive"));
  wellKnownSymbols.toStringTag = mkSymbol(new JSSymbol("Symbol.toStringTag"));
}

let nextSymbolId = 0;
export class JSSymbol {
  id: number;
  description: string | undefined;

  constructor(description?: string) {
    this.id = nextSymbolId++;
    this.description = description;
  }
  toString(): string {
    return this.description !== undefined
      ? `Symbol(${this.description})`
      : "Symbol()";
  }
}

export class JSFunction {
  compiled: RegisterCompiledFunction | null;
  name: string;
  closure: Environment | null;
  prototype: HeapPayload | null;
  constructorOf: RuntimeFunctionPayload | null;
  prototypeObj: JSObject | null;

  constructor(
    compiledFunction: RegisterCompiledFunction | null,
    name?: string,
    closure?: Environment | null,
  ) {
    this.compiled = compiledFunction;
    this.name =
      name || (compiledFunction ? compiledFunction.name ?? "<anonymous>" : "<anonymous>");
    this.closure = closure || null;
    this.prototype = null;
    this.constructorOf = null;
    this.prototypeObj = null;
  }
}
