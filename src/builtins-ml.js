import * as ml from '../ml/index.js';
import * as linalg from '../tensor/ops/linalg.js';
import { Tensor } from '../tensor/core/tensor.js';
import { takeNamed } from './named_args.js';
import { snakeNamedToCamel } from './builtins.js';

export const ML_MODELS = [
  'LinearRegression', 'Ridge', 'Lasso', 'ElasticNet', 'LogisticRegression',
  'KNeighborsClassifier', 'KNeighborsRegressor', 'GaussianNB',
  'DecisionTreeClassifier', 'DecisionTreeRegressor',
  'RandomForestClassifier', 'RandomForestRegressor',
  'GradientBoostingClassifier', 'GradientBoostingRegressor',
];
export const ML_TRANSFORMS = ['StandardScaler', 'MinMaxScaler', 'LabelEncoder', 'OneHotEncoder', 'PCA'];
export const ML_CLUSTERS = ['KMeans'];
export const ML_SPLITTERS = ['KFold', 'TimeSeriesSplit'];
export const LINALG_FUNCS = ['svd', 'eigh', 'cholesky', 'solve', 'lstsq', 'inv', 'pinv', 'det', 'cov'];
export const ML_METRICS = ['r2_score', 'mean_squared_error', 'mean_absolute_error', 'accuracy_score', 'confusion_matrix'];

function optionsOf(args) {
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && !Array.isArray(last) && !(last instanceof Tensor)) {
    const rest = { ...last };
    delete rest.__named;
    return snakeNamedToCamel(rest);
  }
  return {};
}

function makeEstimator(Cls) {
  return (...args) => new Cls(optionsOf(args));
}

export function installMlBuiltins(define) {
  for (const name of ML_MODELS) define(name, makeEstimator(ml[name]));
  for (const name of ML_TRANSFORMS) define(name, makeEstimator(ml[name]));
  for (const name of ML_CLUSTERS) define(name, makeEstimator(ml[name]));
  for (const name of ML_SPLITTERS) define(name, makeEstimator(ml[name]));
  for (const name of LINALG_FUNCS) define(name, (...args) => linalg[name](...args));
  for (const name of ML_METRICS) define(name, (...args) => ml[name](...args));

  define('train_test_split', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    const opts = snakeNamedToCamel(named);
    const X = args[0];
    const y = args[1];
    if (y === undefined) {
      const [tr, te] = ml.train_test_split(X, X, opts);
      return [tr, te];
    }
    return ml.train_test_split(X, y, opts);
  });

  define('cross_val_score', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    const opts = snakeNamedToCamel(named);
    const [makeEst, X, y] = args;
    return ml.cross_val_score(makeEst, X, y, opts);
  });

  define('GridSearchCV', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    const opts = snakeNamedToCamel(named);
    const [makeEst, grid] = args;
    return new ml.GridSearchCV(makeEst, grid, opts);
  });
}

const OPT = (name, defaultValue) => ({ name, isOptional: true, defaultValue });

export const ML_SIGNATURES = {
  LinearRegression: [OPT('fit_intercept', 'true')],
  Ridge: [OPT('alpha', '1.0'), OPT('fit_intercept', 'true')],
  Lasso: [OPT('alpha', '1.0'), OPT('fit_intercept', 'true'), OPT('max_iter', '1000')],
  ElasticNet: [OPT('alpha', '1.0'), OPT('l1_ratio', '0.5'), OPT('fit_intercept', 'true'), OPT('max_iter', '1000')],
  LogisticRegression: [OPT('C', '1.0'), OPT('lr', '0.5'), OPT('max_iter', '1000')],
  PCA: [OPT('n_components', 'null')],
  KMeans: [OPT('n_clusters', '8'), OPT('max_iter', '300'), OPT('n_init', '10'), OPT('random_state', '0')],
  KNeighborsClassifier: [OPT('n_neighbors', '5')],
  KNeighborsRegressor: [OPT('n_neighbors', '5')],
  GaussianNB: [],
  DecisionTreeClassifier: [OPT('max_depth', 'null'), OPT('min_samples_split', '2'), OPT('min_samples_leaf', '1'), OPT('max_features', '0'), OPT('random_state', '0')],
  DecisionTreeRegressor: [OPT('max_depth', 'null'), OPT('min_samples_split', '2'), OPT('min_samples_leaf', '1'), OPT('max_features', '0'), OPT('random_state', '0')],
  RandomForestClassifier: [OPT('n_estimators', '100'), OPT('max_depth', 'null'), OPT('max_features', '0'), OPT('random_state', '0')],
  RandomForestRegressor: [OPT('n_estimators', '100'), OPT('max_depth', 'null'), OPT('max_features', '0'), OPT('random_state', '0')],
  GradientBoostingClassifier: [OPT('n_estimators', '100'), OPT('learning_rate', '0.1'), OPT('max_depth', '3'), OPT('random_state', '0')],
  GradientBoostingRegressor: [OPT('n_estimators', '100'), OPT('learning_rate', '0.1'), OPT('max_depth', '3'), OPT('random_state', '0')],
  StandardScaler: [OPT('with_mean', 'true'), OPT('with_std', 'true')],
  MinMaxScaler: [OPT('feature_range', '[0, 1]')],
  LabelEncoder: [],
  OneHotEncoder: [],
  KFold: [OPT('n_splits', '5'), OPT('shuffle', 'false'), OPT('random_state', '0')],
  TimeSeriesSplit: [OPT('n_splits', '5')],
  GridSearchCV: [{ name: 'estimator' }, { name: 'param_grid' }, OPT('cv', '5')],
  train_test_split: [{ name: 'X' }, { name: 'y', isOptional: true }, OPT('test_size', '0.25'), OPT('random_state', '0')],
  cross_val_score: [{ name: 'estimator' }, { name: 'X' }, { name: 'y' }, OPT('cv', '5')],
  r2_score: [{ name: 'y_true' }, { name: 'y_pred' }],
  mean_squared_error: [{ name: 'y_true' }, { name: 'y_pred' }],
  mean_absolute_error: [{ name: 'y_true' }, { name: 'y_pred' }],
  accuracy_score: [{ name: 'y_true' }, { name: 'y_pred' }],
  confusion_matrix: [{ name: 'y_true' }, { name: 'y_pred' }],
  svd: [{ name: 'input' }],
  eigh: [{ name: 'input' }],
  cholesky: [{ name: 'input' }],
  solve: [{ name: 'a' }, { name: 'b' }],
  lstsq: [{ name: 'a' }, { name: 'b' }],
  inv: [{ name: 'input' }],
  pinv: [{ name: 'input' }],
  det: [{ name: 'input' }],
  cov: [{ name: 'input' }],
};
