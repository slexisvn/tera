import { numeric, ops } from '@slexisvn/mlfw';
import { takeNamed } from './named_args.js';
import { snakeNamedToCamel } from './builtins.js';

export const NUMERIC_DIST_FUNCS = [
  'normal_cdf', 'normal_ppf', 'normal_pdf',
  't_cdf', 't_ppf', 't_pdf',
  'chi2_cdf', 'chi2_ppf', 'chi2_pdf',
  'f_cdf', 'f_ppf', 'f_pdf',
];
export const NUMERIC_SPECIAL_FUNCS = ['erf', 'erfc', 'lgamma', 'gamma'];
export const NUMERIC_TRANSFORM_FUNCS = ['fft', 'ifft', 'qr'];
export const NUMERIC_INTERP_FUNCS = ['linear_interp', 'cubic_spline'];
export const NUMERIC_STATS_TESTS = [
  't_test_1samp', 't_test_ind', 't_test_paired',
  'chi2_gof', 'chi2_independence',
  'ks_test_1samp', 'ks_test_2samp',
  'jarque_bera', 'dagostino_k2', 'anderson_darling', 'mann_whitney_u',
];
export const NUMERIC_TIMESERIES = ['acf', 'pacf', 'ljung_box', 'durbin_watson', 'periodogram'];
export const NUMERIC_ARRAY_OPS = [
  'convolve', 'correlate',
  'rolling_mean', 'rolling_std', 'rolling_sum', 'rolling_min', 'rolling_max',
  'polyfit', 'polyval', 'polyroots',
];
export const NUMERIC_RANDOM = [
  'random_uniform', 'random_normal', 'random_t', 'random_chi2', 'random_exponential',
  'multivariate_normal',
];

const DISTRIBUTIONS = {
  normal: numeric.normal,
  t: numeric.studentT,
  chi2: numeric.chi2,
  f: numeric.fisherF,
};

const INTERP_IMPLS = {
  linear_interp: numeric.linearInterp,
  cubic_spline: numeric.cubicSpline,
};

const STATS_TEST_IMPLS = {
  t_test_1samp: numeric.tTest1Samp,
  t_test_ind: numeric.tTestInd,
  t_test_paired: numeric.tTestPaired,
  chi2_gof: (observed, expected, opts = {}) => numeric.chi2Gof(observed, expected ?? opts.expected, opts),
  chi2_independence: numeric.chi2Independence,
  ks_test_1samp: numeric.ksTest1Samp,
  ks_test_2samp: numeric.ksTest2Samp,
  jarque_bera: numeric.jarqueBera,
  dagostino_k2: numeric.dagostinoK2,
  anderson_darling: numeric.andersonDarling,
  mann_whitney_u: numeric.mannWhitneyU,
};

const TIMESERIES_IMPLS = {
  acf: numeric.acf,
  pacf: numeric.pacf,
  ljung_box: numeric.ljungBox,
  durbin_watson: numeric.durbinWatson,
  periodogram: numeric.periodogram,
};

const ARRAY_OP_IMPLS = {
  convolve: numeric.convolve,
  correlate: numeric.correlate,
  rolling_mean: (x, window, opts = {}) => numeric.rollingMean(x, window ?? opts.window),
  rolling_std: (x, window, opts = {}) => numeric.rollingStd(x, window ?? opts.window, opts),
  rolling_sum: (x, window, opts = {}) => numeric.rollingSum(x, window ?? opts.window),
  rolling_min: (x, window, opts = {}) => numeric.rollingMin(x, window ?? opts.window),
  rolling_max: (x, window, opts = {}) => numeric.rollingMax(x, window ?? opts.window),
  polyfit: (x, y, deg, opts = {}) => numeric.polyfit(x, y, deg ?? opts.deg),
  polyval: numeric.polyval,
  polyroots: numeric.polyroots,
};

const RANDOM_IMPLS = {
  random_uniform: (shape, opts = {}) => new numeric.Generator(opts.seed).uniform(shape, opts),
  random_normal: (shape, opts = {}) => new numeric.Generator(opts.seed).normal(shape, opts),
  random_t: (shape, df, opts = {}) => new numeric.Generator(opts.seed).standardT(shape, { ...opts, df: df ?? opts.df }),
  random_chi2: (shape, df, opts = {}) => new numeric.Generator(opts.seed).chi2(shape, { ...opts, df: df ?? opts.df }),
  random_exponential: (shape, opts = {}) => new numeric.Generator(opts.seed).exponential(shape, opts),
  multivariate_normal: (mean, cov, n, opts = {}) => new numeric.Generator(opts.seed).multivariateNormal(mean, cov, n ?? opts.n ?? 1, opts),
};

function makeOptsCall(fn) {
  return (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    const opts = snakeNamedToCamel(named);
    while (args.length < fn.length) args.push(undefined);
    return fn(...args, opts);
  };
}

function toTeraRecord(value) {
  if (value && typeof value === 'object' && value.constructor === Object) {
    const m = new Map();
    for (const k of Object.keys(value)) {
      const wrapped = toTeraRecord(value[k]);
      m.set(k, wrapped);
      m[k] = wrapped;
    }
    return m;
  }
  return value;
}

function makeRecordCall(fn) {
  const call = makeOptsCall(fn);
  return (...args) => toTeraRecord(call(...args));
}

function makeDistCall(name) {
  const sep = name.lastIndexOf('_');
  return makeOptsCall(DISTRIBUTIONS[name.slice(0, sep)][name.slice(sep + 1)]);
}

