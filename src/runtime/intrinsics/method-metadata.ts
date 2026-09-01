import type { RuntimeFunctionPayload } from "../../core/value/index.js";
import { methodMetadataFromSpec } from "../../utils/language-spec-runtime.js";
import { TERA_PSEUDO_TYPES } from "../../../data/tera-language-spec.js";

type MethodTable = Readonly<Record<string, RuntimeFunctionPayload>>;

const SPEC_METHODS = methodMetadataFromSpec(TERA_PSEUDO_TYPES);
const described = new WeakMap<MethodTable, MethodTable>();

export function methodsWithMetadata(owner: string, methods: MethodTable): MethodTable {
  const cached = described.get(methods);
  if (cached) return cached;

  const specs = SPEC_METHODS[owner];
  const out: Record<string, RuntimeFunctionPayload> = {};
  for (const [name, payload] of Object.entries(methods)) {
    const metadata = specs?.get(name);
    out[name] = metadata === undefined ? payload : { ...payload, metadata };
  }
  described.set(methods, out);
  return out;
}
