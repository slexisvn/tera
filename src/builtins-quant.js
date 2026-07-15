import {
  backtest as qBacktest, walkForward as qWalkForward, compose,
  momentum, meanReversion, zscore,
  equalWeight, crossSectional, longShortRank, meanVariance,
  sharpe as qSharpe, deflatedSharpe, minTrackRecordLength, probabilityOfBacktestOverfitting,
  riskParity, hierarchicalRiskParity, sampleCovariance,
  parseProduct, checkProduct, priceProduct,
  adfTest, kpssTest, hurstExponent, halfLife,
  engleGranger, johansen,
  cusumEvents, sadfStatistic, bsadfSeries,
  kalmanFilter, kalmanSmoother, dynamicBeta,
  fitGarch, garchForecast, garchVolatility,
  tickBars, volumeBars, dollarBars,
  tickRule, rollSpread, amihudIlliquidity, kyleLambda, vpin,
} from '@slexisvn/quantc';

export const QUANT_STATIONARITY = ['adf_test', 'kpss_test', 'hurst_exponent', 'half_life'];
export const QUANT_COINTEGRATION = ['engle_granger', 'johansen'];
export const QUANT_STRUCTURAL = ['cusum_events', 'sadf', 'bsadf'];
export const QUANT_KALMAN = ['kalman_filter', 'kalman_smoother', 'dynamic_beta'];
export const QUANT_GARCH = ['fit_garch', 'garch_forecast', 'garch_volatility'];
export const QUANT_BARS = ['tick_bars', 'volume_bars', 'dollar_bars'];
export const QUANT_MICROSTRUCTURE = ['tick_rule', 'roll_spread', 'amihud', 'kyle_lambda', 'vpin'];

const arg = (n, k, dv) => ({ n, k, dv });

const ALPHA_REGISTRY = {
  adf_test: { fn: adfTest, args: [arg('series', 'series'), arg('lags', 'num', '0'), arg('trend', 'str', '"constant"')], ret: 'record' },
  kpss_test: { fn: kpssTest, args: [arg('series', 'series'), arg('trend', 'str', '"constant"'), arg('lags', 'num', '?')], ret: 'record' },
  hurst_exponent: { fn: hurstExponent, args: [arg('series', 'series'), arg('min_window', 'num', '10'), arg('max_window', 'num', '?'), arg('growth', 'num', '1.5')], ret: 'num' },
  half_life: { fn: halfLife, args: [arg('series', 'series')], ret: 'num' },
  engle_granger: { fn: engleGranger, args: [arg('dependent', 'series'), arg('regressors', 'matrix'), arg('lags', 'num', '0')], ret: 'record' },
  johansen: { fn: johansen, args: [arg('levels', 'matrix'), arg('lags', 'num', '1')], ret: 'record' },
  cusum_events: { fn: cusumEvents, args: [arg('series', 'series'), arg('threshold', 'num'), arg('drift', 'num', '0')], ret: 'arr' },
  sadf: { fn: sadfStatistic, args: [arg('series', 'series'), arg('min_window', 'num', '20'), arg('lags', 'num', '0'), arg('trend', 'str', '"constant"')], ret: 'num' },
  bsadf: { fn: bsadfSeries, args: [arg('series', 'series'), arg('min_window', 'num', '20'), arg('lags', 'num', '0'), arg('trend', 'str', '"constant"')], ret: 'arr' },
  kalman_filter: { fn: kalmanFilter, args: [arg('observations', 'series'), arg('observation_vectors', 'matrix'), arg('spec', 'obj')], ret: 'record' },
  kalman_smoother: { fn: kalmanSmoother, args: [arg('observations', 'series'), arg('observation_vectors', 'matrix'), arg('spec', 'obj')], ret: 'matrix' },
  dynamic_beta: { fn: dynamicBeta, args: [arg('dependent', 'series'), arg('regressors', 'matrix'), arg('config', 'opts', '?')], ret: 'record' },
  fit_garch: { fn: fitGarch, args: [arg('returns', 'series'), arg('options', 'opts', '?')], ret: 'record' },
  garch_forecast: { fn: garchForecast, args: [arg('returns', 'series'), arg('params', 'obj'), arg('horizon', 'num'), arg('initial_variance', 'num', '?')], ret: 'arr' },
  garch_volatility: { fn: garchVolatility, args: [arg('returns', 'series'), arg('params', 'obj'), arg('initial_variance', 'num', '?')], ret: 'arr' },
  tick_bars: { fn: tickBars, args: [arg('ticks', 'ticks'), arg('ticks_per_bar', 'num')], ret: 'bars' },
  volume_bars: { fn: volumeBars, args: [arg('ticks', 'ticks'), arg('volume_per_bar', 'num')], ret: 'bars' },
  dollar_bars: { fn: dollarBars, args: [arg('ticks', 'ticks'), arg('dollar_per_bar', 'num')], ret: 'bars' },
  tick_rule: { fn: tickRule, args: [arg('prices', 'series')], ret: 'arr' },
  roll_spread: { fn: rollSpread, args: [arg('prices', 'series')], ret: 'num' },
  amihud: { fn: amihudIlliquidity, args: [arg('returns', 'series'), arg('dollar_volumes', 'series')], ret: 'num' },
  kyle_lambda: { fn: kyleLambda, args: [arg('prices', 'series'), arg('volumes', 'series')], ret: 'num' },
  vpin: { fn: vpin, args: [arg('ticks', 'ticks'), arg('bucket_volume', 'num'), arg('window', 'num', '50')], ret: 'arr' },
};

