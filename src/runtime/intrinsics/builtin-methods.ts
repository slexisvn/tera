import { STRING_METHODS } from "./string-methods.js";
import { snakeToCamel } from "../../utils/naming.js";
import { isString } from "../../core/value/index.js";
import type { RuntimeFunctionPayload, TaggedValue } from "../../core/value/index.js";

type BuiltinMethodOwner = {
  readonly methods: Readonly<Record<string, RuntimeFunctionPayload>>;
  readonly accepts: (value: TaggedValue) => boolean;
};

const OWNERS = new Map<string, BuiltinMethodOwner>([
  ["string", { methods: STRING_METHODS, accepts: isString }],
]);

export function builtinMethodImplementation(
  owner: string,
  name: string,
  receiver: TaggedValue,
): RuntimeFunctionPayload | null {
  const entry = OWNERS.get(owner);
  if (entry === undefined || !entry.accepts(receiver)) return null;
  const method = snakeToCamel(name);
  return Object.hasOwn(entry.methods, method) ? entry.methods[method]! : null;
}
