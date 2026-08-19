import * as ir from "../ir/index.js";
import { builtinOwnerMember, declaredNameOf } from "../types/declared.js";
import type { LatticeType } from "../types/lattice.js";
import type { DeclaredDefault, DeclaredSignature } from "../types/signature.js";
import { INT32_MAX } from "../target/integer.js";

export interface BuiltinIntrinsic {
  readonly name: string;
  readonly qualifiedName: string;
  readonly argCount: number;
  readonly requiredArgCount: number;
  readonly signature: DeclaredSignature;
  readonly pure: boolean;
  readonly variadic: boolean;
  readonly defaults: readonly DeclaredDefault[];
}

export interface BuiltinMethodIntrinsic extends BuiltinIntrinsic {
  readonly owner: string;
  readonly getter: boolean;
  readonly surfaceArgCount: number;
}

type BuiltinMethodDeclaration = {
  readonly owner: string;
  readonly name: string;
  readonly pure: boolean;
  readonly params?: readonly string[];
  readonly returns?: string;
  readonly defaults?: readonly DeclaredDefault[];
};

export const STRING_TO_END = INT32_MAX;

export const BUILTIN_METHOD_DECLARATIONS: readonly BuiltinMethodDeclaration[] = [
  { owner: "string", name: "char_code_at", pure: true },
  { owner: "string", name: "char_at", pure: true },
  { owner: "string", name: "length", pure: true },
  { owner: "int", name: "to_string", pure: true },
  { owner: "float", name: "to_string", pure: true },
  { owner: "string", name: "to_upper_case", pure: true, params: [], returns: "string" },
  { owner: "string", name: "to_lower_case", pure: true, params: [], returns: "string" },
  { owner: "string", name: "trim", pure: true, params: [], returns: "string" },
  { owner: "string", name: "trim_start", pure: true, params: [], returns: "string" },
  { owner: "string", name: "trim_end", pure: true, params: [], returns: "string" },
  {
    owner: "string",
    name: "slice",
    pure: true,
    params: ["int", "int"],
    returns: "string",
    defaults: [0, STRING_TO_END],
  },
  { owner: "string", name: "repeat", pure: true, params: ["int"], returns: "string" },
  {
    owner: "string",
    name: "replace",
    pure: true,
    params: ["string", "string"],
    returns: "string",
  },
  {
    owner: "string",
    name: "replace_all",
    pure: true,
    params: ["string", "string"],
    returns: "string",
  },
  { owner: "string", name: "index_of", pure: true, params: ["string"], returns: "int" },
  { owner: "string", name: "includes", pure: true, params: ["string"], returns: "boolean" },
  { owner: "string", name: "starts_with", pure: true, params: ["string"], returns: "boolean" },
  { owner: "string", name: "ends_with", pure: true, params: ["string"], returns: "boolean" },
];

export const BUILTIN_NAMESPACE = "Math";

export const ANY_SCALAR = "scalar";
export const PRINT_BUILTIN = "print";
export const INPUT_BUILTIN = "input";
export const THROW_BUILTIN = "throw";
export const PARSE_INT_BUILTIN = "parse_int";
export const PARSE_FLOAT_BUILTIN = "parse_float";
export const STRING_BUILTIN = "String";
export const NUMBER_BUILTIN = "Number";
export const TO_STRING_MEMBER = "to_string";

const PRINT_ARGUMENT_SEPARATOR = " ".codePointAt(0)!;
const PRINT_LINE_TERMINATOR = "\n".codePointAt(0)!;

export const AGGREGATE_OPEN_TEXT = "[";
export const AGGREGATE_CLOSE_TEXT = "]";
export const OBJECT_OPEN_TEXT = "{ ";
export const OBJECT_CLOSE_TEXT = " }";
export const AGGREGATE_SEPARATOR_TEXT = ", ";
export const NO_TERMINATOR = 0;

/** Set on a print the compiler built, whose terminator does not follow from position. */
export const PRINT_TERMINATOR_PROP = "printTerminator";

