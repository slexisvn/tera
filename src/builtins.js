import * as fw from '../index.js';
import * as ops from '../tensor/ops/ops.js';
import { Tensor } from '../tensor/core/tensor.js';
import { CPU_DEVICE, GPU_DEVICE, WASM_DEVICE, WEBGPU_DEVICE } from '../tensor/types/device.js';
import { flushWebGPUEager } from '../runtime/webgpu.js';
import { CompiledProgramView, formatTrace, formatValue, formatValueCompact } from './format.js';
import { printModule } from '../compiler/ir/graph/printer.js';
import { DataLoader, TensorDataset } from '../data/index.js';
import { Tokenizer } from '../tokenizer/index.js';
import { SGD, Adam, AdamW, StepLR, CosineAnnealingLR, ReduceLROnPlateau } from '../optim/index.js';
import {
  Trainer, EarlyStopping, ModelCheckpoint, ProgressCallback,
  LearningRateMonitor, Timer, GradientAccumulationScheduler,
  ConsoleLogger, CSVLogger,
  Accuracy, Precision, Recall, F1Score, ConfusionMatrix, MetricCollection,
  serializeCheckpoint, loadCheckpoint, applyCheckpoint,
} from '../lightning/index.js';
import { fs } from '#io/fs';
import { takeNamed } from './named_args.js';
import {
  DataFrame, createDataFrame, createDataFrameFromColumns,
  setUploadedCsv, beginUploadedCsv, removeUploadedCsv,
  installQueryBuiltins, QUERY_SIGNATURES, COLUMN_AGGREGATES,
} from './builtins-dataframe.js';
import { installQuantBuiltins, QUANT_SIGNATURES } from './builtins-quant.js';
import { installMlBuiltins, ML_SIGNATURES } from './builtins-ml.js';
import { installNumericBuiltins, NUMERIC_SIGNATURES } from './builtins-numeric.js';

export { takeNamed, createDataFrameFromColumns, setUploadedCsv, beginUploadedCsv, removeUploadedCsv, COLUMN_AGGREGATES };

export const FACTORIES = [
  'tensor', 'zeros', 'ones', 'empty', 'full', 'randn', 'arange', 'eye', 'linspace', 'randperm',
  'zerosLike', 'onesLike', 'emptyLike', 'fullLike', 'randnLike',
];

export const FREE_TENSOR_FUNCTIONS = ['where', 'cat', 'stack'];
export const MODULES = [
  'Linear', 'ReLU', 'GELU', 'SiLU', 'Sigmoid', 'Tanh', 'LeakyReLU', 'ELU',
  'Softmax', 'LogSoftmax', 'Flatten', 'Dropout', 'LayerNorm', 'BatchNorm1d',
  'BatchNorm2d', 'Conv1d', 'Conv2d', 'MaxPool2d', 'AvgPool2d',
  'AdaptiveAvgPool2d', 'Embedding', 'GRU', 'GRUCell', 'LSTM', 'LSTMCell', 'CrossEntropyLoss', 'MSELoss', 'NLLLoss',
  'BCELoss',
];

export function saveModelCheckpoint(model, path) {
  if (!model || typeof model.stateDict !== 'function') throw new Error('save() requires a model');
  if (typeof path !== 'string') throw new Error('save() requires a file path string');
  const tmp = path + '.tmp';
  fs.writeBinary(tmp, serializeCheckpoint({ modelState: model.stateDict() }));
  fs.rename(tmp, path);
}

