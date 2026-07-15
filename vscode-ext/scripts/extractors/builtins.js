import { readFileSync } from 'node:fs';

const DEFINE_PATTERN = /\bdefine\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
const DEFINE_LOOP_PATTERN = /for\s*\(\s*const\s+\w+\s+of\s+([A-Z_][A-Za-z0-9_]*)\s*\)\s*(?:\{[\s\S]*?\bdefine\(|\bdefine\()/g;
const ARRAY_LIST_PATTERN = /const\s+([A-Z_]+)\s*=\s*\[([^\]]+)\]/g;
const SET_LIST_PATTERN = /const\s+([A-Z_]+)\s*=\s*new\s+Set\(\s*\[([^\]]+)\]/g;
const INLINE_ARRAY_PATTERN = /for\s*\(\s*const\s+\w+\s+of\s+\[([^\]]+)\]\s*\)\s*define\(/g;
const STRING_ITEM_PATTERN = /['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;

const KIND_RULES = [
  { kind: 'device', match: name => ['cpu', 'gpu', 'wasm', 'webgpu'].includes(name) },
  { kind: 'dtype', match: name => /^(?:f16|f32|f64|i32|i64|bool)$/.test(name) },
  { kind: 'constant', sourceList: 'CONSTANTS' },
  { kind: 'factory', sourceList: 'FACTORIES' },
  { kind: 'function', sourceList: 'FUNCTIONS' },
  { kind: 'reduction', sourceList: 'REDUCTIONS' },
  { kind: 'module', sourceList: 'MODULES' },
  { kind: 'optimizer', match: name => /^(?:SGD|Adam|AdamW)$/.test(name) },
  { kind: 'scheduler', match: name => /^(?:StepLR|CosineAnnealingLR|ReduceLROnPlateau)$/.test(name) },
  { kind: 'callback', match: name => /^(?:EarlyStopping|ModelCheckpoint|ProgressCallback|LearningRateMonitor|Timer|GradientAccumulationScheduler)$/.test(name) },
  { kind: 'logger', match: name => /^(?:ConsoleLogger|CSVLogger)$/.test(name) },
  { kind: 'metric', match: name => /^(?:Accuracy|Precision|Recall|F1Score|ConfusionMatrix|MetricCollection)$/.test(name) },
  { kind: 'trainer', match: name => name === 'Trainer' },
  { kind: 'ml_model', sourceList: 'ML_MODELS' },
  { kind: 'ml_transform', sourceList: 'ML_TRANSFORMS' },
  { kind: 'ml_cluster', sourceList: 'ML_CLUSTERS' },
  { kind: 'ml_split', sourceList: 'ML_SPLITTERS' },
  { kind: 'linalg', sourceList: 'LINALG_FUNCS' },
  { kind: 'numeric_dist', sourceList: 'NUMERIC_DIST_FUNCS' },
  { kind: 'numeric_func', sourceList: 'NUMERIC_SPECIAL_FUNCS' },
  { kind: 'numeric_transform', sourceList: 'NUMERIC_TRANSFORM_FUNCS' },
  { kind: 'numeric_func', sourceList: 'NUMERIC_INTERP_FUNCS' },
  { kind: 'numeric_stats_test', sourceList: 'NUMERIC_STATS_TESTS' },
  { kind: 'numeric_timeseries', sourceList: 'NUMERIC_TIMESERIES' },
  { kind: 'numeric_array_op', sourceList: 'NUMERIC_ARRAY_OPS' },
  { kind: 'numeric_random', sourceList: 'NUMERIC_RANDOM' },
  { kind: 'ml_metric', sourceList: 'ML_METRICS' },
  { kind: 'grid_search', match: name => name === 'GridSearchCV' },
  { kind: 'ml_function', match: name => /^(?:train_test_split|cross_val_score)$/.test(name) },
  { kind: 'data', match: name => /^(?:DataLoader|TensorDataset|load_csv)$/.test(name) },
  { kind: 'quant', match: name => /^(?:backtest|walk_forward|momentum|mean_reversion|zscore|equal_weight|cross_sectional|long_short|sharpe|deflated_sharpe|pbo|min_track_record_length|risk_parity|hrp|mean_variance|quill|load_quill)$/.test(name) },
  { kind: 'quant', sourceList: 'QUANT_STATIONARITY' },
  { kind: 'quant', sourceList: 'QUANT_COINTEGRATION' },
  { kind: 'quant', sourceList: 'QUANT_STRUCTURAL' },
  { kind: 'quant', sourceList: 'QUANT_KALMAN' },
  { kind: 'quant', sourceList: 'QUANT_GARCH' },
  { kind: 'quant', sourceList: 'QUANT_BARS' },
  { kind: 'quant', sourceList: 'QUANT_MICROSTRUCTURE' },
  { kind: 'sequential', match: name => name === 'Sequential' },
  { kind: 'autograd', match: name => /^(?:requires_grad|grad|backward|detach)$/.test(name) },
  { kind: 'shape', match: name => /^(?:reshape|transpose|permute|expand|slice|unsqueeze|squeeze|narrow|select|contiguous)$/.test(name) },
  { kind: 'utility', match: name => /^(?:range|len|shape|dtype|print|trace|graph|compile|optim_config)$/.test(name) },
];

export function extractBuiltins(builtinsSource) {
  const paths = Array.isArray(builtinsSource) ? builtinsSource : [builtinsSource];
  const text = paths.map(path => readFileSync(path, 'utf8')).join('\n');
  const lists = collectLists(text);
  const defined = collectDefined(text);
  const builtins = [];
  for (const name of defined) {
    builtins.push({ name, kind: classify(name, lists) });
  }
  builtins.sort((a, b) => a.name.localeCompare(b.name));
  return builtins;
}

function collectDefined(text) {
  const lists = collectLists(text);
  const names = new Set();
  for (const m of text.matchAll(DEFINE_PATTERN)) names.add(m[1]);
  for (const m of text.matchAll(DEFINE_LOOP_PATTERN)) {
    const items = lists.get(m[1]) ?? [];
    for (const item of items) names.add(item);
  }
  for (const m of text.matchAll(INLINE_ARRAY_PATTERN)) {
    for (const itemMatch of m[1].matchAll(STRING_ITEM_PATTERN)) names.add(itemMatch[1]);
  }
  return [...names];
}

function collectLists(text) {
  const map = new Map();
  const consume = (pattern) => {
    for (const m of text.matchAll(pattern)) {
      const items = [...m[2].matchAll(STRING_ITEM_PATTERN)].map(x => x[1]);
      map.set(m[1], items);
    }
  };
  consume(ARRAY_LIST_PATTERN);
  consume(SET_LIST_PATTERN);
  return map;
}

function classify(name, lists) {
  for (const rule of KIND_RULES) {
    if (rule.sourceList) {
      const items = lists.get(rule.sourceList);
      if (items && items.includes(name)) return rule.kind;
    } else if (rule.match && rule.match(name)) {
      return rule.kind;
    }
  }
  return 'other';
}
