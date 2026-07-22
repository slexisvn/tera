import type { RuntimeBuiltinKind, RuntimeFunctionMetadata } from "../../core/value/index.js";
import { LINALG_FUNCS, ML_CLUSTERS, ML_METRICS, ML_MODELS, ML_SPLITTERS, ML_TRANSFORMS } from "./ml-builtins.js";
import { NUMERIC_ARRAY_OPS, NUMERIC_DIST_FUNCS, NUMERIC_INTERP_FUNCS, NUMERIC_RANDOM, NUMERIC_SPECIAL_FUNCS, NUMERIC_STATS_TESTS, NUMERIC_TIMESERIES, NUMERIC_TRANSFORM_FUNCS } from "./numeric-builtins.js";
import { QUANT_ADVANCED } from "./quant-builtins.js";
import {
  CALLBACKS, DATA_MODULES, FREE_TENSOR_FUNCTIONS, LOGGERS, METRICS, NN_MODULES,
  OPTIMIZERS, SCHEDULERS, SEQUENTIAL_MODULES, TENSOR_FACTORIES, TENSOR_MODULES, TRAINERS,
} from "./tensor-builtins.js";

type Params = NonNullable<RuntimeFunctionMetadata["params"]>;

function meta(name: string, returns: string, params: RuntimeFunctionMetadata["params"] = [], callConvention: RuntimeFunctionMetadata["callConvention"] = "positional_named", effect: RuntimeFunctionMetadata["effect"] = "sync"): RuntimeFunctionMetadata {
  return { name, params, returns, effect, callConvention };
}

const any = "any";
const number = "number";
const object = "Object";
const array = "Array";
const tensorType = "Tensor";

export const ASYNC_DOMAIN_TYPES = new Set(["DataFrame", "Trainer"]);

export const RESULT_FIELD_TYPES: Record<string, Record<string, string>> = {
  backtest: { equity: "DataFrame", port_returns: "DataFrame" },
  walk_forward: { equity: "DataFrame", port_returns: "DataFrame" },
};

export const DEVICE_NAMES = ["cpu", "gpu", "wasm", "webgpu"] as const;
export const DTYPE_NAMES = ["f16", "f32", "f64", "i32", "i64", "bool"] as const;

const OPTIONS: Params[number] = { name: "options", type: object, optional: true, rest: true, named: true };

function asNamed(params: Params): Params {
  return params.map((param) => ({ ...param, named: true }));
}

function withSignatures(returns: string, signatures: Record<string, Params>): Record<string, RuntimeFunctionMetadata> {
  return Object.fromEntries(Object.entries(signatures).map(([name, params]) => [name, meta(name, returns, params)]));
}

function generatedMetadata(names: readonly string[], returns: string, params: RuntimeFunctionMetadata["params"] = []): Record<string, RuntimeFunctionMetadata> {
  return Object.fromEntries(names.map((name) => [name, meta(name, returns, params)]));
}

const TENSOR_SIGNATURES: Record<string, Params> = {
  tensor: [{ name: "data", type: any }, OPTIONS],
  zeros: [{ name: "shape", type: array }, OPTIONS],
  ones: [{ name: "shape", type: array }, OPTIONS],
  empty: [{ name: "shape", type: array }, OPTIONS],
  full: [{ name: "shape", type: array }, { name: "value", type: number }, OPTIONS],
  randn: [{ name: "shape", type: array }, OPTIONS],
  arange: [{ name: "start", type: number }, { name: "end", type: number, optional: true }, { name: "step", type: number, optional: true }, OPTIONS],
  eye: [{ name: "n", type: number }, { name: "m", type: number, optional: true }, OPTIONS],
  linspace: [{ name: "start", type: number }, { name: "end", type: number }, { name: "steps", type: number }, OPTIONS],
  randperm: [{ name: "n", type: number }, OPTIONS],
  zeros_like: [{ name: "tensor", type: tensorType }],
  ones_like: [{ name: "tensor", type: tensorType }],
  empty_like: [{ name: "tensor", type: tensorType }],
  full_like: [{ name: "tensor", type: tensorType }, { name: "value", type: number }],
  randn_like: [{ name: "tensor", type: tensorType }],
  where: [{ name: "condition", type: tensorType }, { name: "a", type: tensorType }, { name: "b", type: tensorType }],
  cat: [{ name: "tensors", type: array }, { name: "axis", type: number, optional: true, defaultValue: 0 }],
  stack: [{ name: "tensors", type: array }, { name: "axis", type: number, optional: true, defaultValue: 0 }],
};