export function installBuiltins(runtime, define) {
  for (const name of FACTORIES) define(name, (...args) => callWithOptions(fw[name], args));
  for (const name of FREE_TENSOR_FUNCTIONS) define(name, (...args) => callWithOptions(fw[name] ?? ops[name], args));
  for (const name of MODULES) define(name, (...args) => constructWithNamed(fw[name], args));

  installQueryBuiltins(define);

  define('Sequential', (...args) => new fw.Sequential(...args));

  define('range', (...args) => {
    let start = 0, stop, step = 1;
    if (args.length === 1) stop = args[0];
    else if (args.length === 2) { start = args[0]; stop = args[1]; }
    else { start = args[0]; stop = args[1]; step = args[2]; }
    const result = [];
    if (step > 0) for (let i = start; i < stop; i += step) result.push(i);
    else if (step < 0) for (let i = start; i > stop; i += step) result.push(i);
    else throw new Error('range() step cannot be zero');
    return result;
  });

  define('print', async (...args) => {
    const named = args.length > 0 && args[args.length - 1]?.__named ? args.pop() : null;
    if (args.some(v => v instanceof Tensor && v.device === WEBGPU_DEVICE)) await flushWebGPUEager();
    const sep = named?.sep ?? ' ';
    const compact = args.length > 1;
    const text = args.map(v => compact ? formatValueCompact(v) : formatValue(v)).join(sep);
    runtime.output(text);
  });
  define('trace', value => {
    const view = value?._isCompiled ? value._compiledView : value instanceof CompiledProgramView ? value : null;
    if (!view?.events) throw new Error('trace() expects a compiled program');
    const text = formatTrace(view.events);
    runtime.output(text);
    return text;
  });
  define('graph', value => {
    const graph = value?._isCompiled ? value._compiledView?.graph :
                  value instanceof CompiledProgramView ? value.graph : value;
    const text = printModule(graph);
    runtime.output(text);
    return text;
  });
  define('compile', (...args) => runtime.compile(...args));

  define('cpu', 'cpu');
  define('gpu', 'gpu');
  define('wasm', 'wasm');
  define('webgpu', 'webgpu');
  for (const dtype of ['f16', 'f32', 'f64', 'i32', 'i64', 'bool']) define(dtype, dtype);

  define('Tokenizer', (...args) => constructWithSnakeCase(Tokenizer, args));
  define('load_tokenizer', path => Tokenizer.load(path));

  define('TensorDataset', (...args) => new TensorDataset(...args));
  define('DataLoader', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    return new DataLoader(args[0], snakeNamedToCamel(named));
  });

  define('SGD', (...args) => constructOptimizer(SGD, args));
  define('Adam', (...args) => constructOptimizer(Adam, args));
  define('AdamW', (...args) => constructOptimizer(AdamW, args));

  define('StepLR', (...args) => constructScheduler(StepLR, args, ['optimizer', 'stepSize', 'gamma']));
  define('CosineAnnealingLR', (...args) => constructScheduler(CosineAnnealingLR, args, ['optimizer', 'tMax', 'etaMin']));
  define('ReduceLROnPlateau', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    return new ReduceLROnPlateau(args[0], snakeNamedToCamel(named));
  });

  define('Trainer', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    return new Trainer(snakeNamedToCamel(named));
  });

  define('EarlyStopping', (...args) => constructWithSnakeCase(EarlyStopping, args));
  define('ModelCheckpoint', (...args) => constructWithSnakeCase(ModelCheckpoint, args));
  define('ProgressCallback', (...args) => constructWithSnakeCase(ProgressCallback, args));
  define('LearningRateMonitor', (...args) => constructWithSnakeCase(LearningRateMonitor, args));
  define('Timer', (...args) => constructWithSnakeCase(Timer, args));
  define('GradientAccumulationScheduler', (...args) => constructWithSnakeCase(GradientAccumulationScheduler, args));

  define('ConsoleLogger', (...args) => constructWithSnakeCase(ConsoleLogger, args));
  define('CSVLogger', (...args) => constructWithSnakeCase(CSVLogger, args));

  define('Accuracy', (...args) => constructWithSnakeCase(Accuracy, args));
  define('Precision', (...args) => constructWithSnakeCase(Precision, args));
  define('Recall', (...args) => constructWithSnakeCase(Recall, args));
  define('F1Score', (...args) => constructWithSnakeCase(F1Score, args));
  define('ConfusionMatrix', (...args) => constructWithSnakeCase(ConfusionMatrix, args));
  define('MetricCollection', (...args) => constructWithSnakeCase(MetricCollection, args));

  define('load_model', (model, path) => {
    if (!model || typeof model.loadStateDict !== 'function') throw new Error('load_model() requires a model as the first argument');
    if (typeof path !== 'string') throw new Error('load_model() requires a file path string');
    applyCheckpoint(loadCheckpoint(path), model);
    return model;
  });

  define('read_text', (path) => {
    if (typeof path !== 'string') throw new Error('read_text() requires a file path string');
    const data = fs.readFile(path);
    return typeof data === 'string' ? data : new TextDecoder().decode(data);
  });

  define('load_json', (path) => {
    if (typeof path !== 'string') throw new Error('load_json() requires a file path string');
    const data = fs.readFile(path);
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const toTera = (v) => {
      if (Array.isArray(v)) return v.map(toTera);
      if (v && typeof v === 'object') { const m = new Map(); for (const k of Object.keys(v)) m.set(k, toTera(v[k])); return m; }
      return v;
    };
    return toTera(JSON.parse(text));
  });

  define('optim_config', (...args) => {
    const named = takeNamed(args);
    delete named.__named;
    const optimizer = args[0] ?? named.optimizer;
    if (!optimizer) throw new Error('optim_config() requires an optimizer');
    const result = { optimizer };
    const sched = named.lr_scheduler ?? named.lrScheduler;
    if (sched) result.lrScheduler = sched;
    return result;
  });

  installMlBuiltins(define);
  installNumericBuiltins(define);
  installQuantBuiltins(define, { takeNamed, DataFrame, createDataFrame, fs, snakeNamedToCamel });
}