export function installNumericBuiltins(define) {
  for (const name of NUMERIC_DIST_FUNCS) define(name, makeDistCall(name));
  for (const name of NUMERIC_SPECIAL_FUNCS) define(name, (...args) => ops[name](...args));
  for (const name of NUMERIC_TRANSFORM_FUNCS) define(name, (...args) => numeric[name](...args));
  for (const name of NUMERIC_INTERP_FUNCS) define(name, (...args) => INTERP_IMPLS[name](...args));
  for (const name of NUMERIC_STATS_TESTS) define(name, makeRecordCall(STATS_TEST_IMPLS[name]));
  for (const name of NUMERIC_TIMESERIES) define(name, makeRecordCall(TIMESERIES_IMPLS[name]));
  for (const name of NUMERIC_ARRAY_OPS) define(name, makeOptsCall(ARRAY_OP_IMPLS[name]));
  for (const name of NUMERIC_RANDOM) define(name, makeOptsCall(RANDOM_IMPLS[name]));
}

const OPT = (name, defaultValue) => ({ name, isOptional: true, defaultValue });

export const NUMERIC_SIGNATURES = {
  normal_cdf: [{ name: 'x' }, OPT('loc', '0'), OPT('scale', '1')],
  normal_ppf: [{ name: 'p' }, OPT('loc', '0'), OPT('scale', '1')],
  normal_pdf: [{ name: 'x' }, OPT('loc', '0'), OPT('scale', '1')],
  t_cdf: [{ name: 'x' }, { name: 'df' }],
  t_ppf: [{ name: 'p' }, { name: 'df' }],
  t_pdf: [{ name: 'x' }, { name: 'df' }],
  chi2_cdf: [{ name: 'x' }, { name: 'df' }],
  chi2_ppf: [{ name: 'p' }, { name: 'df' }],
  chi2_pdf: [{ name: 'x' }, { name: 'df' }],
  f_cdf: [{ name: 'x' }, { name: 'd1' }, { name: 'd2' }],
  f_ppf: [{ name: 'p' }, { name: 'd1' }, { name: 'd2' }],
  f_pdf: [{ name: 'x' }, { name: 'd1' }, { name: 'd2' }],
  erf: [{ name: 'input' }],
  erfc: [{ name: 'input' }],
  lgamma: [{ name: 'input' }],
  gamma: [{ name: 'input' }],
  fft: [{ name: 'input' }],
  ifft: [{ name: 'input' }],
  qr: [{ name: 'input' }],
  linear_interp: [{ name: 'xs' }, { name: 'ys' }, { name: 'xq' }],
  cubic_spline: [{ name: 'xs' }, { name: 'ys' }],
  t_test_1samp: [{ name: 'x' }, OPT('popmean', '0')],
  t_test_ind: [{ name: 'x' }, { name: 'y' }, OPT('equal_var', 'true')],
  t_test_paired: [{ name: 'x' }, { name: 'y' }],
  chi2_gof: [{ name: 'observed' }, OPT('expected', 'null'), OPT('ddof', '0')],
  chi2_independence: [{ name: 'table' }],
  ks_test_1samp: [{ name: 'x' }, OPT('cdf', 'null'), OPT('loc', '0'), OPT('scale', '1')],
  ks_test_2samp: [{ name: 'x' }, { name: 'y' }],
  jarque_bera: [{ name: 'x' }],
  dagostino_k2: [{ name: 'x' }],
  anderson_darling: [{ name: 'x' }],
  mann_whitney_u: [{ name: 'x' }, { name: 'y' }],
  acf: [{ name: 'x' }, OPT('nlags', 'null')],
  pacf: [{ name: 'x' }, OPT('nlags', 'null')],
  ljung_box: [{ name: 'x' }, OPT('lags', 'null'), OPT('model_df', '0')],
  durbin_watson: [{ name: 'x' }],
  periodogram: [{ name: 'x' }, OPT('detrend', 'true')],
  convolve: [{ name: 'a' }, { name: 'b' }, OPT('mode', '"full"')],
  correlate: [{ name: 'a' }, { name: 'b' }, OPT('mode', '"full"')],
  rolling_mean: [{ name: 'x' }, { name: 'window' }],
  rolling_std: [{ name: 'x' }, { name: 'window' }, OPT('ddof', '1')],
  rolling_sum: [{ name: 'x' }, { name: 'window' }],
  rolling_min: [{ name: 'x' }, { name: 'window' }],
  rolling_max: [{ name: 'x' }, { name: 'window' }],
  polyfit: [{ name: 'x' }, { name: 'y' }, { name: 'deg' }],
  polyval: [{ name: 'coeffs' }, { name: 'x' }],
  polyroots: [{ name: 'coeffs' }],
  random_uniform: [{ name: 'shape' }, OPT('low', '0'), OPT('high', '1'), OPT('seed', 'null')],
  random_normal: [{ name: 'shape' }, OPT('loc', '0'), OPT('scale', '1'), OPT('seed', 'null')],
  random_t: [{ name: 'shape' }, { name: 'df' }, OPT('seed', 'null')],
  random_chi2: [{ name: 'shape' }, { name: 'df' }, OPT('seed', 'null')],
  random_exponential: [{ name: 'shape' }, OPT('scale', '1'), OPT('seed', 'null')],
  multivariate_normal: [{ name: 'mean' }, { name: 'cov' }, OPT('n', '1'), OPT('seed', 'null')],
};