const MODULE_SIGNATURES: Record<string, Params> = {
  Sequential: [{ name: "modules", type: any, optional: true, rest: true }],
  Linear: [{ name: "in", type: number }, { name: "out", type: number }, { name: "bias", type: "boolean", optional: true, defaultValue: true }],
  ReLU: [],
  GELU: [],
  SiLU: [],
  Sigmoid: [],
  Tanh: [],
  LeakyReLU: [{ name: "negative_slope", type: number, optional: true, defaultValue: 0.01 }],
  ELU: [{ name: "alpha", type: number, optional: true, defaultValue: 1 }],
  Softmax: [{ name: "dim", type: number, optional: true, defaultValue: -1 }],
  LogSoftmax: [{ name: "dim", type: number, optional: true, defaultValue: -1 }],
  Flatten: [{ name: "start_dim", type: number, optional: true, defaultValue: 1 }, { name: "end_dim", type: number, optional: true, defaultValue: -1 }],
  Dropout: [{ name: "p", type: number, optional: true, defaultValue: 0.5 }],
  LayerNorm: [{ name: "shape", type: array }, { name: "eps", type: number, optional: true, defaultValue: 1e-5 }],
  BatchNorm1d: [{ name: "features", type: number }, { name: "eps", type: number, optional: true, defaultValue: 1e-5 }, { name: "momentum", type: number, optional: true, defaultValue: 0.1 }],
  BatchNorm2d: [{ name: "features", type: number }, { name: "eps", type: number, optional: true, defaultValue: 1e-5 }, { name: "momentum", type: number, optional: true, defaultValue: 0.1 }],
  Conv1d: [{ name: "in", type: number }, { name: "out", type: number }, { name: "kernel", type: number }, { name: "stride", type: number, optional: true, defaultValue: 1 }, { name: "padding", type: number, optional: true, defaultValue: 0 }],
  Conv2d: [{ name: "in", type: number }, { name: "out", type: number }, { name: "kernel", type: number }, { name: "stride", type: number, optional: true, defaultValue: 1 }, { name: "padding", type: number, optional: true, defaultValue: 0 }],
  MaxPool2d: [{ name: "kernel", type: number }, { name: "stride", type: number, optional: true }, { name: "padding", type: number, optional: true, defaultValue: 0 }],
  AvgPool2d: [{ name: "kernel", type: number }, { name: "stride", type: number, optional: true }, { name: "padding", type: number, optional: true, defaultValue: 0 }],
  AdaptiveAvgPool2d: [{ name: "output_size", type: array }],
  Embedding: [{ name: "num", type: number }, { name: "dim", type: number }, { name: "padding_idx", type: number, optional: true }],
  GRU: [{ name: "input", type: number }, { name: "hidden", type: number }, { name: "num_layers", type: number, optional: true, defaultValue: 1 }, { name: "batch_first", type: "boolean", optional: true, defaultValue: false }, { name: "bias", type: "boolean", optional: true, defaultValue: true }],
  GRUCell: [{ name: "input", type: number }, { name: "hidden", type: number }, { name: "bias", type: "boolean", optional: true, defaultValue: true }],
  LSTM: [{ name: "input", type: number }, { name: "hidden", type: number }, { name: "num_layers", type: number, optional: true, defaultValue: 1 }, { name: "batch_first", type: "boolean", optional: true, defaultValue: false }, { name: "bias", type: "boolean", optional: true, defaultValue: true }],
  LSTMCell: [{ name: "input", type: number }, { name: "hidden", type: number }, { name: "bias", type: "boolean", optional: true, defaultValue: true }],
  CrossEntropyLoss: [{ name: "reduction", type: "string", optional: true, defaultValue: "mean" }, { name: "ignore_index", type: number, optional: true }],
  MSELoss: [],
  NLLLoss: [],
  BCELoss: [],
};