export function printTerminatorOf(node: ir.CFGInstruction, index: number, arity: number): number {
  const explicit = node.props[PRINT_TERMINATOR_PROP];
  return typeof explicit === "number" ? explicit : printTerminatorAt(index, arity);
}

export function printTerminatorAt(index: number, arity: number): number {
  return index + 1 < arity ? PRINT_ARGUMENT_SEPARATOR : PRINT_LINE_TERMINATOR;
}

type GlobalBuiltinDeclaration = {
  readonly name: string;
  readonly params: readonly string[];
  readonly returns: string;
  readonly variadic: boolean;
};

const GLOBAL_BUILTIN_DECLARATIONS: readonly GlobalBuiltinDeclaration[] = [
  { name: PRINT_BUILTIN, params: [ANY_SCALAR], returns: "void", variadic: true },
  { name: INPUT_BUILTIN, params: ["string"], returns: "string", variadic: false },
  { name: THROW_BUILTIN, params: ["string"], returns: "void", variadic: false },
  { name: PARSE_INT_BUILTIN, params: ["string"], returns: "float", variadic: false },
  { name: PARSE_FLOAT_BUILTIN, params: ["string"], returns: "float", variadic: false },
];

function buildGlobalRegistry(): Map<string, BuiltinIntrinsic> {
  const registry = new Map<string, BuiltinIntrinsic>();
  for (const declaration of GLOBAL_BUILTIN_DECLARATIONS) {
    registry.set(declaration.name, {
      name: declaration.name,
      qualifiedName: declaration.name,
      argCount: declaration.params.length,
      requiredArgCount: declaration.params.length,
      signature: { params: [...declaration.params], returns: declaration.returns },
      pure: false,
      variadic: declaration.variadic,
      defaults: [],
    });
  }
  return registry;
}

export function builtinParameterAt(
  intrinsic: BuiltinIntrinsic,
  index: number,
): string | null {
  const { params } = intrinsic.signature;
  if (index < params.length) return params[index] ?? null;
  return intrinsic.variadic ? params[params.length - 1] ?? null : null;
}

export function builtinAcceptsArity(intrinsic: BuiltinIntrinsic, arity: number): boolean {
  if (arity < intrinsic.requiredArgCount) return false;
  return intrinsic.variadic || arity <= intrinsic.argCount;
}

const GLOBAL_REGISTRY = buildGlobalRegistry();

export function builtinGlobalIntrinsicByName(name: string): BuiltinIntrinsic | null {
  return GLOBAL_REGISTRY.get(name) ?? null;
}

type NamespaceFunctionDeclaration = {
  readonly name: string;
  readonly argCount: number;
};

const NAMESPACE_FUNCTION_DECLARATIONS: readonly NamespaceFunctionDeclaration[] = [
  { name: "abs", argCount: 1 },
  { name: "floor", argCount: 1 },
  { name: "ceil", argCount: 1 },
  { name: "sqrt", argCount: 1 },
  { name: "trunc", argCount: 1 },
  { name: "round", argCount: 1 },
  { name: "min", argCount: 2 },
  { name: "max", argCount: 2 },
];

export function qualifiedMethodName(owner: string, name: string): string {
  return `${owner}.${name}`;
}

function buildNamespaceRegistry(): Map<string, BuiltinMethodIntrinsic> {
  const registry = new Map<string, BuiltinMethodIntrinsic>();
  for (const declaration of NAMESPACE_FUNCTION_DECLARATIONS) {
    const qualifiedName = qualifiedMethodName(BUILTIN_NAMESPACE, declaration.name);
    registry.set(qualifiedName, {
      owner: BUILTIN_NAMESPACE,
      name: declaration.name,
      qualifiedName,
      argCount: declaration.argCount,
      requiredArgCount: declaration.argCount,
      getter: false,
      signature: {
        params: Array.from({ length: declaration.argCount }, () => "float"),
        returns: "float",
      },
      pure: true,
      variadic: false,
      defaults: [],
      surfaceArgCount: declaration.argCount + 1,
    });
  }
  return registry;
}

