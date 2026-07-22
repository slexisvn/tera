import * as mlfw from "@slexisvn/mlfw";
import * as quantc from "@slexisvn/quantc";
import type { RuntimeFunctionMetadata } from "../../core/value/index.js";
import { camelOptions, nativeRecord, recordValue, register, splitOptions, type BuiltinMap, type NativeFn } from "./common.js";
import { dataframeFromColumns, framePanel, isDataFrame } from "./dataframe-builtins.js";

const quant = quantc as Record<string, unknown>;

export const QUANT_ADVANCED = [
  "deflated_sharpe", "pbo", "min_track_record_length", "quill", "load_quill",
  "adf_test", "kpss_test", "hurst_exponent", "half_life",
  "engle_granger", "johansen",
  "cusum_events", "sadf", "bsadf",
  "kalman_filter", "kalman_smoother", "dynamic_beta",
  "fit_garch", "garch_forecast", "garch_volatility",
  "tick_bars", "volume_bars", "dollar_bars",
  "tick_rule", "roll_spread", "amihud", "kyle_lambda", "vpin",
] as const;

type AlphaArg = { name: string; kind: string; defaultValue?: unknown };
type AlphaSpec = { fn: NativeFn; args: AlphaArg[]; returns: "record" | "bars" | "value" };

const arg = (name: string, kind: string, defaultValue?: unknown): AlphaArg => ({ name, kind, defaultValue });

const ALPHA: Record<string, AlphaSpec> = {
  adf_test: { fn: quant.adfTest as NativeFn, args: [arg("series", "series"), arg("lags", "number", 0), arg("trend", "string", "constant")], returns: "record" },
  kpss_test: { fn: quant.kpssTest as NativeFn, args: [arg("series", "series"), arg("trend", "string", "constant"), arg("lags", "number")], returns: "record" },
  hurst_exponent: { fn: quant.hurstExponent as NativeFn, args: [arg("series", "series"), arg("min_window", "number", 10), arg("max_window", "number"), arg("growth", "number", 1.5)], returns: "value" },
  half_life: { fn: quant.halfLife as NativeFn, args: [arg("series", "series")], returns: "value" },
  engle_granger: { fn: quant.engleGranger as NativeFn, args: [arg("dependent", "series"), arg("regressors", "matrix"), arg("lags", "number", 0)], returns: "record" },
  johansen: { fn: quant.johansen as NativeFn, args: [arg("levels", "matrix"), arg("lags", "number", 1)], returns: "record" },
  cusum_events: { fn: quant.cusumEvents as NativeFn, args: [arg("series", "series"), arg("threshold", "number"), arg("drift", "number", 0)], returns: "value" },
  sadf: { fn: quant.sadfStatistic as NativeFn, args: [arg("series", "series"), arg("min_window", "number", 20), arg("lags", "number", 0), arg("trend", "string", "constant")], returns: "value" },
  bsadf: { fn: quant.bsadfSeries as NativeFn, args: [arg("series", "series"), arg("min_window", "number", 20), arg("lags", "number", 0), arg("trend", "string", "constant")], returns: "value" },
  kalman_filter: { fn: quant.kalmanFilter as NativeFn, args: [arg("observations", "series"), arg("observation_vectors", "matrix"), arg("spec", "object")], returns: "record" },
  kalman_smoother: { fn: quant.kalmanSmoother as NativeFn, args: [arg("observations", "series"), arg("observation_vectors", "matrix"), arg("spec", "object")], returns: "value" },
  dynamic_beta: { fn: quant.dynamicBeta as NativeFn, args: [arg("dependent", "series"), arg("regressors", "matrix"), arg("config", "options")], returns: "record" },
  fit_garch: { fn: quant.fitGarch as NativeFn, args: [arg("returns", "series"), arg("options", "options")], returns: "record" },
  garch_forecast: { fn: quant.garchForecast as NativeFn, args: [arg("returns", "series"), arg("params", "object"), arg("horizon", "number"), arg("initial_variance", "number")], returns: "value" },
  garch_volatility: { fn: quant.garchVolatility as NativeFn, args: [arg("returns", "series"), arg("params", "object"), arg("initial_variance", "number")], returns: "value" },
  tick_bars: { fn: quant.tickBars as NativeFn, args: [arg("ticks", "ticks"), arg("ticks_per_bar", "number")], returns: "bars" },
  volume_bars: { fn: quant.volumeBars as NativeFn, args: [arg("ticks", "ticks"), arg("volume_per_bar", "number")], returns: "bars" },
  dollar_bars: { fn: quant.dollarBars as NativeFn, args: [arg("ticks", "ticks"), arg("dollar_per_bar", "number")], returns: "bars" },
  tick_rule: { fn: quant.tickRule as NativeFn, args: [arg("prices", "series")], returns: "value" },
  roll_spread: { fn: quant.rollSpread as NativeFn, args: [arg("prices", "series")], returns: "value" },
  amihud: { fn: quant.amihudIlliquidity as NativeFn, args: [arg("returns", "series"), arg("dollar_volumes", "series")], returns: "value" },
  kyle_lambda: { fn: quant.kyleLambda as NativeFn, args: [arg("prices", "series"), arg("volumes", "series")], returns: "value" },
  vpin: { fn: quant.vpin as NativeFn, args: [arg("ticks", "ticks"), arg("bucket_volume", "number"), arg("window", "number", 50)], returns: "value" },
};