const TRAINING_SIGNATURES: Record<string, Params> = {
  TensorDataset: [{ name: "tensors", type: any, optional: true, rest: true }],
  DataLoader: [{ name: "dataset", type: any }, ...asNamed([
    { name: "batch_size", type: number, optional: true, defaultValue: 32 },
    { name: "shuffle", type: "boolean", optional: true, defaultValue: true },
    { name: "drop_last", type: "boolean", optional: true, defaultValue: false },
  ])],
  SGD: [{ name: "params", type: any }, ...asNamed([
    { name: "lr", type: number, optional: true, defaultValue: 0.01 },
    { name: "momentum", type: number, optional: true, defaultValue: 0 },
    { name: "weight_decay", type: number, optional: true, defaultValue: 0 },
  ])],
  Adam: [{ name: "params", type: any }, ...asNamed([
    { name: "lr", type: number, optional: true, defaultValue: 0.001 },
    { name: "betas", type: array, optional: true },
    { name: "weight_decay", type: number, optional: true, defaultValue: 0 },
  ])],
  AdamW: [{ name: "params", type: any }, ...asNamed([
    { name: "lr", type: number, optional: true, defaultValue: 0.001 },
    { name: "betas", type: array, optional: true },
    { name: "weight_decay", type: number, optional: true, defaultValue: 0.01 },
  ])],
  StepLR: [{ name: "optimizer", type: any }, { name: "step_size", type: number }, { name: "gamma", type: number, optional: true, defaultValue: 0.1 }],
  CosineAnnealingLR: [{ name: "optimizer", type: any }, { name: "t_max", type: number }, { name: "eta_min", type: number, optional: true, defaultValue: 0 }],
  ReduceLROnPlateau: [{ name: "optimizer", type: any }, ...asNamed([
    { name: "mode", type: "string", optional: true, defaultValue: "min" },
    { name: "patience", type: number, optional: true, defaultValue: 10 },
    { name: "factor", type: number, optional: true, defaultValue: 0.1 },
  ])],
  Trainer: asNamed([
    { name: "max_epochs", type: number, optional: true, defaultValue: 20 },
    { name: "accelerator", type: "string", optional: true, defaultValue: "cpu" },
    { name: "logger", type: any, optional: true, defaultValue: true },
    { name: "enable_checkpointing", type: "boolean", optional: true, defaultValue: false },
    { name: "enable_progress", type: "boolean", optional: true, defaultValue: true },
    { name: "callbacks", type: any, optional: true },
    { name: "fast_dev_run", type: "boolean", optional: true, defaultValue: false },
    { name: "gradient_clip_val", type: number, optional: true },
    { name: "log_every_n_steps", type: number, optional: true, defaultValue: 50 },
  ]),
  EarlyStopping: asNamed([
    { name: "monitor", type: "string" },
    { name: "patience", type: number, optional: true, defaultValue: 3 },
    { name: "mode", type: "string", optional: true, defaultValue: "min" },
  ]),
  ModelCheckpoint: asNamed([
    { name: "monitor", type: "string" },
    { name: "save_top_k", type: number, optional: true, defaultValue: 1 },
    { name: "mode", type: "string", optional: true, defaultValue: "min" },
  ]),
  ProgressCallback: [],
  LearningRateMonitor: [],
  Timer: [],
  GradientAccumulationScheduler: asNamed([{ name: "scheduling", type: object }]),
  ConsoleLogger: [],
  CSVLogger: asNamed([
    { name: "save_dir", type: "string", optional: true, defaultValue: "logs" },
    { name: "name", type: "string", optional: true, defaultValue: "experiment" },
  ]),
  Accuracy: asNamed([
    { name: "task", type: "string", optional: true, defaultValue: "binary" },
    { name: "num_classes", type: number, optional: true },
    { name: "top_k", type: number, optional: true, defaultValue: 1 },
  ]),
  Precision: asNamed([
    { name: "task", type: "string", optional: true, defaultValue: "binary" },
    { name: "num_classes", type: number, optional: true },
    { name: "average", type: "string", optional: true, defaultValue: "macro" },
  ]),
  Recall: asNamed([
    { name: "task", type: "string", optional: true, defaultValue: "binary" },
    { name: "num_classes", type: number, optional: true },
    { name: "average", type: "string", optional: true, defaultValue: "macro" },
  ]),
  F1Score: asNamed([
    { name: "task", type: "string", optional: true, defaultValue: "binary" },
    { name: "num_classes", type: number, optional: true },
    { name: "average", type: "string", optional: true, defaultValue: "macro" },
  ]),
  ConfusionMatrix: asNamed([{ name: "num_classes", type: number }]),
  MetricCollection: [{ name: "metrics", type: any, optional: true, rest: true }],
  Tokenizer: asNamed([
    { name: "mode", type: "string", optional: true, defaultValue: "word" },
    { name: "vocab_size", type: number, optional: true },
    { name: "lowercase", type: "boolean", optional: true, defaultValue: false },
    { name: "num_merges", type: number, optional: true, defaultValue: 1000 },
    { name: "special_tokens", type: array, optional: true },
  ]),
};