function toTeraValue(value) {
  if (Array.isArray(value)) return value.map(toTeraValue);
  if (value && typeof value === 'object' && !(value instanceof Map)) {
    const map = new Map();
    for (const [key, inner] of Object.entries(value)) {
      const wrapped = toTeraValue(inner);
      map.set(key, wrapped);
      map[key] = wrapped;
    }
    return map;
  }
  return value;
}

const DEFAULT_SIGNAL = 'momentum';
const DEFAULT_PORTFOLIO = 'long_short';
const DEFAULT_PATHS = 100000;
const DEFAULT_SEED = 1;

const SIGNAL_RESOLVERS = {
  momentum: named => momentum(named.lookback),
  mean_reversion: named => meanReversion(named.lookback),
  zscore: named => zscore(named.window),
};

const PORTFOLIO_RESOLVERS = {
  equal_weight: () => equalWeight(),
  cross_sectional: () => crossSectional(),
  long_short: named => longShortRank(named.fraction),
};

function resolveSignal(spec, named) {
  if (typeof spec === 'function') return spec;
  const factory = SIGNAL_RESOLVERS[spec];
  if (!factory) throw new Error(`Unknown signal '${spec}'; expected one of ${Object.keys(SIGNAL_RESOLVERS).join(', ')} or a signal handle`);
  return factory(named);
}

function resolvePortfolio(spec, named) {
  if (typeof spec === 'function') return spec;
  const factory = PORTFOLIO_RESOLVERS[spec];
  if (!factory) throw new Error(`Unknown portfolio '${spec}'; expected one of ${Object.keys(PORTFOLIO_RESOLVERS).join(', ')} or a portfolio handle`);
  return factory(named);
}

function backtestConfig(named) {
  const config = {};
  if (named.cost !== undefined) config.cost = named.cost;
  if (named.max_leverage !== undefined) config.maxLeverage = named.max_leverage;
  if (named.start !== undefined) config.start = named.start;
  if (named.periods_per_year !== undefined) config.periodsPerYear = named.periods_per_year;
  return config;
}

function toPlainObject(value) {
  return value instanceof Map ? Object.fromEntries(value) : value;
}

