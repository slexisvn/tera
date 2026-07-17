import type { RuntimeFunctionMetadata } from "../../core/value/index.js";
import { LINALG_FUNCS, ML_CLUSTERS, ML_METRICS, ML_MODELS, ML_SPLITTERS, ML_TRANSFORMS } from "./ml-builtins.js";
import { NUMERIC_ARRAY_OPS, NUMERIC_DIST_FUNCS, NUMERIC_INTERP_FUNCS, NUMERIC_RANDOM, NUMERIC_SPECIAL_FUNCS, NUMERIC_STATS_TESTS, NUMERIC_TIMESERIES, NUMERIC_TRANSFORM_FUNCS } from "./numeric-builtins.js";
import { QUANT_ADVANCED } from "./quant-builtins.js";
import { FREE_TENSOR_FUNCTIONS, TENSOR_FACTORIES, TENSOR_MODULES } from "./tensor-builtins.js";

function meta(name: string, returns: string, params: RuntimeFunctionMetadata["params"] = [], callConvention: RuntimeFunctionMetadata["callConvention"] = "positional_named", effect: RuntimeFunctionMetadata["effect"] = "sync"): RuntimeFunctionMetadata {
  return { name, params, returns, effect, callConvention };
}

const any = "any";
const number = "number";
const object = "Object";
const array = "Array";
const tensorType = "Tensor";

function generatedMetadata(names: readonly string[], returns: string, params: RuntimeFunctionMetadata["params"] = []): Record<string, RuntimeFunctionMetadata> {
  return Object.fromEntries(names.map((name) => [name, meta(name, returns, params)]));
}