const RAW_DOMAIN_METADATA: Record<string, RuntimeFunctionMetadata> = {
  compile: meta("compile", "Object", [{ name: "model", type: any }, { name: "input", type: any, optional: true, named: true }]),
  ...generatedMetadata([...ML_MODELS, ...ML_TRANSFORMS, ...ML_CLUSTERS, ...ML_SPLITTERS], object, [OPTIONS]),
  ...generatedMetadata(LINALG_FUNCS, any, [{ name: "input", type: any }]),
  ...Object.fromEntries(ML_METRICS.map((name) => [name, meta(name, any, [{ name: "y_true", type: any }, { name: "y_pred", type: any }])])),
  train_test_split: meta("train_test_split", array, [{ name: "X", type: any }, { name: "y", type: any, optional: true }, { name: "test_size", type: number, optional: true, named: true }, { name: "shuffle", type: "boolean", optional: true, named: true }, { name: "random_state", type: number, optional: true, named: true }]),
  cross_val_score: meta("cross_val_score", array, [{ name: "estimator", type: any }, { name: "X", type: any }, { name: "y", type: any }, { name: "cv", type: number, optional: true, named: true }]),
  GridSearchCV: meta("GridSearchCV", object, [{ name: "estimator", type: any }, { name: "param_grid", type: any }, { name: "cv", type: number, optional: true, named: true }]),
  ...generatedMetadata(NUMERIC_DIST_FUNCS, number, [OPTIONS]),
  ...generatedMetadata(NUMERIC_SPECIAL_FUNCS, any, [{ name: "input", type: any }]),
  ...generatedMetadata(NUMERIC_TRANSFORM_FUNCS, any, [{ name: "input", type: any }]),
  ...generatedMetadata(NUMERIC_INTERP_FUNCS, any),
  ...generatedMetadata(NUMERIC_STATS_TESTS, object, [OPTIONS]),
  ...generatedMetadata(NUMERIC_TIMESERIES, object, [OPTIONS]),
  ...generatedMetadata(NUMERIC_ARRAY_OPS, any, [OPTIONS]),
  ...generatedMetadata(NUMERIC_RANDOM, any, [OPTIONS]),
  ...generatedMetadata(QUANT_ADVANCED, any, [OPTIONS]),
  load_tokenizer: meta("load_tokenizer", "Tokenizer", [{ name: "path", type: "string" }], "positional_named", "io"),
  optim_config: meta("optim_config", object, [{ name: "optimizer", type: any }, { name: "lr_scheduler", type: object, optional: true, named: true }]),
  load_model: meta("load_model", object, [{ name: "model", type: any }, { name: "path", type: "string" }], "positional_named", "io"),
  read_text: meta("read_text", "string", [{ name: "path", type: "string" }], "positional_named", "io"),
  load_json: meta("load_json", any, [{ name: "path", type: "string" }], "positional_named", "io"),
  ...generatedMetadata([...DEVICE_NAMES, ...DTYPE_NAMES], "string"),
  ...withSignatures(tensorType, TENSOR_SIGNATURES),
  ...withSignatures(object, MODULE_SIGNATURES),
  ...withSignatures(object, TRAINING_SIGNATURES),
  Trainer: meta("Trainer", "Trainer", TRAINING_SIGNATURES.Trainer),
  Tokenizer: meta("Tokenizer", "Tokenizer", TRAINING_SIGNATURES.Tokenizer),
  DataFrame: meta("DataFrame", "DataFrame", [{ name: "columns", type: any, rest: true, named: true }], "named"),
  col: meta("col", "Column", [{ name: "name", type: "string" }]),
  lit: meta("lit", "Column", [{ name: "value", type: any }]),
  expr: meta("expr", "Column", [{ name: "sql", type: "string" }]),
  sum: meta("sum", "Column", [{ name: "column", type: any }]),
  avg: meta("avg", "Column", [{ name: "column", type: any }]),
  min: meta("min", "Column", [{ name: "column", type: any }]),
  max: meta("max", "Column", [{ name: "column", type: any }]),
  count: meta("count", "Column", [{ name: "column", type: any, optional: true }]),
  count_star: meta("count_star", "Column"),
  load_csv: meta("load_csv", "DataFrame", [{ name: "path", type: "string" }, { name: "separator", type: "string", optional: true, named: true }], "positional_named", "io"),
  register_columns_table: meta("register_columns_table", "string", [{ name: "columns", type: any, rest: true, named: true }], "named"),
  momentum: meta("momentum", "Function", [{ name: "lookback", type: number, optional: true, defaultValue: 20 }]),
  mean_reversion: meta("mean_reversion", "Function", [{ name: "lookback", type: number, optional: true, defaultValue: 20 }]),
  zscore: meta("zscore", "Function", [{ name: "window", type: number, optional: true, defaultValue: 20 }]),
  equal_weight: meta("equal_weight", "Function"),
  cross_sectional: meta("cross_sectional", "Function"),
  long_short: meta("long_short", "Function", [{ name: "fraction", type: number, optional: true, defaultValue: 0.5 }]),
  backtest: meta("backtest", "Object", [{ name: "prices", type: any }, OPTIONS], "positional_named", "async"),
  walk_forward: meta("walk_forward", "Object", [{ name: "prices", type: any }, OPTIONS], "positional_named", "async"),
  sharpe: meta("sharpe", number, [{ name: "returns", type: any }, { name: "periods_per_year", type: number, optional: true }]),
  risk_parity: meta("risk_parity", "Array", [{ name: "cov", type: any }], "positional_named", "async"),
  hrp: meta("hrp", "Array", [{ name: "cov", type: any }], "positional_named", "async"),
  mean_variance: meta("mean_variance", "Array", [{ name: "mu", type: any }, { name: "cov", type: any }], "positional_named", "async"),
  range: meta("range", "Array", [{ name: "start", type: number, optional: true }, { name: "stop", type: number, optional: true }, { name: "step", type: number, optional: true, defaultValue: 1 }]),
};