function callWithOptions(fn, args) {
  const named = takeNamed(args);
  if (Object.keys(named).length === 0) return fn(...args);
  delete named.__named;
  if ('grad' in named) {
    named.requiresGrad = named.grad;
    delete named.grad;
  }
  if ('axis' in named) {
    args.push(named.axis);
    delete named.axis;
  }
  if (typeof named.device === 'string') {
    named.device = DEVICE_BY_NAME[named.device] ?? named.device;
  }
  return fn(...args, named);
}

const DEVICE_BY_NAME = { cpu: CPU_DEVICE, gpu: GPU_DEVICE, wasm: WASM_DEVICE, webgpu: WEBGPU_DEVICE };

export function resolveDeviceName(name) {
  return typeof name === 'string' ? (DEVICE_BY_NAME[name] ?? name) : name;
}

function constructWithNamed(Type, args) {
  const named = takeNamed(args);
  delete named.__named;
  if (Type === fw.Softmax || Type === fw.LogSoftmax) return new Type(named.axis ?? args[0] ?? -1);
  if (Type === fw.Conv1d || Type === fw.Conv2d) return new Type(...args, named);
  return new Type(...args, ...Object.values(named));
}

function snakeToCamel(name) {
  return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

export function snakeNamedToCamel(named) {
  const result = {};
  for (const key of Object.keys(named)) {
    result[snakeToCamel(key)] = named[key];
  }
  return result;
}

function constructWithSnakeCase(Type, args) {
  const named = takeNamed(args);
  delete named.__named;
  const opts = snakeNamedToCamel(named);
  if (args.length > 0) return new Type(...args, opts);
  if (Object.keys(opts).length > 0) return new Type(opts);
  return new Type();
}

function constructOptimizer(Type, args) {
  const named = takeNamed(args);
  delete named.__named;
  const params = args[0];
  if (!params) throw new Error(`${Type.name}() requires params as first argument`);
  return new Type(params, snakeNamedToCamel(named));
}

function constructScheduler(Type, args, posNames) {
  const named = takeNamed(args);
  delete named.__named;
  const merged = snakeNamedToCamel(named);
  const positional = [];
  for (let i = 0; i < posNames.length; i++) {
    const name = posNames[i];
    if (i < args.length) positional.push(args[i]);
    else if (merged[name] !== undefined) positional.push(merged[name]);
    else break;
  }
  return new Type(...positional);
}

export const FACTORY_SIGNATURES = {
  tensor: [{ name: 'data' }, { name: 'opts', isOptional: true }],
  zeros: [{ name: 'shape' }, { name: 'opts', isOptional: true }],
  ones: [{ name: 'shape' }, { name: 'opts', isOptional: true }],
  empty: [{ name: 'shape' }, { name: 'opts', isOptional: true }],
  full: [{ name: 'shape' }, { name: 'value' }, { name: 'opts', isOptional: true }],
  randn: [{ name: 'shape' }, { name: 'opts', isOptional: true }],
  arange: [{ name: 'start' }, { name: 'end', isOptional: true }, { name: 'step', isOptional: true }, { name: 'opts', isOptional: true }],
  eye: [{ name: 'n' }, { name: 'm', isOptional: true }, { name: 'opts', isOptional: true }],
  linspace: [{ name: 'start' }, { name: 'end' }, { name: 'steps' }, { name: 'opts', isOptional: true }],
  zerosLike: [{ name: 'tensor' }],
  onesLike: [{ name: 'tensor' }],
  emptyLike: [{ name: 'tensor' }],
  fullLike: [{ name: 'tensor' }, { name: 'value' }],
  randnLike: [{ name: 'tensor' }],
};

export const MODULE_SIGNATURES = {
  Linear: [{ name: 'inFeatures' }, { name: 'outFeatures' }, { name: 'bias', defaultValue: 'true', isOptional: true }],
  Conv1d: [{ name: 'inChannels' }, { name: 'outChannels' }, { name: 'kernelSize' }, { name: 'stride', defaultValue: '1', isOptional: true }, { name: 'padding', defaultValue: '0', isOptional: true }],
  Conv2d: [{ name: 'inChannels' }, { name: 'outChannels' }, { name: 'kernelSize' }, { name: 'stride', defaultValue: '1', isOptional: true }, { name: 'padding', defaultValue: '0', isOptional: true }],
  LayerNorm: [{ name: 'normalizedShape' }, { name: 'eps', defaultValue: '1e-5', isOptional: true }],
  BatchNorm1d: [{ name: 'numFeatures' }, { name: 'eps', defaultValue: '1e-5', isOptional: true }, { name: 'momentum', defaultValue: '0.1', isOptional: true }],
  BatchNorm2d: [{ name: 'numFeatures' }, { name: 'eps', defaultValue: '1e-5', isOptional: true }, { name: 'momentum', defaultValue: '0.1', isOptional: true }],
  Dropout: [{ name: 'p', defaultValue: '0.5', isOptional: true }],
  Embedding: [{ name: 'numEmbeddings' }, { name: 'embeddingDim' }, { name: 'paddingIdx', isOptional: true }],
  MaxPool2d: [{ name: 'kernelSize' }, { name: 'stride', isOptional: true }, { name: 'padding', defaultValue: '0', isOptional: true }],
  AvgPool2d: [{ name: 'kernelSize' }, { name: 'stride', isOptional: true }, { name: 'padding', defaultValue: '0', isOptional: true }],
  AdaptiveAvgPool2d: [{ name: 'outputSize' }],
  LeakyReLU: [{ name: 'negativeSlope', defaultValue: '0.01', isOptional: true }],
  ELU: [{ name: 'alpha', defaultValue: '1.0', isOptional: true }],
  Softmax: [{ name: 'dim', defaultValue: '-1', isOptional: true }],
  LogSoftmax: [{ name: 'dim', defaultValue: '-1', isOptional: true }],
  Flatten: [{ name: 'startDim', defaultValue: '1', isOptional: true }, { name: 'endDim', defaultValue: '-1', isOptional: true }],
};

export const TRAINING_SIGNATURES = {
  TensorDataset: [{ name: '...tensors' }],
  DataLoader: [{ name: 'dataset' }, { name: 'batch_size', defaultValue: '1', isOptional: true }, { name: 'shuffle', defaultValue: 'false', isOptional: true }, { name: 'drop_last', defaultValue: 'false', isOptional: true }],
  SGD: [{ name: 'params' }, { name: 'lr', defaultValue: '0.01', isOptional: true }, { name: 'momentum', defaultValue: '0', isOptional: true }, { name: 'weight_decay', defaultValue: '0', isOptional: true }],
  Adam: [{ name: 'params' }, { name: 'lr', defaultValue: '0.001', isOptional: true }, { name: 'betas', isOptional: true }, { name: 'weight_decay', defaultValue: '0', isOptional: true }],
  AdamW: [{ name: 'params' }, { name: 'lr', defaultValue: '0.001', isOptional: true }, { name: 'betas', isOptional: true }, { name: 'weight_decay', defaultValue: '0.01', isOptional: true }],
  StepLR: [{ name: 'optimizer' }, { name: 'step_size' }, { name: 'gamma', defaultValue: '0.1', isOptional: true }],
  CosineAnnealingLR: [{ name: 'optimizer' }, { name: 't_max' }, { name: 'eta_min', defaultValue: '0', isOptional: true }],
  ReduceLROnPlateau: [{ name: 'optimizer' }, { name: 'mode', defaultValue: '"min"', isOptional: true }, { name: 'patience', defaultValue: '10', isOptional: true }, { name: 'factor', defaultValue: '0.1', isOptional: true }],
  Trainer: [{ name: 'max_epochs', defaultValue: '10', isOptional: true }, { name: 'accelerator', defaultValue: '"auto"', isOptional: true }, { name: 'callbacks', isOptional: true }, { name: 'logger', defaultValue: 'true', isOptional: true }, { name: 'compile', defaultValue: 'false', isOptional: true }, { name: 'compile_mode', defaultValue: '"separate"', isOptional: true }],
  EarlyStopping: [{ name: 'monitor' }, { name: 'patience', defaultValue: '3', isOptional: true }, { name: 'mode', defaultValue: '"min"', isOptional: true }],
  ModelCheckpoint: [{ name: 'monitor', isOptional: true }, { name: 'save_top_k', defaultValue: '1', isOptional: true }, { name: 'mode', defaultValue: '"min"', isOptional: true }],
  ProgressCallback: [],
  LearningRateMonitor: [],
  Timer: [],
  GradientAccumulationScheduler: [{ name: 'scheduling' }],
  ConsoleLogger: [],
  CSVLogger: [{ name: 'save_dir', isOptional: true }, { name: 'name', isOptional: true }],
  Accuracy: [{ name: 'task', defaultValue: '"binary"', isOptional: true }, { name: 'num_classes', isOptional: true }, { name: 'top_k', defaultValue: '1', isOptional: true }],
  Precision: [{ name: 'task', defaultValue: '"binary"', isOptional: true }, { name: 'num_classes', isOptional: true }, { name: 'average', defaultValue: '"macro"', isOptional: true }],
  Recall: [{ name: 'task', defaultValue: '"binary"', isOptional: true }, { name: 'num_classes', isOptional: true }, { name: 'average', defaultValue: '"macro"', isOptional: true }],
  F1Score: [{ name: 'task', defaultValue: '"binary"', isOptional: true }, { name: 'num_classes', isOptional: true }, { name: 'average', defaultValue: '"macro"', isOptional: true }],
  ConfusionMatrix: [{ name: 'num_classes' }],
  MetricCollection: [{ name: '...metrics' }],
  optim_config: [{ name: 'optimizer' }, { name: 'lr_scheduler', isOptional: true }],
  read_text: [{ name: 'path' }],
  load_json: [{ name: 'path' }],
};

export const BUILTIN_SIGNATURES = {
  reshape: [{ name: 'tensor' }, { name: 'shape' }],
  transpose: [{ name: 'tensor' }, { name: 'dim0' }, { name: 'dim1' }],
  permute: [{ name: 'tensor' }, { name: 'dims' }],
  expand: [{ name: 'tensor' }, { name: 'shape' }],
  slice: [{ name: 'tensor' }, { name: 'dim' }, { name: 'start' }, { name: 'end' }, { name: 'step', defaultValue: '1', isOptional: true }],
  unsqueeze: [{ name: 'tensor' }, { name: 'dim' }],
  squeeze: [{ name: 'tensor' }, { name: 'dim' }],
  narrow: [{ name: 'tensor' }, { name: 'dim' }, { name: 'start' }, { name: 'length' }],
  select: [{ name: 'tensor' }, { name: 'dim' }, { name: 'index' }],
  contiguous: [{ name: 'tensor' }],
  detach: [{ name: 'tensor' }],
  requires_grad: [{ name: 'tensor' }, { name: 'flag', defaultValue: 'true', isOptional: true }],
  grad: [{ name: 'tensor' }],
  backward: [{ name: 'tensor' }, { name: 'gradient', isOptional: true }],
  range: [{ name: 'start' }, { name: 'stop', isOptional: true }, { name: 'step', isOptional: true }],
  shape: [{ name: 'tensor' }],
  dtype: [{ name: 'tensor' }],
  print: [{ name: 'value' }],
  trace: [{ name: 'compiled' }],
  graph: [{ name: 'compiled' }],
  compile: [
    { name: 'model' }, { name: 'input', isOptional: true }, { name: 'target', defaultValue: 'cpu', isOptional: true },
    { name: 'fusion', isOptional: true }, { name: 'scheduling', isOptional: true }, { name: 'autotune', isOptional: true },
    { name: 'quantization', isOptional: true }, { name: 'layout', isOptional: true }, { name: 'rematerialization', isOptional: true },
    { name: 'inplaceReuse', isOptional: true }, { name: 'partition', isOptional: true },
    { name: 'debug', isOptional: true }, { name: 'snippet', isOptional: true }, { name: 'verify', defaultValue: 'true', isOptional: true },
    { name: 'epilogue', isOptional: true }, { name: 'fusionStrategy', defaultValue: 'xla', isOptional: true },
    { name: 'numTrials', defaultValue: '64', isOptional: true }, { name: 'timeBudgetMs', defaultValue: '30000', isOptional: true },
  ],
  Sequential: [{ name: '...modules' }],
  sum: [{ name: 'input' }, { name: 'axis', isOptional: true }, { name: 'keep', isOptional: true }],
  mean: [{ name: 'input' }, { name: 'axis', isOptional: true }, { name: 'keep', isOptional: true }],
  max: [{ name: 'input' }, { name: 'axis', isOptional: true }, { name: 'keep', isOptional: true }],
  min: [{ name: 'input' }, { name: 'axis', isOptional: true }, { name: 'keep', isOptional: true }],
  argmax: [{ name: 'input' }, { name: 'axis', isOptional: true }, { name: 'keep', isOptional: true }],
  argmin: [{ name: 'input' }, { name: 'axis', isOptional: true }, { name: 'keep', isOptional: true }],
  prod: [{ name: 'input' }, { name: 'axis', isOptional: true }, { name: 'keep', isOptional: true }],
};

export function installSignatures(registry) {
  for (const [name, params] of Object.entries(FACTORY_SIGNATURES)) registry.register(name, params);
  for (const [name, params] of Object.entries(MODULE_SIGNATURES)) registry.register(name, params);
  for (const [name, params] of Object.entries(BUILTIN_SIGNATURES)) registry.register(name, params);
  for (const [name, params] of Object.entries(TRAINING_SIGNATURES)) registry.register(name, params);
  for (const [name, params] of Object.entries(QUERY_SIGNATURES)) registry.register(name, params);
  for (const [name, params] of Object.entries(QUANT_SIGNATURES)) registry.register(name, params);
  for (const [name, params] of Object.entries(ML_SIGNATURES)) registry.register(name, params);
  for (const [name, params] of Object.entries(NUMERIC_SIGNATURES)) registry.register(name, params);
}
