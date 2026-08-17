import {
  mkArray,
  mkBool,
  mkIterator,
  mkObject,
  mkSmi,
  mkString,
  mkUndefined,
  isArray,
  isString,
  isObject,
  isIterator,
  isFunction,
  isGenerator,
  isUndefined,
  getPayload,
  toBool,
  getWellKnownSymbols,
} from "../../core/value/index.js";
import type { GeneratorPayload, TaggedValue } from "../../core/value/index.js";
import { createJSObject, createJSArray } from "../../objects/heap/factory.js";

type RuntimeObject = {
  prototype?: RuntimeObject | null;
  getLength?(): number;
  getIndex?(index: number): TaggedValue | undefined;
  getProperty(name: string): TaggedValue | undefined;
  getSymbolProperty(symbolValue: TaggedValue): TaggedValue | undefined;
  setProperty(name: string, value: TaggedValue): void;
};

type IteratorInterpreter = {
  callFunctionValue(fn: TaggedValue, args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
  generatorNext(gen: GeneratorPayload, value: TaggedValue): TaggedValue;
};

function getPropertyInChain(obj: RuntimeObject, name: string): TaggedValue | undefined {
  let current: RuntimeObject | null | undefined = obj;
  while (current) {
    const value = current.getProperty(name);
    if (value !== undefined && !isUndefined(value)) return value;
    current = current.prototype;
  }
  return undefined;
}

export class IteratorRecord {
  source: TaggedValue;
  next: (interpreter: IteratorInterpreter | null) => TaggedValue;

  constructor(
    source: TaggedValue,
    next: (interpreter: IteratorInterpreter | null) => TaggedValue,
  ) {
    this.source = source;
    this.next = next;
  }

  nextValue(interpreter: IteratorInterpreter | null): TaggedValue {
    return this.next(interpreter);
  }
}

export function createIteratorResult(value: TaggedValue, done: boolean): TaggedValue {
  const obj = createJSObject();
  obj.setProperty("value", value);
  obj.setProperty("done", mkBool(done));
  return mkObject(obj);
}

export function wrapValueIterator(
  source: TaggedValue,
  iter: Iterator<TaggedValue>,
): TaggedValue {
  return mkIterator(
    new IteratorRecord(source, () => {
      const next = iter.next();
      if (next.done) return createIteratorResult(mkUndefined(), true);
      return createIteratorResult(next.value!, false);
    }),
  );
}

export function wrapEntryIterator(
  source: TaggedValue,
  iter: Iterator<[TaggedValue, TaggedValue]>,
): TaggedValue {
  return mkIterator(
    new IteratorRecord(source, () => {
      const next = iter.next();
      if (next.done) return createIteratorResult(mkUndefined(), true);
      const value = next.value!;
      return createIteratorResult(
        mkArray(createJSArray([value[0], value[1]])),
        false,
      );
    }),
  );
}

export function getIterator(
  value: TaggedValue,
  interpreter: IteratorInterpreter,
): TaggedValue {
  if (isIterator(value)) return value;

  if (isGenerator(value)) {
    const gen = getPayload(value);
    return mkIterator(
      new IteratorRecord(value, (interp) => {
        return interp!.generatorNext(gen, mkUndefined());
      }),
    );
  }

  if (isArray(value)) {
    let index = 0;
    const arr = getPayload(value) as Required<Pick<RuntimeObject, "getLength" | "getIndex">>;
    return mkIterator(
      new IteratorRecord(value, () => {
        if (index >= arr.getLength())
          return createIteratorResult(mkUndefined(), true);
        const item = arr.getIndex(index++);
        return createIteratorResult(
          item !== undefined ? item : mkUndefined(),
          false,
        );
      }),
    );
  }

  if (isString(value)) {
    let index = 0;
    const str = getPayload(value) as string;
    return mkIterator(
      new IteratorRecord(value, () => {
        if (index >= str.length)
          return createIteratorResult(mkUndefined(), true);
        const cp = str.codePointAt(index);
        const ch = String.fromCodePoint(cp!);
        index += ch.length;
        return createIteratorResult(mkString(ch), false);
      }),
    );
  }

  if (isObject(value)) {
    const obj = getPayload(value) as RuntimeObject;
    let method: TaggedValue | undefined;
    const wellKnownSymbols = getWellKnownSymbols();
    if (wellKnownSymbols.iterator) {
      method = obj.getSymbolProperty(wellKnownSymbols.iterator);
      if ((!method || isUndefined(method)) && obj.prototype) {
        let proto: RuntimeObject | null | undefined = obj.prototype;
        while (proto && (!method || isUndefined(method))) {
          method = proto.getSymbolProperty(wellKnownSymbols.iterator);
          proto = proto.prototype;
        }
      }
    }
    if (!method || isUndefined(method)) {
      method = getPropertyInChain(obj, "@@iterator");
    }
    if (isFunction(method)) {
      const iteratorMethod = method as TaggedValue;
      const iter = interpreter.callFunctionValue(iteratorMethod, [], value);
      if (isIterator(iter)) return iter;
      if (isObject(iter)) {
        const nextMethod = getPropertyInChain(getPayload(iter) as RuntimeObject, "next");
        if (isFunction(nextMethod)) {
          const callableNext = nextMethod as TaggedValue;
          return mkIterator(
            new IteratorRecord(iter, (i) =>
              i!.callFunctionValue(callableNext, [], iter),
            ),
          );
        }
      }
    }
  }

  throw new Error("TypeError: value is not iterable");
}

export function iteratorDone(result: TaggedValue): boolean {
  if (!isObject(result)) return true;
  const done = getPayload(result).getProperty("done");
  return done ? toBool(done) : false;
}

export function iteratorValue(result: TaggedValue): TaggedValue {
  if (!isObject(result)) return mkUndefined();
  const value = getPayload(result).getProperty("value");
  return value !== undefined ? value : mkUndefined();
}
