import {
  mkUndefined,
  mkBool,
  isFunction,
} from "../../core/value/index.js";
import type { TaggedValue } from "../../core/value/index.js";
import {
  wrapValueIterator,
  wrapEntryIterator,
} from "../iteration/iterator.js";
import { INSTANCE_TYPE_SET } from "../../objects/maps/hidden-class.js";
import { getCollectionData } from "./collection-data.js";
import { argOrUndefined } from "../builtins/index.js";

type SetData = {
  add(value: TaggedValue): void;
  has(value: TaggedValue): boolean;
  delete(value: TaggedValue): boolean;
  clear(): void;
  iterateValues(): IterableIterator<TaggedValue>;
  iterateEntries(): IterableIterator<[TaggedValue, TaggedValue]>;
};

type InterpreterLike = {
  callFunctionValue(fn: TaggedValue, args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
};

type BuiltinMethod = {
  name: string;
  call(args: TaggedValue[], thisValue: TaggedValue, interpreter?: InterpreterLike): TaggedValue;
};

function getSetData(thisValue: TaggedValue): SetData {
  return getCollectionData<SetData>(
    thisValue,
    "_setData",
    INSTANCE_TYPE_SET,
    "Set",
  );
}

export const SET_METHODS = {
  add: {
    name: "Set.prototype.add",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const set = getSetData(thisValue);
      const value = argOrUndefined(args, 0);
      set.add(value);
      return thisValue;
    },
  },

  has: {
    name: "Set.prototype.has",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const set = getSetData(thisValue);
      const value = argOrUndefined(args, 0);
      return mkBool(set.has(value));
    },
  },

  delete: {
    name: "Set.prototype.delete",
    call(args: TaggedValue[], thisValue: TaggedValue) {
      const set = getSetData(thisValue);
      const value = argOrUndefined(args, 0);
      return mkBool(set.delete(value));
    },
  },

  clear: {
    name: "Set.prototype.clear",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      getSetData(thisValue).clear();
      return mkUndefined();
    },
  },

  forEach: {
    name: "Set.prototype.forEach",
    call(args: TaggedValue[], thisValue: TaggedValue, interpreter?: InterpreterLike) {
      const set = getSetData(thisValue);
      const callback = args[0];
      if (!isFunction(callback)) throw new Error("TypeError: callback is not a function");
      for (const value of set.iterateValues()) {
        interpreter!.callFunctionValue(callback as TaggedValue, [value, value, thisValue], mkUndefined());
      }
      return mkUndefined();
    },
  },

  entries: {
    name: "Set.prototype.entries",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const set = getSetData(thisValue);
      return wrapEntryIterator(set.iterateEntries());
    },
  },

  keys: {
    name: "Set.prototype.keys",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const set = getSetData(thisValue);
      return wrapValueIterator(set.iterateValues());
    },
  },

  values: {
    name: "Set.prototype.values",
    call(_args: TaggedValue[], thisValue: TaggedValue) {
      const set = getSetData(thisValue);
      return wrapValueIterator(set.iterateValues());
    },
  },
} as Record<string, BuiltinMethod>;
