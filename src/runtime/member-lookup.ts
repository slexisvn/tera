import {
  codeOf,
  getPayload,
  mkSmi,
  mkString,
  mkUndefined,
  stringCharAt,
  CODE_ARRAY,
  CODE_DOUBLE,
  CODE_FALSE,
  CODE_FUNCTION,
  CODE_GENERATOR,
  CODE_PROMISE,
  CODE_REGEX,
  CODE_SMI,
  CODE_STRING,
  CODE_TRUE,
  type ArrayValue,
  type GeneratorValue,
  type PromiseValue,
  type RegexValue,
  type StringValue,
  type TaggedValue,
} from "../core/value/index.js";
import type { InterpreterLike as ProxyInterpreterLike } from "../objects/exotic/proxy-ops.js";
import type { JSObject } from "../objects/heap/js-object.js";
import { functionMemberValue } from "../objects/exotic/function-members.js";
import { getRegexProperty } from "./intrinsics/regex-methods.js";
import {
  asGeneratorMemberInterpreter,
  generatorMemberValue,
} from "../bytecode/register/interpreter/generator-members.js";
import {
  asPromiseMemberInterpreter,
  promiseMemberValue,
} from "../bytecode/register/interpreter/promise-members.js";

export type BuiltinPrototypeSet = Record<string, JSObject>;

export type BuiltinPrototypeName =
  | "arrayPrototype"
  | "stringPrototype"
  | "regexPrototype"
  | "numberPrototype"
  | "booleanPrototype";

export type MemberLookupInterpreter = ProxyInterpreterLike & {
  builtinPrototypes?: BuiltinPrototypeSet;
  _lookupBuiltinPrototype(proto: JSObject, propName: string): TaggedValue;
};

type MemberLookup = (
  receiver: TaggedValue,
  propName: string,
  interpreter: MemberLookupInterpreter | null,
) => TaggedValue | null;

function builtinPrototypeMember(
  interpreter: MemberLookupInterpreter | null,
  prototype: BuiltinPrototypeName,
  propName: string,
): TaggedValue | null {
  if (!interpreter || !interpreter.builtinPrototypes) return null;
  return interpreter._lookupBuiltinPrototype(
    interpreter.builtinPrototypes[prototype],
    propName,
  );
}

function elementIndex(propName: string): number | null {
  const index = Number(propName);
  return Number.isInteger(index) ? index : null;
}

const arrayMember: MemberLookup = (receiver, propName, interpreter) => {
  const array = getPayload(receiver as ArrayValue);
  if (propName === "length") return mkSmi(array.getLength());
  const index = elementIndex(propName);
  if (index !== null) {
    const element = array.getIndex(index);
    return element !== undefined ? element : mkUndefined();
  }
  const own = array.getProperty(propName);
  if (own !== undefined) return own;
  return builtinPrototypeMember(interpreter, "arrayPrototype", propName);
};

const stringMember: MemberLookup = (receiver, propName, interpreter) => {
  const text = getPayload(receiver as StringValue);
  if (propName === "length") return mkSmi(text.length);
  const index = elementIndex(propName);
  if (index !== null) {
    const character = stringCharAt(text, index);
    return character !== undefined ? mkString(character) : mkUndefined();
  }
  return builtinPrototypeMember(interpreter, "stringPrototype", propName);
};

const regexMember: MemberLookup = (receiver, propName, interpreter) => {
  const own = getRegexProperty(propName, getPayload(receiver as RegexValue));
  if (own !== null) return own;
  return builtinPrototypeMember(interpreter, "regexPrototype", propName);
};

const generatorMember: MemberLookup = (receiver, propName, interpreter) => {
  const resuming = asGeneratorMemberInterpreter(interpreter);
  return resuming === null
    ? mkUndefined()
    : generatorMemberValue(resuming, receiver as GeneratorValue, propName);
};

const promiseMember: MemberLookup = (receiver, propName, interpreter) => {
  const settling = asPromiseMemberInterpreter(interpreter);
  return settling === null
    ? mkUndefined()
    : promiseMemberValue(settling, receiver as PromiseValue, propName);
};

const functionMember: MemberLookup = (receiver, propName, interpreter) => {
  const member = functionMemberValue(receiver, propName, interpreter ?? undefined);
  return member !== null ? member : mkUndefined();
};

const numberMember: MemberLookup = (_receiver, propName, interpreter) =>
  builtinPrototypeMember(interpreter, "numberPrototype", propName);

const booleanMember: MemberLookup = (_receiver, propName, interpreter) =>
  builtinPrototypeMember(interpreter, "booleanPrototype", propName);

function lookupTable(
  entries: ReadonlyArray<readonly [number, MemberLookup]>,
): ReadonlyArray<MemberLookup | undefined> {
  const widest = entries.reduce((code, entry) => Math.max(code, entry[0]), 0);
  const table = new Array<MemberLookup | undefined>(widest + 1).fill(undefined);
  for (const [code, lookup] of entries) table[code] = lookup;
  return table;
}

const MEMBER_LOOKUPS = lookupTable([
  [CODE_ARRAY, arrayMember],
  [CODE_STRING, stringMember],
  [CODE_REGEX, regexMember],
  [CODE_GENERATOR, generatorMember],
  [CODE_PROMISE, promiseMember],
  [CODE_FUNCTION, functionMember],
  [CODE_SMI, numberMember],
  [CODE_DOUBLE, numberMember],
  [CODE_TRUE, booleanMember],
  [CODE_FALSE, booleanMember],
]);

export function memberLookupValue(
  receiver: TaggedValue,
  propName: string,
  interpreter: MemberLookupInterpreter | null = null,
): TaggedValue | null {
  const lookup = MEMBER_LOOKUPS[codeOf(receiver)];
  return lookup === undefined ? null : lookup(receiver, propName, interpreter);
}