export const DOMAIN_BUILTIN_METADATA: Record<string, RuntimeFunctionMetadata> = {
  compile: meta("compile", "Object", [{ name: "model", type: any }, { name: "input", type: any, optional: true, named: true }]),
  ...generatedMetadata(TENSOR_FACTORIES, tensorType),
  ...generatedMetadata(FREE_TENSOR_FUNCTIONS, tensorType),
  ...generatedMetadata(TENSOR_MODULES, object),
  ...generatedMetadata([...ML_MODELS, ...ML_TRANSFORMS, ...ML_CLUSTERS, ...ML_SPLITTERS], object),
  ...generatedMetadata(LINALG_FUNCS, any, [{ name: "input", type: any }]),
  ...Object.fromEntries(ML_METRICS.map((name) => [name, meta(name, any, [{ name: "y_true", type: any }, { name: "y_pred", type: any }])])),
  train_test_split: meta("train_test_split", array, [{ name: "X", type: any }, { name: "y", type: any, optional: true }, { name: "test_size", type: number, optional: true, named: true }, { name: "random_state", type: number, optional: true, named: true }]),
  cross_val_score: meta("cross_val_score", array, [{ name: "estimator", type: any }, { name: "X", type: any }, { name: "y", type: any }, { name: "cv", type: number, optional: true, named: true }]),
  GridSearchCV: meta("GridSearchCV", object, [{ name: "estimator", type: any }, { name: "param_grid", type: any }, { name: "cv", type: number, optional: true, named: true }]),
  ...generatedMetadata(NUMERIC_DIST_FUNCS, number),
  ...generatedMetadata(NUMERIC_SPECIAL_FUNCS, any, [{ name: "input", type: any }]),
  ...generatedMetadata(NUMERIC_TRANSFORM_FUNCS, any, [{ name: "input", type: any }]),
  ...generatedMetadata(NUMERIC_INTERP_FUNCS, any),
  ...generatedMetadata(NUMERIC_STATS_TESTS, object),
  ...generatedMetadata(NUMERIC_TIMESERIES, object),
  ...generatedMetadata(NUMERIC_ARRAY_OPS, any),
  ...generatedMetadata(NUMERIC_RANDOM, any),
  ...generatedMetadata(QUANT_ADVANCED, any),
  Tokenizer: meta("Tokenizer", object),
  load_tokenizer: meta("load_tokenizer", object, [{ name: "path", type: "string" }], "positional_named", "io"),
  optim_config: meta("optim_config", object, [{ name: "optimizer", type: object }, { name: "lr_scheduler", type: object, optional: true, named: true }]),
  load_model: meta("load_model", object, [{ name: "model", type: object }, { name: "path", type: "string" }], "positional_named", "io"),
  read_text: meta("read_text", "string", [{ name: "path", type: "string" }], "positional_named", "io"),
  load_json: meta("load_json", any, [{ name: "path", type: "string" }], "positional_named", "io"),
  ...generatedMetadata(["cpu", "gpu", "wasm", "webgpu", "f16", "f32", "f64", "i32", "i64", "bool"], "string"),
  tensor: meta("tensor", "Tensor", [{ name: "data", type: any }]),
  zeros: meta("zeros", "Tensor", [{ name: "shape", type: any }]),
  ones: meta("ones", "Tensor", [{ name: "shape", type: any }]),
  empty: meta("empty", "Tensor", [{ name: "shape", type: any }]),
  full: meta("full", "Tensor", [{ name: "shape", type: any }, { name: "value", type: number }]),
  randn: meta("randn", "Tensor", [{ name: "shape", type: any }]),
  arange: meta("arange", "Tensor", [{ name: "start", type: number }, { name: "end", type: number, optional: true }, { name: "step", type: number, optional: true }]),
  eye: meta("eye", "Tensor", [{ name: "n", type: number }, { name: "m", type: number, optional: true }]),
  linspace: meta("linspace", "Tensor", [{ name: "start", type: number }, { name: "end", type: number }, { name: "steps", type: number }]),
  randperm: meta("randperm", "Tensor", [{ name: "n", type: number }]),
  where: meta("where", "Tensor", [{ name: "condition", type: any }, { name: "x", type: any }, { name: "y", type: any }]),
  cat: meta("cat", "Tensor", [{ name: "tensors", type: any }, { name: "dim", type: number, optional: true }]),
  stack: meta("stack", "Tensor", [{ name: "tensors", type: any }, { name: "dim", type: number, optional: true }]),
  DataFrame: meta("DataFrame", "DataFrame", [{ name: "columns", type: any, rest: true, named: true }], "named"),
  col: meta("col", "Column", [{ name: "name", type: "string" }]),
  lit: meta("lit", "Column", [{ name: "value", type: any }]),
  expr: meta("expr", "Column", [{ name: "sql", type: "string" }]),
  sum: meta("sum", "Column", [{ name: "column", type: any }]),
  avg: meta("avg", "Column", [{ name: "column", type: any }]),
  min: meta("min", "Column", [{ name: "column", type: any }]),
  max: meta("max", "Column", [{ name: "column", type: any }]),
  count: meta("count", "Column", [{ name: "column", type: any, optional: true }]),
  countStar: meta("countStar", "Column"),
  load_csv: meta("load_csv", "DataFrame", [{ name: "path", type: "string" }], "positional_named", "io"),
  register_columns_table: meta("register_columns_table", "string", [{ name: "columns", type: any, rest: true, named: true }], "named"),
  momentum: meta("momentum", "Function", [{ name: "lookback", type: number, optional: true, defaultValue: 20 }]),
  mean_reversion: meta("mean_reversion", "Function", [{ name: "lookback", type: number, optional: true, defaultValue: 20 }]),
  zscore: meta("zscore", "Function", [{ name: "window", type: number, optional: true, defaultValue: 20 }]),
  equal_weight: meta("equal_weight", "Function"),
  cross_sectional: meta("cross_sectional", "Function"),
  long_short: meta("long_short", "Function", [{ name: "fraction", type: number, optional: true, defaultValue: 0.5 }]),
  backtest: meta("backtest", "Object", [{ name: "prices", type: any }, { name: "options", type: any, optional: true, named: true }]),
  walk_forward: meta("walk_forward", "Object", [{ name: "prices", type: any }, { name: "options", type: any, optional: true, named: true }]),
  sharpe: meta("sharpe", number, [{ name: "returns", type: any }]),
  risk_parity: meta("risk_parity", "Array", [{ name: "cov", type: any }]),
  hrp: meta("hrp", "Array", [{ name: "cov", type: any }]),
  mean_variance: meta("mean_variance", "Array", [{ name: "mu", type: any }, { name: "cov", type: any }]),
  range: meta("range", "Array", [{ name: "start", type: number, optional: true }, { name: "stop", type: number, optional: true }, { name: "step", type: number, optional: true, defaultValue: 1 }]),
};

export const CHART_METADATA: Record<string, RuntimeFunctionMetadata> = Object.fromEntries(
  ["line", "bar", "scatter", "histogram", "area", "box", "violin", "density", "correlation", "hexbin", "heatmap", "regression", "ecdf", "bubble", "funnel", "waterfall"].map((name) => [
    name,
    meta(name, "ChartSpec", [
      { name: "data", type: any },
      { name: "x", type: number, optional: true, named: true },
      { name: "y", type: number, optional: true, named: true },
      { name: "bins", type: number, optional: true, named: true },
      { name: "title", type: "string", optional: true, named: true },
      { name: "x_label", type: "string", optional: true, named: true },
      { name: "y_label", type: "string", optional: true, named: true },
      { name: "options", type: any, optional: true, rest: true, named: true },
    ]),
  ]),
);