function parseAndCheck(source) {
  if (typeof source !== 'string') throw new Error('expected Quill product source as a string');
  const product = parseProduct(source);
  const errors = checkProduct(product);
  if (errors.length > 0) throw new Error(`Quill type errors:\n${errors.map(e => `  line ${e.line}:${e.col} ${e.message}`).join('\n')}`);
  return product;
}

function buildMarket(named) {
  const market = {};
  if (named.spot !== undefined) market.spot = named.spot;
  if (named.vol !== undefined) market.vol = named.vol;
  if (named.spots !== undefined) market.spots = toPlainObject(named.spots);
  if (named.vols !== undefined) market.vols = toPlainObject(named.vols);
  if (named.params !== undefined) market.params = toPlainObject(named.params);
  if (named.model_params !== undefined) market.modelParams = toPlainObject(named.model_params);
  if (named.correlation !== undefined) market.correlation = named.correlation;
  if (named.curve !== undefined) market.curve = named.curve;
  if (named.rate === undefined) throw new Error('price() requires a rate, e.g. price(rate=0.03, spot=100, vol=0.2)');
  market.rate = named.rate;
  return market;
}

function makeProductHandle(takeNamed, product) {
  return teraRecord({
    name: product.name ?? null,
    price: (...args) => {
      const named = takeNamed(args);
      const market = buildMarket(named);
      const paths = named.paths ?? DEFAULT_PATHS;
      const seed = named.seed ?? DEFAULT_SEED;
      const options = named.greeks !== undefined ? { greeks: named.greeks } : {};
      const result = priceProduct(product, market, paths, seed, options);
      return teraRecord({ price: result.price, standard_error: result.standardError, greeks: teraRecord(result.greeks) });
    },
  });
}

