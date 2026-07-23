import * as mlfw from "@slexisvn/mlfw";
import {
  getPayload,
  isFunction,
  isObject,
  isString,
  mkString,
  mkUndefined,
  toDisplayString,
  type RuntimeFunctionPayload,
  type TaggedValue,
} from "../../core/value/index.js";
import type { JSObject } from "../../objects/heap/js-object.js";
import { runtimeGetProperty } from "../../objects/exotic/proxy-ops.js";
import { snakeToCamel } from "../../core/naming.js";
import { camelOptions, resolveDevice, splitOptions, type NativeFn } from "./common.js";
import { MODEL_MARKER } from "../../frontend/parser/index.js";
import { bindModelBridge, nativeToTagged, optionsArg, taggedToNative } from "./host.js";
import { TERA_BUILTINS } from "../../../data/tera-language-spec.js";
import { runtimeBuiltinMetadataFromSpec } from "../../utils/language-spec-runtime.js";

type InterpreterLike = {
  callFunctionValue(fn: TaggedValue, args: TaggedValue[], thisValue: TaggedValue): TaggedValue;
  constructFunctionValue(fn: TaggedValue, args: TaggedValue[]): TaggedValue;
};

type BuiltinMap = Record<string, RuntimeFunctionPayload>;

const ml = mlfw as Record<string, unknown>;
const STEP_METHODS = { train: "trainingStep", validate: "validationStep", optimizer: "configureOptimizers" } as const;
const domainBuiltins = runtimeBuiltinMetadataFromSpec(TERA_BUILTINS);

const bridges = new WeakMap<object, unknown>();
const activeBridges: unknown[] = [];

function teraFunction(model: TaggedValue, name: string, interpreter: InterpreterLike): TaggedValue | null {
  if (!isObject(model)) return null;
  const value = runtimeGetProperty(model, name, interpreter);
  return isFunction(value) ? value : null;
}

function ownFields(model: TaggedValue): Array<[string, TaggedValue]> {
  const object = getPayload(model) as JSObject;
  const out: Array<[string, TaggedValue]> = [];
  for (const [key, value] of object.entries()) {
    if (key === MODEL_MARKER || value === undefined || isFunction(value)) continue;
    out.push([key, value]);
  }
  return out;
}

function saveCheckpoint(model: { stateDict?: () => unknown }, path: unknown): void {
  if (typeof model.stateDict !== "function") throw new Error("save() requires a model");
  if (typeof path !== "string") throw new Error("save() requires a file path string");
  const memfs = ml.memfs as { writeBinary(path: string, data: unknown): void; rename(from: string, to: string): void };
  memfs.writeBinary(`${path}.tmp`, (ml.serializeCheckpoint as NativeFn)({ modelState: model.stateDict() }));
  memfs.rename(`${path}.tmp`, path);
}

function createBridge(model: TaggedValue, interpreter: InterpreterLike): unknown {
  const forward = teraFunction(model, "forward", interpreter);
  const steps: Array<[string, TaggedValue]> = [];
  for (const [teraName, nativeName] of Object.entries(STEP_METHODS)) {
    const fn = teraFunction(model, teraName, interpreter);
    if (fn !== null) steps.push([nativeName, fn]);
  }

  const Base = (steps.length > 0 ? ml.LightningModule : ml.Module) as new () => Record<string, unknown>;
  const name = isString(runtimeGetProperty(model, MODEL_MARKER, interpreter))
    ? toDisplayString(runtimeGetProperty(model, MODEL_MARKER, interpreter))
    : "Model";

  class TeraModel extends Base {
    forward(...inputs: unknown[]): unknown {
      if (!forward) throw new Error(`${name} has no forward method`);
      return taggedToNative(interpreter.callFunctionValue(forward, inputs.map(nativeToTagged), model));
    }

    save(path: unknown): void {
      saveCheckpoint(this as { stateDict?: () => unknown }, path);
    }

    toString(): string {
      return `${name}${super.toString?.().slice(this.constructor.name.length) ?? "()"}`;
    }
  }

  const bridge = new TeraModel();
  for (const [field, value] of ownFields(model)) {
    (bridge as Record<string, unknown>)[field] = taggedToNative(value);
  }

  for (const [nativeName, fn] of steps) {
    (bridge as Record<string, unknown>)[nativeName] = (...args: unknown[]) => {
      activeBridges.push(bridge);
      try {
        return taggedToNative(interpreter.callFunctionValue(fn, args.map(nativeToTagged), model));
      } finally {
        activeBridges.pop();
      }
    };
  }

  return bridge;
}

export function modelBridge(model: TaggedValue, interpreter: InterpreterLike): unknown {
  const object = getPayload(model) as object;
  const cached = bridges.get(object);
  if (cached) return cached;
  const bridge = createBridge(model, interpreter);
  bridges.set(object, bridge);
  return bridge;
}

function isIterator(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as { next?: unknown }).next === "function";
}

function logMetric(...args: unknown[]): unknown {
  const bridge = activeBridges[activeBridges.length - 1] as { log(name: string, value: unknown, options: unknown): unknown } | undefined;
  if (!bridge) throw new Error("log() can only be called inside a train or validate block");
  const { values, options } = splitOptions(args);
  const metric = values[1] as { compute?: () => unknown };
  const value = metric && typeof metric === "object" && typeof metric.compute === "function" ? metric.compute() : metric;
  return bridge.log(String(values[0]), value, camelOptions(options));
}

export function createModelBuiltins(): BuiltinMap {
  return {
    compile: {
      name: "compile",
      metadata: domainBuiltins.compile,
      call(args: TaggedValue[], _this: TaggedValue, interpreter: InterpreterLike) {
        const model = args[0] ?? mkUndefined();
        const options = optionsArg(args[args.length - 1] === undefined ? undefined : taggedToNative(args[args.length - 1]!));
        const input = "input" in options ? nativeToTagged(options.input) : args.length > 1 ? args[1] : undefined;
        if (input !== undefined && isObject(model)) {
          const forward = runtimeGetProperty(model, "forward", interpreter);
          if (isFunction(forward)) interpreter.callFunctionValue(forward, [input], model);
        }
        return model;
      },
    },
    model_native: {
      name: "model_native",
      call(args: TaggedValue[], _this: TaggedValue, interpreter: InterpreterLike) {
        const model = args[0];
        if (model === undefined || !isObject(model)) return mkUndefined();
        const method = toDisplayString(args[1] ?? mkString(""));
        const bridge = modelBridge(model, interpreter) as Record<string, unknown>;
        const member = bridge[method] ?? bridge[snakeToCamel(method)];
        if (typeof member !== "function") return nativeToTagged(member);
        const result = (member as NativeFn).apply(bridge, args.slice(2).map((arg) => resolveDevice(taggedToNative(arg))));
        return nativeToTagged(isIterator(result) ? [...(result as Iterable<unknown>)] : result);
      },
    },
    log: {
      name: "log",
      call(args: TaggedValue[]) {
        return nativeToTagged(logMetric(...args.map(taggedToNative)));
      },
    },
  };
}

bindModelBridge(modelBridge);
