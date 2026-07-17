import * as mlfw from "@slexisvn/mlfw";
import type { RuntimeFunctionMetadata } from "../../core/value/index.js";
import { camelOptions, recordValue, register, splitOptions, type BuiltinMap, type NativeFn } from "./common.js";

const numeric = (mlfw as Record<string, unknown>).numeric as Record<string, unknown>;
const ops = (mlfw as Record<string, unknown>).ops as Record<string, unknown>;

export const NUMERIC_DIST_FUNCS = [
  "normal_cdf", "normal_ppf", "normal_pdf",
  "t_cdf", "t_ppf", "t_pdf",
  "chi2_cdf", "chi2_ppf", "chi2_pdf",
  "f_cdf", "f_ppf", "f_pdf",
] as const;
export const NUMERIC_SPECIAL_FUNCS = ["erf", "erfc", "lgamma", "gamma"] as const;
export const NUMERIC_TRANSFORM_FUNCS = ["fft", "ifft", "qr"] as const;
export const NUMERIC_INTERP_FUNCS = ["linear_interp", "cubic_spline"] as const;
export const NUMERIC_STATS_TESTS = [
  "t_test_1samp", "t_test_ind", "t_test_paired",
  "chi2_gof", "chi2_independence",
  "ks_test_1samp", "ks_test_2samp",
  "jarque_bera", "dagostino_k2", "anderson_darling", "mann_whitney_u",
] as const;
export const NUMERIC_TIMESERIES = ["acf", "pacf", "ljung_box", "durbin_watson", "periodogram"] as const;
export const NUMERIC_ARRAY_OPS = [
  "convolve", "correlate",
  "rolling_mean", "rolling_std", "rolling_sum", "rolling_min", "rolling_max",
  "polyfit", "polyval", "polyroots",
] as const;
export const NUMERIC_RANDOM = [
  "random_uniform", "random_normal", "random_t", "random_chi2", "random_exponential",
  "multivariate_normal",
] as const;

const DISTRIBUTIONS: Record<string, Record<string, NativeFn>> = {
  normal: numeric.normal as Record<string, NativeFn>,
  t: numeric.studentT as Record<string, NativeFn>,
  chi2: numeric.chi2 as Record<string, NativeFn>,
  f: numeric.fisherF as Record<string, NativeFn>,
};

const INTERP_IMPLS: Record<string, NativeFn> = {
  linear_interp: numeric.linearInterp as NativeFn,
  cubic_spline: numeric.cubicSpline as NativeFn,
};

const STATS_TEST_IMPLS: Record<string, NativeFn> = {
  t_test_1samp: numeric.tTest1Samp as NativeFn,
  t_test_ind: numeric.tTestInd as NativeFn,
  t_test_paired: numeric.tTestPaired as NativeFn,
  chi2_gof: (observed, expected, opts = {}) => (numeric.chi2Gof as NativeFn)(observed, expected ?? (opts as Record<string, unknown>).expected, opts),
  chi2_independence: numeric.chi2Independence as NativeFn,
  ks_test_1samp: numeric.ksTest1Samp as NativeFn,
  ks_test_2samp: numeric.ksTest2Samp as NativeFn,
  jarque_bera: numeric.jarqueBera as NativeFn,
  dagostino_k2: numeric.dagostinoK2 as NativeFn,
  anderson_darling: numeric.andersonDarling as NativeFn,
  mann_whitney_u: numeric.mannWhitneyU as NativeFn,
};

const TIMESERIES_IMPLS: Record<string, NativeFn> = {
  acf: numeric.acf as NativeFn,
  pacf: numeric.pacf as NativeFn,
  ljung_box: numeric.ljungBox as NativeFn,
  durbin_watson: numeric.durbinWatson as NativeFn,
  periodogram: numeric.periodogram as NativeFn,
};

function namedWindow(window: unknown, opts: unknown): { value: unknown; options: Record<string, unknown> } {
  if (window && typeof window === "object" && !Array.isArray(window)) return { value: (window as Record<string, unknown>).window, options: window as Record<string, unknown> };
  return { value: window ?? (opts as Record<string, unknown>).window, options: opts as Record<string, unknown> };
}