export function installQuantBuiltins(define, ctx) {
  const { takeNamed, DataFrame, createDataFrame, fs, snakeNamedToCamel } = ctx;

  async function dfToPanel(df, assetColumns) {
    const rows = await df.collect();
    const names = assetColumns ?? numericColumns(df, rows);
    const t = rows.length;
    const n = names.length;
    const panel = new Array(t);
    for (let i = 0; i < t; i += 1) {
      const out = new Array(n);
      for (let j = 0; j < n; j += 1) out[j] = Number(rows[i][names[j]]);
      panel[i] = out;
    }
    return panel;
  }

  function numericColumns(df, rows) {
    const cols = df.columns();
    if (rows.length === 0) return cols;
    return cols.filter(name => typeof rows[0][name] === 'number');
  }

  function resultToTera(result) {
    return teraRecord({
      metrics: teraRecord(result.metrics),
      equity: createDataFrame(result.equity.map(value => ({ equity: value }))),
      weights: result.weights,
      port_returns: createDataFrame(result.portReturns.map(value => ({ port_return: value }))),
    });
  }

  async function toReturnSeries(value) {
    if (value instanceof DataFrame) return (await dfToPanel(value)).map(row => row[0]);
    if (Array.isArray(value)) return value.map(Number);
    throw new Error('expected a returns array or a DataFrame');
  }

  async function toMatrix(value) {
    if (value instanceof DataFrame) return dfToPanel(value);
    if (Array.isArray(value)) return value.map(row => (Array.isArray(row) ? row.map(Number) : [Number(row)]));
    throw new Error('expected a matrix or a DataFrame');
  }

  async function toCovariance(value) {
    if (value instanceof DataFrame) return sampleCovariance(await dfToPanel(value));
    if (Array.isArray(value)) return value.map(row => row.map(Number));
    throw new Error('expected a covariance matrix or a returns DataFrame');
  }

  async function runBacktest(args, walkForward) {
    const named = takeNamed(args);
    const df = args[0];
    if (!(df instanceof DataFrame)) throw new Error(`${walkForward ? 'walk_forward' : 'backtest'}() requires a price DataFrame as the first argument`);
    const prices = await dfToPanel(df, named.asset_columns);
    const signal = resolveSignal(named.signal ?? args[1] ?? DEFAULT_SIGNAL, named);
    const portfolio = resolvePortfolio(named.portfolio ?? DEFAULT_PORTFOLIO, named);
    const config = backtestConfig(named);
    if (!walkForward) return resultToTera(qBacktest(prices, compose(signal, portfolio), config));
    if (named.folds !== undefined) config.folds = named.folds;
    if (named.min_train_fraction !== undefined) config.minTrainFraction = named.min_train_fraction;
    return resultToTera(qWalkForward(prices, () => compose(signal, portfolio), config));
  }

  define('backtest', (...args) => runBacktest(args, false));
  define('walk_forward', (...args) => runBacktest(args, true));

  define('momentum', (...args) => momentum(takeNamed(args).lookback ?? args[0]));
  define('mean_reversion', (...args) => meanReversion(takeNamed(args).lookback ?? args[0]));
  define('zscore', (...args) => zscore(takeNamed(args).window ?? args[0]));
  define('equal_weight', () => equalWeight());
  define('cross_sectional', () => crossSectional());
  define('long_short', (...args) => longShortRank(takeNamed(args).fraction ?? args[0]));

  define('sharpe', async (...args) => {
    const named = takeNamed(args);
    return qSharpe(await toReturnSeries(args[0]), named.periods_per_year ?? args[1]);
  });
  define('deflated_sharpe', async (...args) => {
    const named = takeNamed(args);
    return deflatedSharpe(await toReturnSeries(args[0]), named.trial_sharpes ?? args[1] ?? []);
  });
  define('pbo', async (...args) => {
    const named = takeNamed(args);
    return probabilityOfBacktestOverfitting(await toMatrix(args[0]), named.partitions ?? args[1]);
  });
  define('min_track_record_length', async (...args) => {
    const named = takeNamed(args);
    return minTrackRecordLength(await toReturnSeries(args[0]), named.target_sharpe ?? args[1], named.confidence ?? args[2]);
  });

  define('risk_parity', async (...args) => riskParity(await toCovariance(args[0])));
  define('hrp', async (...args) => hierarchicalRiskParity(await toCovariance(args[0])));
  define('mean_variance', async (...args) => {
    const named = takeNamed(args);
    return meanVariance(named.mu ?? args[0], await toCovariance(named.cov ?? args[1]));
  });

  define('quill', source => makeProductHandle(takeNamed, parseAndCheck(source)));
  define('load_quill', path => {
    if (typeof path !== 'string') throw new Error('load_quill() requires a file path string');
    const data = fs.readFile(path);
    const source = typeof data === 'string' ? data : new TextDecoder().decode(data);
    return makeProductHandle(takeNamed, parseAndCheck(source));
  });

  async function toTicks(value) {
    if (value instanceof DataFrame) {
      const ticks = await value.collect();
      return ticks.map(row => ({ price: Number(row.price), volume: Number(row.volume) }));
    }
    if (Array.isArray(value)) {
      return value.map(tick => {
        const row = tick instanceof Map ? Object.fromEntries(tick) : tick;
        return { price: Number(row.price), volume: Number(row.volume) };
      });
    }
    throw new Error('expected ticks as a DataFrame with price/volume columns or a list of {price, volume}');
  }

  function toCamelObject(value) {
    if (value instanceof Map) return snakeNamedToCamel(Object.fromEntries(value));
    return snakeNamedToCamel(value);
  }

  function trailingOptions(named) {
    const rest = { ...named };
    delete rest.__named;
    return snakeNamedToCamel(rest);
  }

  async function coerceInput(kind, raw, named) {
    if (kind === 'opts') return trailingOptions(named);
    if (raw === undefined || raw === null) return raw;
    switch (kind) {
      case 'series': return toReturnSeries(raw);
      case 'matrix': return toMatrix(raw);
      case 'cov': return toCovariance(raw);
      case 'ticks': return toTicks(raw);
      case 'obj': return toCamelObject(raw);
      case 'num': return Number(raw);
      case 'arr': return Array.isArray(raw) ? raw.map(Number) : raw;
      default: return raw;
    }
  }

  function coerceOutput(ret, value) {
    if (ret === 'record') return toTeraValue(value);
    if (ret === 'bars') return createDataFrame(value);
    return value;
  }

  function alphaBuiltin(name) {
    const spec = ALPHA_REGISTRY[name];
    if (!spec) throw new Error(`missing alpha registry entry for '${name}'`);
    return async (...callArgs) => {
      const named = takeNamed(callArgs);
      const values = [];
      for (let i = 0; i < spec.args.length; i++) {
        const p = spec.args[i];
        const raw = p.k === 'opts' ? undefined : (callArgs[i] !== undefined ? callArgs[i] : named[p.n]);
        values.push(await coerceInput(p.k, raw, named));
      }
      return coerceOutput(spec.ret, spec.fn(...values));
    };
  }

  for (const name of QUANT_STATIONARITY) define(name, alphaBuiltin(name));
  for (const name of QUANT_COINTEGRATION) define(name, alphaBuiltin(name));
  for (const name of QUANT_STRUCTURAL) define(name, alphaBuiltin(name));
  for (const name of QUANT_KALMAN) define(name, alphaBuiltin(name));
  for (const name of QUANT_GARCH) define(name, alphaBuiltin(name));
  for (const name of QUANT_BARS) define(name, alphaBuiltin(name));
  for (const name of QUANT_MICROSTRUCTURE) define(name, alphaBuiltin(name));
}

