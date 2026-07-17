import * as mlfw from "@slexisvn/mlfw";
import type { RuntimeFunctionMetadata } from "../../core/value/index.js";
import { camelOptions, register, splitOptions, type BuiltinMap, type NativeCtor, type NativeFn } from "./common.js";

const ml = (mlfw as Record<string, unknown>).ml as Record<string, unknown>;
const linalg = (mlfw as Record<string, unknown>).linalg as Record<string, unknown>;

export const ML_MODELS = [
  "LinearRegression", "Ridge", "Lasso", "ElasticNet", "LogisticRegression",
  "KNeighborsClassifier", "KNeighborsRegressor", "GaussianNB",
  "DecisionTreeClassifier", "DecisionTreeRegressor",
  "RandomForestClassifier", "RandomForestRegressor",
  "GradientBoostingClassifier", "GradientBoostingRegressor",
] as const;

export const ML_TRANSFORMS = ["StandardScaler", "MinMaxScaler", "LabelEncoder", "OneHotEncoder", "PCA"] as const;
export const ML_CLUSTERS = ["KMeans"] as const;
export const ML_SPLITTERS = ["KFold", "TimeSeriesSplit"] as const;
export const LINALG_FUNCS = ["svd", "eigh", "cholesky", "solve", "lstsq", "inv", "pinv", "det", "cov"] as const;
export const ML_METRICS = ["r2_score", "mean_squared_error", "mean_absolute_error", "accuracy_score", "confusion_matrix"] as const;

function makeEstimator(Cls: NativeCtor): NativeFn {
  return (...args) => new Cls(camelOptions(splitOptions(args).options));
}

function trainTestSplit(...args: unknown[]): unknown {
  const { values, options } = splitOptions(args);
  const X = values[0];
  const y = values[1];
  if (y === undefined) {
    const [train, test] = (ml.train_test_split as NativeFn)(X, X, camelOptions(options)) as unknown[];
    return [train, test];
  }
  return (ml.train_test_split as NativeFn)(X, y, camelOptions(options));
}

function crossValScore(...args: unknown[]): unknown {
  const { values, options } = splitOptions(args);
  return (ml.cross_val_score as NativeFn)(values[0], values[1], values[2], camelOptions(options));
}

function gridSearchCV(...args: unknown[]): unknown {
  const { values, options } = splitOptions(args);
  return new (ml.GridSearchCV as NativeCtor)(values[0], values[1], camelOptions(options));
}

export function installMlBuiltins(map: BuiltinMap, metadata: Record<string, RuntimeFunctionMetadata>): void {
  for (const name of [...ML_MODELS, ...ML_TRANSFORMS, ...ML_CLUSTERS, ...ML_SPLITTERS]) {
    const ctor = ml[name] as NativeCtor | undefined;
    if (typeof ctor === "function") register(map, name, makeEstimator(ctor), metadata[name]);
  }
  for (const name of LINALG_FUNCS) {
    const fn = linalg[name] as NativeFn | undefined;
    if (typeof fn === "function") register(map, name, (...args) => fn(...args), metadata[name]);
  }
  for (const name of ML_METRICS) {
    const fn = ml[name] as NativeFn | undefined;
    if (typeof fn === "function") register(map, name, (...args) => fn(...args), metadata[name]);
  }
  if (typeof ml.train_test_split === "function") register(map, "train_test_split", trainTestSplit, metadata.train_test_split);
  if (typeof ml.cross_val_score === "function") register(map, "cross_val_score", crossValScore, metadata.cross_val_score);
  if (typeof ml.GridSearchCV === "function") register(map, "GridSearchCV", gridSearchCV, metadata.GridSearchCV);
}