function tensorArray(data: unknown): unknown {
  if (data && typeof data === "object" && typeof (data as { toArray?: unknown }).toArray === "function") return (data as { toArray(): unknown }).toArray();
  return data;
}

function priceMatrix(data: unknown): unknown {
  if (data && typeof data === "object" && Array.isArray((data as { __matrix?: unknown }).__matrix)) {
    return (data as { __matrix: unknown[] }).__matrix.map((row) => Array.isArray(row) ? row.map(Number) : row);
  }
  return tensorArray(data);
}

function series(value: unknown): number[] {
  const data = priceMatrix(value);
  if (Array.isArray(data) && Array.isArray(data[0])) return (data as unknown[][]).map((row) => Number(row[0]));
  if (Array.isArray(data)) return data.map(Number);
  throw new Error("expected a numeric series");
}

function matrix(value: unknown): number[][] {
  const data = priceMatrix(value);
  if (Array.isArray(data)) return data.map((row) => Array.isArray(row) ? row.map(Number) : [Number(row)]);
  throw new Error("expected a numeric matrix");
}

function ticks(value: unknown): Array<{ price: number; volume: number }> {
  const rows = value && typeof value === "object" && Array.isArray((value as { __rows?: unknown }).__rows) ? (value as { __rows: unknown[] }).__rows : value;
  if (!Array.isArray(rows)) throw new Error("expected ticks as rows with price/volume");
  return rows.map((tick) => {
    const row = nativeRecord(tick);
    return { price: Number(row.price), volume: Number(row.volume) };
  });
}

function coerce(kind: string, value: unknown, options: Record<string, unknown>): unknown {
  if (kind === "options") return camelOptions(options);
  if (value === undefined || value === null) return value;
  if (kind === "series") return series(value);
  if (kind === "matrix") return matrix(value);
  if (kind === "ticks") return ticks(value);
  if (kind === "object") return camelOptions(nativeRecord(value));
  if (kind === "number") return Number(value);
  if (kind === "string") return String(value);
  return value;
}

function alpha(name: string): NativeFn {
  const spec = ALPHA[name]!;
  return (...args) => {
    const { values, options } = splitOptions(args);
    const callArgs = spec.args.map((param, index) => coerce(param.kind, values[index] ?? options[param.name] ?? param.defaultValue, options));
    const result = spec.fn(...callArgs);
    if (spec.returns === "record") return recordValue(result);
    return result;
  };
}

function quantFunction(name: unknown, fallback: string, ...args: unknown[]): unknown {
  if (typeof name === "function") return name;
  const aliases: Record<string, string> = {
    long_short: "longShortRank",
    mean_reversion: "meanReversion",
    equal_weight: "equalWeight",
    risk_parity: "riskParity",
    mean_variance: "meanVariance",
    cross_sectional: "crossSectional",
  };
  const key = typeof name === "string" ? aliases[name] ?? name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) : fallback;
  const candidate = quant[key];
  if (typeof candidate !== "function") throw new Error(`Unknown quant function '${String(name)}'`);
  return (candidate as NativeFn)(...args);
}

export function backtestConfig(options: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (options.cost !== undefined) config.cost = options.cost;
  if (options.max_leverage !== undefined) config.maxLeverage = options.max_leverage;
  if (options.start !== undefined) config.start = options.start;
  if (options.periods_per_year !== undefined) config.periodsPerYear = options.periods_per_year;
  if (options.folds !== undefined) config.folds = options.folds;
  if (options.min_train_fraction !== undefined) config.minTrainFraction = options.min_train_fraction;
  return config;
}

function withPanel<T>(value: unknown, use: (panel: number[][]) => T, columns?: string[]): T | Promise<T> {
  if (isDataFrame(value)) return framePanel(value, columns).then(use);
  return use(matrix(value));
}

function withCovariance<T>(value: unknown, use: (cov: number[][]) => T): T | Promise<T> {
  const sample = (quant.sampleCovariance as NativeFn);
  return withPanel(value, isDataFrame(value) ? (panel) => use(sample(panel) as number[][]) : use);
}

export function resultToTera(result: unknown): unknown {
  const run = result as { metrics: unknown; equity: number[]; weights: unknown; portReturns: number[] };
  return {
    metrics: run.metrics,
    equity: dataframeFromColumns({ equity: run.equity }),
    weights: run.weights,
    port_returns: dataframeFromColumns({ port_return: run.portReturns }),
  };
}