const ARRAY_OP_IMPLS: Record<string, NativeFn> = {
  convolve: numeric.convolve as NativeFn,
  correlate: numeric.correlate as NativeFn,
  rolling_mean: (x, window, opts = {}) => (numeric.rollingMean as NativeFn)(x, namedWindow(window, opts).value),
  rolling_std: (x, window, opts = {}) => {
    const named = namedWindow(window, opts);
    return (numeric.rollingStd as NativeFn)(x, named.value, named.options);
  },
  rolling_sum: (x, window, opts = {}) => (numeric.rollingSum as NativeFn)(x, namedWindow(window, opts).value),
  rolling_min: (x, window, opts = {}) => (numeric.rollingMin as NativeFn)(x, namedWindow(window, opts).value),
  rolling_max: (x, window, opts = {}) => (numeric.rollingMax as NativeFn)(x, namedWindow(window, opts).value),
  polyfit: (x, y, deg, opts = {}) => {
    const value = deg && typeof deg === "object" && !Array.isArray(deg) ? (deg as Record<string, unknown>).deg : deg ?? (opts as Record<string, unknown>).deg;
    return (numeric.polyfit as NativeFn)(x, y, value);
  },
  polyval: numeric.polyval as NativeFn,
  polyroots: numeric.polyroots as NativeFn,
};

type GeneratorLike = Record<string, NativeFn>;
const Generator = numeric.Generator as new (seed?: never) => GeneratorLike;

const RANDOM_IMPLS: Record<string, NativeFn> = {
  random_uniform: (shape, opts = {}) => new Generator((opts as Record<string, unknown>).seed as never).uniform(shape as never, opts as never),
  random_normal: (shape, opts = {}) => new Generator((opts as Record<string, unknown>).seed as never).normal(shape as never, opts as never),
  random_t: (shape, df, opts = {}) => new Generator((opts as Record<string, unknown>).seed as never).standardT(shape as never, { ...(opts as object), df: df ?? (opts as Record<string, unknown>).df } as never),
  random_chi2: (shape, df, opts = {}) => new Generator((opts as Record<string, unknown>).seed as never).chi2(shape as never, { ...(opts as object), df: df ?? (opts as Record<string, unknown>).df } as never),
  random_exponential: (shape, opts = {}) => new Generator((opts as Record<string, unknown>).seed as never).exponential(shape as never, opts as never),
  multivariate_normal: (mean, cov, n, opts = {}) => new Generator((opts as Record<string, unknown>).seed as never).multivariateNormal(mean as never, cov as never, (n ?? (opts as Record<string, unknown>).n ?? 1) as never, opts as never),
};

function optsCall(fn: NativeFn): NativeFn {
  return (...args) => {
    const { values, options } = splitOptions(args);
    while (values.length < Math.max(0, fn.length - 1)) values.push(undefined);
    return fn(...values, camelOptions(options));
  };
}

function recordCall(fn: NativeFn): NativeFn {
  const call = optsCall(fn);
  return (...args) => recordValue(call(...args));
}

function distCall(name: string): NativeFn {
  const sep = name.lastIndexOf("_");
  return optsCall(DISTRIBUTIONS[name.slice(0, sep)]![name.slice(sep + 1)]!);
}

export function installNumericBuiltins(map: BuiltinMap, metadata: Record<string, RuntimeFunctionMetadata>): void {
  for (const name of NUMERIC_DIST_FUNCS) register(map, name, distCall(name), metadata[name]);
  for (const name of NUMERIC_SPECIAL_FUNCS) register(map, name, (...args) => (ops[name] as NativeFn)(...args), metadata[name]);
  for (const name of NUMERIC_TRANSFORM_FUNCS) register(map, name, (...args) => (numeric[name] as NativeFn)(...args), metadata[name]);
  for (const name of NUMERIC_INTERP_FUNCS) register(map, name, (...args) => INTERP_IMPLS[name](...args), metadata[name]);
  for (const name of NUMERIC_STATS_TESTS) register(map, name, recordCall(STATS_TEST_IMPLS[name]), metadata[name]);
  for (const name of NUMERIC_TIMESERIES) register(map, name, recordCall(TIMESERIES_IMPLS[name]), metadata[name]);
  for (const name of NUMERIC_ARRAY_OPS) register(map, name, optsCall(ARRAY_OP_IMPLS[name]), metadata[name]);
  for (const name of NUMERIC_RANDOM) register(map, name, optsCall(RANDOM_IMPLS[name]), metadata[name]);
}