const COLUMN_FUNCS = ["col", "lit", "expr", "sum", "avg", "min", "max", "count", "count_star"] as const;
const DATAFRAME_FUNCS = ["DataFrame", "load_csv", "register_columns_table"] as const;
const IO_FUNCS = ["read_text", "load_json", "load_model", "load_tokenizer", "Tokenizer"] as const;
const QUANT_FUNCS = [
  "momentum", "mean_reversion", "zscore", "equal_weight", "cross_sectional", "long_short",
  "backtest", "walk_forward", "sharpe", "risk_parity", "hrp", "mean_variance",
] as const;
const PLAIN_FUNCS = ["compile", "range", "optim_config"] as const;

const KIND_BY_GROUP: Array<readonly [readonly string[], RuntimeBuiltinKind]> = [
  [TENSOR_FACTORIES, "factory"],
  [FREE_TENSOR_FUNCTIONS, "function"],
  [NN_MODULES, "module"],
  [SEQUENTIAL_MODULES, "sequential"],
  [DATA_MODULES, "data"],
  [OPTIMIZERS, "optimizer"],
  [SCHEDULERS, "scheduler"],
  [TRAINERS, "trainer"],
  [CALLBACKS, "callback"],
  [LOGGERS, "logger"],
  [METRICS, "metric"],
  [ML_MODELS, "ml_model"],
  [ML_TRANSFORMS, "ml_transform"],
  [ML_CLUSTERS, "ml_cluster"],
  [ML_SPLITTERS, "ml_split"],
  [ML_METRICS, "ml_metric"],
  [["train_test_split", "cross_val_score"], "ml_function"],
  [["GridSearchCV"], "grid_search"],
  [LINALG_FUNCS, "linalg"],
  [NUMERIC_DIST_FUNCS, "numeric_dist"],
  [NUMERIC_SPECIAL_FUNCS, "numeric_func"],
  [NUMERIC_INTERP_FUNCS, "numeric_func"],
  [NUMERIC_TRANSFORM_FUNCS, "numeric_transform"],
  [NUMERIC_STATS_TESTS, "numeric_stats_test"],
  [NUMERIC_TIMESERIES, "numeric_timeseries"],
  [NUMERIC_ARRAY_OPS, "numeric_array_op"],
  [NUMERIC_RANDOM, "numeric_random"],
  [QUANT_ADVANCED, "quant"],
  [QUANT_FUNCS, "quant"],
  [DEVICE_NAMES, "device"],
  [DTYPE_NAMES, "dtype"],
  [COLUMN_FUNCS, "function"],
  [DATAFRAME_FUNCS, "data"],
  [IO_FUNCS, "data"],
  [PLAIN_FUNCS, "function"],
];