function runBacktest(walkForward: boolean, prices: unknown, ...args: unknown[]): unknown {
  const { options } = splitOptions(args);
  const signal = quantFunction(options.signal, "momentum", Number(options.lookback ?? 20));
  const portfolio = quantFunction(options.portfolio, "longShortRank", Number(options.fraction ?? 0.5));
  const strategy = (quant.compose as NativeFn)(signal, portfolio);
  const config = backtestConfig(options);
  const columns = Array.isArray(options.asset_columns) ? options.asset_columns.map(String) : undefined;
  return withPanel(prices, (panel) => resultToTera(
    walkForward
      ? (quant.walkForward as NativeFn)(panel, () => strategy, config)
      : (quant.backtest as NativeFn)(panel, strategy, config),
  ), columns);
}

function parseAndCheck(source: unknown): unknown {
  if (typeof source !== "string") throw new Error("expected Quill product source as a string");
  const product = (quant.parseProduct as NativeFn)(source);
  const errors = (quant.checkProduct as NativeFn)(product) as Array<{ line: number; col: number; message: string }>;
  if (errors.length > 0) throw new Error(`Quill type errors:\n${errors.map((e) => `  line ${e.line}:${e.col} ${e.message}`).join("\n")}`);
  return product;
}

function market(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["spot", "vol", "spots", "vols", "params", "correlation", "curve"]) if (options[key] !== undefined) out[key] = options[key];
  if (options.model_params !== undefined) out.modelParams = options.model_params;
  if (options.rate === undefined) throw new Error("price() requires a rate, e.g. price(rate=0.03, spot=100, vol=0.2)");
  out.rate = options.rate;
  return out;
}

function productHandle(product: unknown): unknown {
  return recordValue({
    name: (product as { name?: unknown }).name ?? null,
    price: (...args: unknown[]) => {
      const { options } = splitOptions(args);
      const result = (quant.priceProduct as NativeFn)(product, market(options), options.paths ?? 100000, options.seed ?? 1, options.greeks !== undefined ? { greeks: options.greeks } : {});
      const priced = result as { price: unknown; standardError: unknown; greeks: unknown };
      return recordValue({ price: priced.price, standard_error: priced.standardError, greeks: priced.greeks });
    },
  });
}

function loadQuill(path: unknown): unknown {
  if (typeof path !== "string") throw new Error("load_quill() requires a file path string");
  const data = (mlfw.memfs as { readFile(path: string): string | Uint8Array }).readFile(path);
  return productHandle(parseAndCheck(typeof data === "string" ? data : new TextDecoder().decode(data)));
}

export function installQuantBuiltins(map: BuiltinMap, metadata: Record<string, RuntimeFunctionMetadata>): void {
  const fn = (name: string): NativeFn => quant[name] as NativeFn;
  register(map, "momentum", (...args) => fn("momentum")(Number(splitOptions(args).options.lookback ?? args[0] ?? 20)), metadata.momentum);
  register(map, "mean_reversion", (...args) => fn("meanReversion")(Number(splitOptions(args).options.lookback ?? args[0] ?? 20)), metadata.mean_reversion);
  register(map, "zscore", (...args) => fn("zscore")(Number(splitOptions(args).options.window ?? args[0] ?? 20)), metadata.zscore);
  register(map, "equal_weight", () => fn("equalWeight")(), metadata.equal_weight);
  register(map, "cross_sectional", () => fn("crossSectional")(), metadata.cross_sectional);
  register(map, "long_short", (...args) => fn("longShortRank")(Number(splitOptions(args).options.fraction ?? args[0] ?? 0.5)), metadata.long_short);
  register(map, "backtest", (prices, ...args) => runBacktest(false, prices, ...args), metadata.backtest);
  register(map, "walk_forward", (prices, ...args) => runBacktest(true, prices, ...args), metadata.walk_forward);
  register(map, "sharpe", (returns, ...args) => fn("sharpe")(series(returns), splitOptions(args).options.periods_per_year ?? args[0]), metadata.sharpe);
  register(map, "deflated_sharpe", (returns, ...args) => fn("deflatedSharpe")(series(returns), splitOptions(args).options.trial_sharpes ?? args[0] ?? []), metadata.deflated_sharpe);
  register(map, "pbo", (returns, ...args) => fn("probabilityOfBacktestOverfitting")(matrix(returns), splitOptions(args).options.partitions ?? args[0]), metadata.pbo);
  register(map, "min_track_record_length", (returns, ...args) => {
    const { values, options } = splitOptions(args);
    return fn("minTrackRecordLength")(series(returns), options.target_sharpe ?? values[0], options.confidence ?? values[1]);
  }, metadata.min_track_record_length);
  register(map, "risk_parity", (cov) => withCovariance(cov, (c) => fn("riskParity")(c)), metadata.risk_parity);
  register(map, "hrp", (cov) => withCovariance(cov, (c) => fn("hierarchicalRiskParity")(c)), metadata.hrp);
  register(map, "mean_variance", (mu, cov) => withCovariance(cov, (c) => fn("meanVariance")(mu, c)), metadata.mean_variance);
  register(map, "quill", (source) => productHandle(parseAndCheck(source)), metadata.quill);
  register(map, "load_quill", loadQuill, metadata.load_quill);
  for (const name of QUANT_ADVANCED) if (ALPHA[name]) register(map, name, alpha(name), metadata[name]);
}
