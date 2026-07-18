import * as mlfw from "@slexisvn/mlfw";
import type { RuntimeFunctionMetadata } from "../../core/value/index.js";
import { callWithOptions, camelOptions, constructWithOptions, register, splitOptions, type BuiltinMap, type NativeCtor, type NativeFn } from "./common.js";

const ml = mlfw as Record<string, unknown>;

export const TENSOR_FACTORIES = [
  "tensor", "zeros", "ones", "empty", "full", "randn", "arange", "eye", "linspace", "randperm",
  "zerosLike", "onesLike", "emptyLike", "fullLike", "randnLike",
] as const;

export const FREE_TENSOR_FUNCTIONS = ["where", "cat", "stack"] as const;

export const NN_MODULES = [
  "Linear", "ReLU", "GELU", "SiLU", "Sigmoid", "Tanh", "LeakyReLU", "ELU",
  "Softmax", "LogSoftmax", "Flatten", "Dropout", "LayerNorm", "BatchNorm1d",
  "BatchNorm2d", "Conv1d", "Conv2d", "MaxPool2d", "AvgPool2d",
  "AdaptiveAvgPool2d", "Embedding", "GRU", "GRUCell", "LSTM", "LSTMCell",
  "CrossEntropyLoss", "MSELoss", "NLLLoss", "BCELoss",
] as const;

export const SEQUENTIAL_MODULES = ["Sequential"] as const;

export const DATA_MODULES = ["DataLoader", "TensorDataset"] as const;

export const OPTIMIZERS = ["SGD", "Adam", "AdamW"] as const;

export const SCHEDULERS = ["StepLR", "CosineAnnealingLR", "ReduceLROnPlateau"] as const;

export const TRAINERS = ["Trainer"] as const;

export const CALLBACKS = [
  "EarlyStopping", "ModelCheckpoint", "ProgressCallback", "LearningRateMonitor",
  "Timer", "GradientAccumulationScheduler",
] as const;

export const LOGGERS = ["ConsoleLogger", "CSVLogger"] as const;

export const METRICS = [
  "Accuracy", "Precision", "Recall", "F1Score", "ConfusionMatrix", "MetricCollection",
] as const;

export const TENSOR_MODULES = [
  ...NN_MODULES, ...SEQUENTIAL_MODULES, ...DATA_MODULES, ...OPTIMIZERS,
  ...SCHEDULERS, ...TRAINERS, ...CALLBACKS, ...LOGGERS, ...METRICS,
] as const;

const SPECIAL_MODULES = new Set<string>(["Softmax", "LogSoftmax", "DataLoader", "SGD", "Adam", "AdamW", "StepLR", "CosineAnnealingLR", "ReduceLROnPlateau", "Trainer"]);

function constructModule(name: string, Cls: NativeCtor): NativeFn {
  return (...args) => {
    const { values, options } = splitOptions(args);
    const opts = camelOptions(options);
    if (name === "Softmax" || name === "LogSoftmax") return new Cls(opts.axis ?? opts.dim ?? values[0] ?? -1);
    if (name === "DataLoader") return new Cls(values[0], opts);
    if (name === "SGD" || name === "Adam" || name === "AdamW") {
      if (values[0] === undefined) throw new Error(`${name}() requires params as first argument`);
      return new Cls(values[0], opts);
    }
    if (name === "StepLR") return new Cls(values[0], values[1] ?? opts.stepSize, values[2] ?? opts.gamma);
    if (name === "CosineAnnealingLR") return new Cls(values[0], values[1] ?? opts.tMax, values[2] ?? opts.etaMin);
    if (name === "ReduceLROnPlateau") return new Cls(values[0], opts);
    if (name === "Trainer") return new Cls(opts);
    if (Object.keys(opts).length > 0) return new Cls(...values, opts);
    return new Cls(...values);
  };
}

function optimConfig(...args: unknown[]): unknown {
  const { values, options } = splitOptions(args);
  const opts = camelOptions(options);
  const optimizer = values[0] ?? opts.optimizer;
  if (!optimizer) throw new Error("optim_config() requires an optimizer");
  const result: Record<string, unknown> = { optimizer };
  const scheduler = opts.lrScheduler;
  if (scheduler) result.lrScheduler = scheduler;
  return result;
}

function loadModel(model: unknown, path: unknown): unknown {
  if (!model || typeof (model as { loadStateDict?: unknown }).loadStateDict !== "function") throw new Error("load_model() requires a model as the first argument");
  if (typeof path !== "string") throw new Error("load_model() requires a file path string");
  (ml.applyCheckpoint as NativeFn)((ml.loadCheckpoint as NativeFn)(path), model);
  return model;
}

function readText(path: unknown): string {
  if (typeof path !== "string") throw new Error("read_text() requires a file path string");
  const data = (ml.memfs as { readFile(path: string): string | Uint8Array }).readFile(path);
  return typeof data === "string" ? data : new TextDecoder().decode(data);
}

function loadJson(path: unknown): unknown {
  return JSON.parse(readText(path));
}

export function installTensorBuiltins(map: BuiltinMap, metadata: Record<string, RuntimeFunctionMetadata>): void {
  for (const name of TENSOR_FACTORIES) register(map, name, callWithOptions(ml[name] as NativeFn), metadata[name]);
  for (const name of FREE_TENSOR_FUNCTIONS) register(map, name, callWithOptions(ml[name] as NativeFn), metadata[name]);
  for (const name of TENSOR_MODULES) {
    const ctor = ml[name] as NativeCtor | undefined;
    if (typeof ctor === "function") register(map, name, SPECIAL_MODULES.has(name) ? constructModule(name, ctor) : constructWithOptions(ctor), metadata[name]);
  }
  if (typeof ml.Tokenizer === "function") {
    register(map, "Tokenizer", constructWithOptions(ml.Tokenizer as NativeCtor), metadata.Tokenizer);
    register(map, "load_tokenizer", (path) => (ml.Tokenizer as { load(path: unknown): unknown }).load(path), metadata.load_tokenizer);
  }
  register(map, "optim_config", optimConfig, metadata.optim_config);
  register(map, "load_model", loadModel, metadata.load_model);
  register(map, "read_text", readText, metadata.read_text);
  register(map, "load_json", loadJson, metadata.load_json);
}