function assignKinds(metadata: Record<string, RuntimeFunctionMetadata>): Record<string, RuntimeFunctionMetadata> {
  const kinds = new Map<string, RuntimeBuiltinKind>();
  for (const [names, kind] of KIND_BY_GROUP) {
    for (const name of names) kinds.set(name, kind);
  }

  const unclassified = Object.keys(metadata).filter((name) => !kinds.has(name));
  if (unclassified.length) {
    throw new Error(`DOMAIN_BUILTIN_METADATA entries have no kind in KIND_BY_GROUP: ${unclassified.join(", ")}`);
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([name, entry]) => [name, { ...entry, kind: kinds.get(name) }]),
  );
}

export const DOMAIN_BUILTIN_METADATA: Record<string, RuntimeFunctionMetadata> = assignKinds(RAW_DOMAIN_METADATA);

const CHART_COLUMN = "string | number";
const CHART_COLUMNS = "string | number | string[] | number[]";

export const CHART_METADATA: Record<string, RuntimeFunctionMetadata> = Object.fromEntries(
  ["line", "bar", "scatter", "histogram", "area", "box", "violin", "density", "correlation", "hexbin", "heatmap", "regression", "ecdf", "bubble", "funnel", "waterfall"].map((name) => [
    name,
    {
      ...meta(name, "ChartSpec", [
        { name: "data", type: any },
        { name: "x", type: CHART_COLUMN, optional: true, named: true },
        { name: "y", type: CHART_COLUMNS, optional: true, named: true },
        { name: "bins", type: number, optional: true, named: true },
        { name: "title", type: "string", optional: true, named: true },
        { name: "x_label", type: "string", optional: true, named: true },
        { name: "y_label", type: "string", optional: true, named: true },
        { name: "options", type: any, optional: true, rest: true, named: true },
      ]),
      kind: "chart" as RuntimeBuiltinKind,
    },
  ]),
);