function teraRecord(source) {
  const map = new Map(source instanceof Map ? source : Object.entries(source));
  for (const [key, value] of map) map[key] = value;
  return map;
}

export const QUANT_SIGNATURES = {
  backtest: [{ name: 'prices' }, { name: 'signal', defaultValue: '"momentum"', isOptional: true }, { name: 'portfolio', defaultValue: '"long_short"', isOptional: true }, { name: 'lookback', isOptional: true }, { name: 'fraction', isOptional: true }, { name: 'cost', isOptional: true }],
  walk_forward: [{ name: 'prices' }, { name: 'signal', defaultValue: '"momentum"', isOptional: true }, { name: 'portfolio', defaultValue: '"long_short"', isOptional: true }, { name: 'folds', defaultValue: '4', isOptional: true }, { name: 'min_train_fraction', defaultValue: '0.5', isOptional: true }],
  momentum: [{ name: 'lookback', defaultValue: '20', isOptional: true }],
  mean_reversion: [{ name: 'lookback', defaultValue: '20', isOptional: true }],
  zscore: [{ name: 'window', defaultValue: '20', isOptional: true }],
  equal_weight: [],
  cross_sectional: [],
  long_short: [{ name: 'fraction', defaultValue: '0.2', isOptional: true }],
  sharpe: [{ name: 'returns' }, { name: 'periods_per_year', defaultValue: '252', isOptional: true }],
  deflated_sharpe: [{ name: 'returns' }, { name: 'trial_sharpes' }],
  pbo: [{ name: 'trial_returns' }, { name: 'partitions', defaultValue: '10', isOptional: true }],
  min_track_record_length: [{ name: 'returns' }, { name: 'target_sharpe', defaultValue: '0', isOptional: true }, { name: 'confidence', defaultValue: '0.95', isOptional: true }],
  risk_parity: [{ name: 'covariance' }],
  hrp: [{ name: 'covariance' }],
  mean_variance: [{ name: 'mu' }, { name: 'cov' }],
  quill: [{ name: 'source' }],
  load_quill: [{ name: 'path' }],
};

for (const [name, spec] of Object.entries(ALPHA_REGISTRY)) {
  QUANT_SIGNATURES[name] = spec.args.map(a => {
    if (a.dv === undefined) return { name: a.n };
    if (a.dv === '?') return { name: a.n, isOptional: true };
    return { name: a.n, defaultValue: a.dv, isOptional: true };
  });
}
