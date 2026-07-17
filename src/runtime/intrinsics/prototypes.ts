import { STRING_METHODS } from "./string-methods.js";
import { ARRAY_METHODS } from "./array-methods.js";
import { NUMBER_METHODS } from "./number-methods.js";
import { BOOLEAN_METHODS } from "./boolean-methods.js";
import { REGEX_METHODS } from "./regex-methods.js";
import { MAP_METHODS } from "./map-methods.js";
import { SET_METHODS } from "./set-methods.js";
import { WEAKMAP_METHODS } from "./weakmap-methods.js";
import { createJSObject } from "../../objects/heap/factory.js";
import { mkFunction, wellKnownSymbols } from "../../core/value/index.js";
import type { RuntimeFunctionPayload } from "../../core/value/index.js";
import type { JSObject } from "../../objects/heap/js-object.js";

type BuiltinMethod = RuntimeFunctionPayload & {
  name: string;
  call: RuntimeFunctionPayload["call"];
};

const METHOD_ALIASES: Record<string, Record<string, string>> = {
  string: {
    char_at: "charAt",
    char_code_at: "charCodeAt",
    code_point_at: "codePointAt",
    index_of: "indexOf",
    last_index_of: "lastIndexOf",
    starts_with: "startsWith",
    ends_with: "endsWith",
    match_all: "matchAll",
    trim_start: "trimStart",
    trim_end: "trimEnd",
    to_lower_case: "toLowerCase",
    to_upper_case: "toUpperCase",
    pad_start: "padStart",
    pad_end: "padEnd",
    replace_all: "replaceAll",
    to_string: "toString",
    value_of: "valueOf",
  },
  array: {
    index_of: "indexOf",
    last_index_of: "lastIndexOf",
    find_index: "findIndex",
    find_last: "findLast",
    find_last_index: "findLastIndex",
    reduce_right: "reduceRight",
    copy_within: "copyWithin",
    flat_map: "flatMap",
  },
  number: {
    to_string: "toString",
    to_fixed: "toFixed",
    value_of: "valueOf",
    to_precision: "toPrecision",
    to_exponential: "toExponential",
  },
  boolean: {
    to_string: "toString",
    value_of: "valueOf",
  },
};

function populatePrototype(methods: Record<string, BuiltinMethod>, aliases: Record<string, string> = {}): JSObject {
  const proto = createJSObject();
  for (const [name, method] of Object.entries(methods)) {
    proto.setProperty(name, mkFunction(method));
  }
  for (const [alias, target] of Object.entries(aliases)) {
    const method = methods[target];
    if (method) proto.setProperty(alias, mkFunction(method));
  }
  return proto;
}

export function createBuiltinPrototypes(): Record<string, JSObject> {
  const mapPrototype = populatePrototype(MAP_METHODS);
  const setPrototype = populatePrototype(SET_METHODS);
  const weakMapPrototype = populatePrototype(WEAKMAP_METHODS);

  if (wellKnownSymbols.iterator) {
    const mapEntries = mapPrototype.getProperty("entries");
    if (mapEntries !== undefined) mapPrototype.setSymbolProperty(wellKnownSymbols.iterator, mapEntries);

    const setValues = setPrototype.getProperty("values");
    if (setValues !== undefined) setPrototype.setSymbolProperty(wellKnownSymbols.iterator, setValues);
  }

  return {
    stringPrototype: populatePrototype(STRING_METHODS, METHOD_ALIASES.string),
    arrayPrototype: populatePrototype(ARRAY_METHODS, METHOD_ALIASES.array),
    numberPrototype: populatePrototype(NUMBER_METHODS, METHOD_ALIASES.number),
    booleanPrototype: populatePrototype(BOOLEAN_METHODS, METHOD_ALIASES.boolean),
    regexPrototype: populatePrototype(REGEX_METHODS),
    mapPrototype,
    setPrototype,
    weakMapPrototype,
  };
}