const NAMESPACE_REGISTRY = buildNamespaceRegistry();

export function builtinNamespaceIntrinsic(
  namespace: string,
  name: string,
  argCount: number,
): BuiltinMethodIntrinsic | null {
  if (namespace !== BUILTIN_NAMESPACE) return null;
  const intrinsic = NAMESPACE_REGISTRY.get(qualifiedMethodName(namespace, name)) ?? null;
  return intrinsic === null || intrinsic.argCount !== argCount ? null : intrinsic;
}

export function builtinNamespaceIntrinsicByName(
  qualifiedName: string,
): BuiltinMethodIntrinsic | null {
  return NAMESPACE_REGISTRY.get(qualifiedName) ?? null;
}

function buildRegistry(): Map<string, BuiltinMethodIntrinsic> {
  const registry = new Map<string, BuiltinMethodIntrinsic>();
  for (const declaration of BUILTIN_METHOD_DECLARATIONS) {
    const member = builtinOwnerMember(declaration.owner, declaration.name);
    if (member === null) continue;
    const qualifiedName = qualifiedMethodName(declaration.owner, declaration.name);
    const supported = member.signature.params.slice(0, member.requiredCount);
    const params = member.getter ? [] : declaration.params ?? supported;
    const defaults = declaration.defaults ?? [];
    registry.set(qualifiedName, {
      owner: declaration.owner,
      name: declaration.name,
      qualifiedName,
      argCount: params.length + 1,
      requiredArgCount: (member.getter ? 0 : params.length - defaults.length) + 1,
      getter: member.getter,
      signature: {
        params: [declaration.owner, ...params],
        returns: declaration.returns ?? member.signature.returns,
      },
      pure: declaration.pure,
      variadic: false,
      defaults,
      surfaceArgCount: (member.getter ? 0 : member.signature.params.length) + 1,
    });
  }
  return registry;
}

const REGISTRY = buildRegistry();

export function builtinMethodIntrinsicByName(
  qualifiedName: string,
): BuiltinMethodIntrinsic | null {
  return REGISTRY.get(qualifiedName) ?? null;
}

export const STRING_TYPE = "string";

function namesReturning(match: (intrinsic: BuiltinIntrinsic) => boolean): ReadonlySet<string> {
  const names = new Set<string>();
  for (const registry of [REGISTRY, NAMESPACE_REGISTRY]) {
    for (const intrinsic of registry.values()) {
      if (match(intrinsic)) names.add(intrinsic.qualifiedName);
    }
  }
  return names;
}

export const BUILTIN_METHOD_NAMES = namesReturning(() => true);

export const GLOBAL_BUILTIN_NAMES: ReadonlySet<string> = new Set(GLOBAL_REGISTRY.keys());

export const STRING_PRODUCING_BUILTINS = namesReturning(
  (intrinsic) => intrinsic.signature.returns === STRING_TYPE,
);

export function builtinIntrinsicByName(qualifiedName: string): BuiltinIntrinsic | null {
  return (
    builtinMethodIntrinsicByName(qualifiedName) ??
    builtinNamespaceIntrinsicByName(qualifiedName) ??
    builtinGlobalIntrinsicByName(qualifiedName)
  );
}

export function builtinMethodIntrinsicFor(
  receiver: LatticeType,
  name: string,
): BuiltinMethodIntrinsic | null {
  const owner = declaredNameOf(receiver);
  return owner === null ? null : builtinMethodIntrinsicByName(qualifiedMethodName(owner, name));
}

export function builtinMethodCallMetadata(intrinsic: BuiltinIntrinsic): ir.IRMetadata {
  const props: ir.IRMetadata = {
    builtin: true,
    target: {
      declaredSignature: {
        params: [...intrinsic.signature.params],
        returns: intrinsic.signature.returns,
      },
    },
  };
  if (intrinsic.pure) {
    props.declaredEffects = ["immutable-read"];
    props.readonly = true;
  }
  return props;
}
