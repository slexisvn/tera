import { Engine } from "../../dist/index.node.js";

export const ORACLE = "oracle";

export const CONFIGS = {
  oracle: { typecheck: "off", osr: false, tieringPolicy: { jitThreshold: 1e12, baselineThreshold: 1e12 } },
  baseline: { typecheck: "off", osr: false, tieringPolicy: { jitThreshold: 1e12 } },
  jit: { typecheck: "off", osr: false },
  jitosr: { typecheck: "off" },
  fast: { typecheck: "off", osr: false, tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 } },
  fastosr: { typecheck: "off", tieringPolicy: { jitThreshold: 30, baselineThreshold: 3 } },
};

export const TARGET_CONFIGS = Object.keys(CONFIGS).filter((name) => name !== ORACLE);

const HOST_FAILURE = /call stack|Invalid string length|out of memory|Array buffer allocation|Invalid array length|Cannot create a string/i;

export const isHostFailure = (message) => HOST_FAILURE.test(message);

export function runConfig(name, source) {
  const engine = new Engine(CONFIGS[name]);
  try {
    return { ok: true, value: engine.runNative(source) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

export function sameValue(a, b) {
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b);
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => sameValue(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, i) => keysB[i] === key && sameValue(a[key], b[key]));
}

export function sameOutcome(a, b) {
  if (a.ok !== b.ok) return false;
  return a.ok ? sameValue(a.value, b.value) : a.error === b.error;
}

export function describe(outcome) {
  if (!outcome.ok) return `throw ${outcome.error}`;
  return stringify(outcome.value);
}

export function stringify(value) {
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stringify).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).map((key) => `${key}: ${stringify(value[key])}`).join(", ")}}`;
  }
  return String(value);
}
