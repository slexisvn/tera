import * as fw from '../index.js';
import { Module } from '../nn/module.js';
import { LightningModule } from '../lightning/core/module.js';

import { Tensor } from '../tensor/core/tensor.js';
import { setDefaultDevice, WASM_DEVICE, WEBGPU_DEVICE, GPU_DEVICE } from '../tensor/types/device.js';
import { preloadWebGPU, preloadCudaRuntime } from '../runtime/backend_registry.js';
import { flushWebGPUEager } from '../runtime/webgpu.js';
import { GradMode } from '../autograd/grad_mode.js';
import { SymbolicTensor } from '../tracing/symbolic_tensor.js';
import { compile as tracingCompile } from '../tracing/compile.js';
import { TraceLevel } from '../compiler/pipeline/trace.js';
import { parse } from './parser.js';
import { CompiledProgramView, formatTrace } from './format.js';
import { installBuiltins, installSignatures, takeNamed, createDataFrameFromColumns, setUploadedCsv, removeUploadedCsv, beginUploadedCsv, resolveDeviceName, saveModelCheckpoint } from './builtins.js';
import { lookupCollectionMethod } from './collection_methods.js';
import { SignatureRegistry } from './signature_registry.js';

class Environment {
  constructor(parent = null) {
    this.parent = parent;
    this.values = new Map();
  }
  define(name, value) { this.values.set(name, value); return value; }
  set(name, value) {
    if (this.values.has(name)) { this.values.set(name, value); return value; }
    if (this.parent) return this.parent.set(name, value);
    throw new Error(`Cannot assign to undefined variable '${name}'`);
  }
  get(name) {
    if (this.values.has(name)) return this.values.get(name);
    if (this.parent) return this.parent.get(name);
    throw new Error(`Unknown name '${name}'`);
  }
}

export class TeraRuntime {
  constructor({ output = console.log } = {}) {
    this.output = output;
    setDefaultDevice(WASM_DEVICE);
    this.global = new Environment();
    this.signatureRegistry = new SignatureRegistry();
    this._installBuiltins();
    installSignatures(this.signatureRegistry);
  }

  registerDataFrame(name, columns) {
    const df = createDataFrameFromColumns(columns);
    this.global.define(name, df);
    return df;
  }

  registerUploadedCsv(name, columns) {
    setUploadedCsv(name, columns);
  }

  beginUploadedCsv(name) {
    return beginUploadedCsv(name);
  }

  removeUploadedCsv(name) {
    removeUploadedCsv(name);
  }

  async execute(source) {
    try {
      return await this.evaluateProgram(parse(source), this.global);
    } catch (error) {
      if (error.line !== undefined) throw error;
      throw new LangRuntimeError(error.message, this.currentNode?.line ?? 1, this.currentNode?.column ?? 1, error);
    }
  }

  getCompletionNames() {
    return [...this.global.values.keys()];
  }

  getVariable(name) {
    try { return this.global.get(name); } catch { return undefined; }
  }

  registerGlobal(name, value) {
    if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) {
      throw new Error('Global name must be a valid identifier');
    }
    return this.global.define(name, value);
  }

  async evaluateProgram(program, env) {
    let value;
    for (const statement of program.body) {
      const result = await this.evaluateStatement(statement, env);
      if (result && (result.__return || result.__break || result.__continue)) return result;
      value = result;
    }
    return value;
  }

  async evaluateStatement(node, env) {
    return this.withNode(node, async () => {
      if (node.type === 'Assign') return env.define(node.name, await this.evaluateExpression(node.value, env));
      if (node.type === 'CompoundAssign') {
        const current = env.get(node.name);
        const right = await this.evaluateExpression(node.value, env);
        return env.set(node.name, this.applyBinary(node.op, current, right));
      }
      if (node.type === 'If') return await this.evaluateIf(node, env);
      if (node.type === 'For') return await this.evaluateFor(node, env);
      if (node.type === 'While') return await this.evaluateWhile(node, env);
      if (node.type === 'Break') return { __break: true };
      if (node.type === 'Continue') return { __continue: true };
      if (node.type === 'ExpressionStatement') return await this.evaluateExpression(node.expression, env);
      if (node.type === 'Return') return { __return: true, value: await this.evaluateExpression(node.value, env) };
      if (node.type === 'FunctionDeclaration') return this.defineFunction(node, env);
      if (node.type === 'ModelDeclaration') return this.defineModel(node, env);
      if (node.type === 'ForwardDeclaration') throw new Error('forward can only appear inside model');
      if (node.type === 'TrainDeclaration') throw new Error('train can only appear inside model');
      if (node.type === 'ValidateDeclaration') throw new Error('validate can only appear inside model');
      if (node.type === 'OptimizerDeclaration') throw new Error('optimizer can only appear inside model');
      if (node.type === 'DestructureAssign') return await this.evaluateDestructure(node, env);
      if (node.type === 'IndexAssign') return await this.evaluateIndexAssign(node, env);
      throw new Error(`Unsupported statement ${node.type}`);
    });
  }

  async evaluateExpression(node, env) {
    return this.withNode(node, async () => {
      if (node.type === 'Literal') return node.value;
      if (node.type === 'Identifier') return env.get(node.name);
      if (node.type === 'Array') {
        const elements = [];
        for (const x of node.elements) elements.push(await this.evaluateExpression(x, env));
        return elements;
      }
      if (node.type === 'Dict') {
        const map = new Map();
        for (const entry of node.entries) {
          map.set(await this.evaluateExpression(entry.key, env), await this.evaluateExpression(entry.value, env));
        }
        return map;
      }
      if (node.type === 'ListComprehension') return await this.evaluateComprehension(node, env);
      if (node.type === 'Unary') {
        const value = await this.evaluateExpression(node.value, env);
        if (node.op === '-') return this.applyUnaryMinus(value);
        if (node.op === 'not') return this.applyUnaryNot(value);
        return value;
      }
      if (node.type === 'Binary') {
        if (node.op === 'and' || node.op === 'or') {
          const left = await this.evaluateExpression(node.left, env);
          if (!isTensorValue(left)) {
            if (node.op === 'and') return left ? await this.evaluateExpression(node.right, env) : left;
            return left ? left : await this.evaluateExpression(node.right, env);
          }
          const right = await this.evaluateExpression(node.right, env);
          return this.applyBinary(node.op, left, right);
        }
        return this.applyBinary(node.op, await this.evaluateExpression(node.left, env), await this.evaluateExpression(node.right, env));
      }
      if (node.type === 'Member') {
        const object = await this.evaluateExpression(node.object, env);
        const collMethod = lookupCollectionMethod(object, node.property);
        if (collMethod) return collMethod;
        const value = object[node.property];
        if (typeof value !== 'function') return value;
        if (node.property === 'to' && (isTensorValue(object) || object instanceof Module)) return makeDeviceMove(object, value);
        if ((node.property === 'eval' || node.property === 'train') && object instanceof Module) return makeTrainModeToggle(object, value, node.property);
        if (isTensorValue(object)) {
          if (object.device === WEBGPU_DEVICE && WEBGPU_HOST_READS.has(node.property)) return makeWebgpuHostRead(object, value);
          return bindTensorMethod(object, value);
        }
        return value.bind(object);
      }
      if (node.type === 'Index') return await this.evaluateIndex(node, env);
      if (node.type === 'Call') return await this.evaluateCall(node, env);
      throw new Error(`Unsupported expression ${node.type}`);
    });
  }

  async evaluateCall(node, env) {
    const callable = await this.evaluateExpression(node.callee, env);
    const positional = [];
    const named = {};
    for (const arg of node.args) {
      const value = await this.evaluateExpression(arg.value, env);
      if (arg.name) named[arg.name] = value;
      else positional.push(value);
    }
    if (Object.keys(named).length > 0) positional.push({ __named: true, ...named });
    let result;
    if (callable instanceof Module) result = callable.forward(...positional);
    else if (callable && typeof callable.forward === 'function' && typeof callable !== 'function') result = callable.forward(...positional);
    else if (typeof callable !== 'function') throw new Error('Value is not callable');
    else result = callable(...positional);
    if (result && typeof result.then === 'function') result = await result;
    return result;
  }

  applyUnaryMinus(value) {
    if (isTensorValue(value)) return fw.neg(value);
    return -value;
  }

  applyUnaryNot(value) {
    if (isTensorValue(value)) {
      const one = fw.ones(value.shape, { dtype: value.dtype, device: value.device });
      return fw.sub(one, value);
    }
    return !value;
  }

  applyBinary(op, left, right) {
    const tensor = isTensorValue(left) || isTensorValue(right);
    if (!tensor) {
      if (op === '+' && Array.isArray(left) && Array.isArray(right)) return left.concat(right);
      if (op === '+') return left + right;
      if (op === '-') return left - right;
      if (op === '*') return left * right;
      if (op === '/') return left / right;
      if (op === '%') return left % right;
      if (op === '**') return left ** right;
      if (op === '==') return left === right;
      if (op === '!=') return left !== right;
      if (op === '<') return left < right;
      if (op === '<=') return left <= right;
      if (op === '>') return left > right;
      if (op === '>=') return left >= right;
      if (op === 'and') return left && right;
      if (op === 'or') return left || right;
    }
    [left, right] = promoteScalars(left, right);
    const fn = {
      '+': fw.add, '-': fw.sub, '*': fw.mul, '/': fw.div, '**': fw.pow, '@': fw.matmul,
      '%': (a, b) => {
        const q = fw.div(a, b);
        return fw.sub(a, fw.mul(fw.mul(fw.sign(q), fw.floor(fw.abs(q))), b));
      },
      '==': fw.eq, '!=': fw.ne, '<': fw.lt, '<=': fw.le, '>': fw.gt, '>=': fw.ge,
      'and': fw.mul,
      'or': (a, b) => fw.sub(fw.add(a, b), fw.mul(a, b)),
    }[op];
    if (!fn) throw new Error(`Unsupported operator '${op}'`);
    return fn(left, right);
  }

  isTruthy(value) {
    if (isTensorValue(value)) {
      if (value.numel !== 1) throw new Error('Condition tensor must be a scalar (single element)');
      return Boolean(value.item());
    }
    return Boolean(value);
  }

  async evaluateIf(node, env) {
    if (this.isTruthy(await this.evaluateExpression(node.condition, env))) {
      return await this.evaluateProgram({ type: 'Program', body: node.body }, env);
    }
    for (const elif of node.elifs) {
      if (this.isTruthy(await this.evaluateExpression(elif.condition, env))) {
        return await this.evaluateProgram({ type: 'Program', body: elif.body }, env);
      }
    }
    if (node.elseBody) {
      return await this.evaluateProgram({ type: 'Program', body: node.elseBody }, env);
    }
    return undefined;
  }

  async evaluateFor(node, env) {
    const iterable = await this.evaluateExpression(node.iterable, env);
    const items = Array.isArray(iterable) ? iterable : iterable instanceof Map ? [...iterable.keys()] : null;
    if (!items) throw new Error('for...in expects an array or map');
    let value;
    for (const item of items) {
      env.define(node.variable, item);
      const result = await this.evaluateProgram({ type: 'Program', body: node.body }, env);
      if (result && result.__return) return result;
      if (result && result.__break) break;
      if (result && result.__continue) continue;
      value = result;
    }
    return value;
  }

  async evaluateWhile(node, env) {
    let value;
    while (this.isTruthy(await this.evaluateExpression(node.condition, env))) {
      const result = await this.evaluateProgram({ type: 'Program', body: node.body }, env);
      if (result && result.__return) return result;
      if (result && result.__break) break;
      if (result && result.__continue) continue;
      value = result;
    }
    return value;
  }

  defineFunction(node, declarationEnv) {
    const runtime = this;
    const func = async (...args) => {
      const callEnv = new Environment(declarationEnv);
      node.params.forEach((name, i) => callEnv.define(name, args[i]));
      const result = await runtime.evaluateProgram({ type: 'Program', body: node.body }, callEnv);
      return result && result.__return ? result.value : result;
    };
    func._langName = node.name;
    declarationEnv.define(node.name, func);
    this.signatureRegistry.register(node.name, node.params.map(name => ({ name })));
    return func;
  }

  async evaluateDestructure(node, env) {
    const value = await this.evaluateExpression(node.value, env);
    if (!Array.isArray(value)) throw new Error('Destructuring requires an array value');
    if (value.length < node.names.length) throw new Error(`Not enough values to unpack (expected ${node.names.length}, got ${value.length})`);
    for (let i = 0; i < node.names.length; i++) {
      env.define(node.names[i], value[i]);
    }
    return value;
  }

  defineModel(node, declarationEnv) {
    const runtime = this;
    const forward = node.body.find(x => x.type === 'ForwardDeclaration');
    if (!forward) throw new Error(`Model ${node.name} needs a forward block`);
    const trainBlock = node.body.find(x => x.type === 'TrainDeclaration');
    const validateBlock = node.body.find(x => x.type === 'ValidateDeclaration');
    const optimizerBlock = node.body.find(x => x.type === 'OptimizerDeclaration');
    const isLightning = !!(trainBlock || validateBlock || optimizerBlock);
    const declTypes = new Set(['ForwardDeclaration', 'TrainDeclaration', 'ValidateDeclaration', 'OptimizerDeclaration']);
    const fields = node.body.filter(x => !declTypes.has(x.type));
    const modelName = node.name;
    const BaseClass = isLightning ? LightningModule : Module;

    const factory = async (...args) => {
      const named = takeNamed(args);
      const modelEnv = new Environment(declarationEnv);
      node.params.forEach((name, i) => modelEnv.define(name, named[name] ?? args[i]));

      class LangModel extends BaseClass {
        constructor() {
          super();
          this._langName = modelName;
        }
        async forward(...inputs) {
          const callEnv = new Environment(modelEnv);
          for (const field of fields) {
            if (field.type === 'Assign') callEnv.define(field.name, this[field.name]);
          }
          forward.params.forEach((name, i) => callEnv.define(name, inputs[i]));
          const result = await runtime.evaluateProgram({ type: 'Program', body: forward.body }, callEnv);
          return result && result.__return ? result.value : result;
        }
        toString() { return `${this._langName}${super.toString().slice(this.constructor.name.length)}`; }
      }

      LangModel.prototype.save = function(path) { saveModelCheckpoint(this, path); };

      if (trainBlock) {
        LangModel.prototype.trainingStep = async function(batch, batchIdx) {
          const callEnv = buildStepEnv(this, modelEnv, fields, modelName);
          bindLog(callEnv, this);
          if (trainBlock.params[0]) callEnv.define(trainBlock.params[0], batch);
          if (trainBlock.params[1]) callEnv.define(trainBlock.params[1], batchIdx);
          const result = await runtime.evaluateProgram({ type: 'Program', body: trainBlock.body }, callEnv);
          return result && result.__return ? result.value : result;
        };
      }

      if (validateBlock) {
        LangModel.prototype.validationStep = async function(batch, batchIdx) {
          const callEnv = buildStepEnv(this, modelEnv, fields, modelName);
          bindLog(callEnv, this);
          if (validateBlock.params[0]) callEnv.define(validateBlock.params[0], batch);
          if (validateBlock.params[1]) callEnv.define(validateBlock.params[1], batchIdx);
          const result = await runtime.evaluateProgram({ type: 'Program', body: validateBlock.body }, callEnv);
          return result && result.__return ? result.value : result;
        };
      }

      if (optimizerBlock) {
        LangModel.prototype.configureOptimizers = async function() {
          const callEnv = buildStepEnv(this, modelEnv, fields, modelName);
          const result = await runtime.evaluateProgram({ type: 'Program', body: optimizerBlock.body }, callEnv);
          return result && result.__return ? result.value : result;
        };
      }

      const instance = new LangModel();
      for (const field of fields) {
        const value = await runtime.evaluateStatement(field, modelEnv);
        if (field.type === 'Assign') instance[field.name] = value;
      }
      return instance;
    };
    factory._langName = modelName;
    declarationEnv.define(modelName, factory);
    this.signatureRegistry.register(modelName, node.params.map(name => ({ name })));
    return factory;
  }

  _installBuiltins() {
    const define = (name, value) => this.global.define(name, value);
    installBuiltins(this, define);
    this.global.define('log', () => { throw new Error('log() can only be called inside a train or validate block'); });
  }

  async evaluateIndex(node, env) {
    let value = await this.evaluateExpression(node.object, env);
    if (Array.isArray(value)) return this.indexArray(value, node.items, env);
    if (value instanceof Map) return this.indexMap(value, node.items, env);
    if (typeof value === 'string') return this.indexString(value, node.items, env);
    if (!(value instanceof Tensor)) throw new Error('Indexing currently expects a Tensor, array, map, or string');
    let dim = 0;
    for (const item of node.items) {
      if (dim >= value.ndim) throw new Error(`Too many indices for tensor with ${value.ndim} dimensions`);
      if (item.type === 'Slice') {
        const start = item.start ? await this.evaluateExpression(item.start, env) : 0;
        const end = item.end ? await this.evaluateExpression(item.end, env) : value.shape[dim];
        const step = item.step ? await this.evaluateExpression(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        value = value.slice(dim, start, end, step);
        dim++;
      } else {
        let index = await this.evaluateExpression(item, env);
        if (!Number.isInteger(index)) throw new Error('Tensor index must be an integer');
        if (index < 0) index += value.shape[dim];
        if (index < 0 || index >= value.shape[dim]) {
          throw new Error(`Index ${index} is out of bounds for dimension ${dim} with size ${value.shape[dim]}`);
        }
        value = value.select(dim, index);
        if (value.ndim === 0) return value.item();
      }
    }
    return value;
  }

  async indexArray(value, items, env) {
    let current = value;
    for (const item of items) {
      if (!Array.isArray(current)) throw new Error('Too many indices for array');
      if (item.type === 'Slice') {
        const len = current.length;
        let start = item.start ? await this.evaluateExpression(item.start, env) : 0;
        let end = item.end ? await this.evaluateExpression(item.end, env) : len;
        const step = item.step ? await this.evaluateExpression(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        if (start < 0) start += len;
        if (end < 0) end += len;
        const out = [];
        for (let i = Math.max(0, start); i < Math.min(len, end); i += step) out.push(current[i]);
        current = out;
      } else {
        let index = await this.evaluateExpression(item, env);
        if (!Number.isInteger(index)) throw new Error('Array index must be an integer');
        if (index < 0) index += current.length;
        if (index < 0 || index >= current.length) {
          throw new Error(`Index ${index} is out of bounds for array of length ${current.length}`);
        }
        current = current[index];
      }
    }
    return current;
  }

  async indexMap(value, items, env) {
    let current = value;
    for (const item of items) {
      if (!(current instanceof Map)) throw new Error('Too many indices for map');
      if (item.type === 'Slice') throw new Error('Cannot slice a map');
      const key = await this.evaluateExpression(item, env);
      current = current.has(key) ? current.get(key) : null;
    }
    return current;
  }

  async indexString(value, items, env) {
    let current = value;
    for (const item of items) {
      if (typeof current !== 'string') throw new Error('Too many indices for string');
      if (item.type === 'Slice') {
        const len = current.length;
        let start = item.start ? await this.evaluateExpression(item.start, env) : 0;
        let end = item.end ? await this.evaluateExpression(item.end, env) : len;
        const step = item.step ? await this.evaluateExpression(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        if (start < 0) start += len;
        if (end < 0) end += len;
        let out = '';
        for (let i = Math.max(0, start); i < Math.min(len, end); i += step) out += current[i];
        current = out;
      } else {
        let index = await this.evaluateExpression(item, env);
        if (!Number.isInteger(index)) throw new Error('String index must be an integer');
        if (index < 0) index += current.length;
        if (index < 0 || index >= current.length) {
          throw new Error(`Index ${index} is out of bounds for string of length ${current.length}`);
        }
        current = current[index];
      }
    }
    return current;
  }

  async evaluateComprehension(node, env) {
    const iterable = await this.evaluateExpression(node.iterable, env);
    const items = Array.isArray(iterable) ? iterable : iterable instanceof Map ? [...iterable.keys()] : null;
    if (!items) throw new Error('Comprehension expects an array or map');
    const scope = new Environment(env);
    const result = [];
    for (const item of items) {
      scope.define(node.variable, item);
      if (node.condition && !this.isTruthy(await this.evaluateExpression(node.condition, scope))) continue;
      result.push(await this.evaluateExpression(node.expr, scope));
    }
    return result;
  }

  async evaluateIndexAssign(node, env) {
    let container = await this.evaluateExpression(node.object, env);
    const keys = [];
    for (const item of node.items) {
      if (item.type === 'Slice') throw new Error('Slice assignment is not supported');
      keys.push(await this.evaluateExpression(item, env));
    }
    for (let d = 0; d < keys.length - 1; d++) container = this.readContainer(container, keys[d]);
    const key = keys[keys.length - 1];
    let value = await this.evaluateExpression(node.value, env);
    if (node.op) value = this.applyBinary(node.op, this.readContainer(container, key), value);
    this.writeContainer(container, key, value);
    return value;
  }

  readContainer(container, key) {
    if (container instanceof Map) return container.has(key) ? container.get(key) : null;
    if (Array.isArray(container)) {
      let i = Number.isInteger(key) ? (key < 0 ? key + container.length : key) : key;
      if (!Number.isInteger(i)) throw new Error('Array index must be an integer');
      return container[i];
    }
    throw new Error('Cannot index into this value');
  }

  writeContainer(container, key, value) {
    if (container instanceof Map) { container.set(key, value); return; }
    if (Array.isArray(container)) {
      if (!Number.isInteger(key)) throw new Error('Array index must be an integer');
      const i = key < 0 ? key + container.length : key;
      if (i < 0 || i > container.length) {
        throw new Error(`Index ${key} is out of bounds for assignment to array of length ${container.length}`);
      }
      container[i] = value;
      return;
    }
    throw new Error('Cannot assign into this value');
  }

  async withNode(node, evaluate) {
    const previous = this.currentNode;
    this.currentNode = node;
    try {
      return await evaluate();
    } catch (error) {
      if (error.line !== undefined) throw error;
      throw new LangRuntimeError(error.message, node.line ?? 1, node.column ?? 1, error);
    } finally {
      this.currentNode = previous;
    }
  }

  compile(model, ...args) {
    if (!(model instanceof Module)) {
      throw new Error('compile() currently expects a model. Example: compile(model, input=x)');
    }
    const named = takeNamed(args);
    const rawInput = named.input ?? args[0];
    let inputs = rawInput != null ? (Array.isArray(rawInput) ? rawInput : [rawInput]) : null;
    if (inputs && inputs.some(x => !(x instanceof Tensor))) {
      throw new Error('compile() input must be a tensor, for example compile(model, input=x)');
    }

    const targetName = named.target ?? 'wasm';
    const target = targetName === 'gpu' ? fw.CUDATarget() : targetName === 'wasm' ? fw.WasmTarget() : targetName === 'webgpu' ? fw.WebGPUTarget() : fw.CPUTarget();
    const debug = named.debug ?? false;
    const showSnippet = named.snippet ?? false;

    const events = [];
    const opts = {
      target,
      verify: named.verify ?? true,
      fusion: { enabled: named.fusion ?? false, epilogue: named.epilogue ?? false, strategy: named.fusionStrategy ?? 'xla' },
      scheduling: { enabled: named.scheduling ?? false, autotune: named.autotune ?? false, numTrials: named.numTrials ?? 64, timeBudgetMs: named.timeBudgetMs ?? 30000 },
      quantization: { enabled: named.quantization ?? false },
      optimization: { layout: named.layout ?? false, rematerialization: named.rematerialization ?? false },
      memory: { inplaceReuse: named.inplaceReuse ?? false },
      partition: { enabled: named.partition ?? false, targets: [] },
    };
    if (debug) {
      opts.trace = { level: TraceLevel.DEBUG, sink: e => events.push(e), irSnapshot: { afterGraphPasses: true, afterLowering: true, afterScheduling: true } };
    }

    const compiled = tracingCompile(model, inputs, opts);

    compiled._isCompiled = true;
    compiled._langName = 'compiled';
    Object.defineProperty(compiled, '_compiledView', {
      get: () => new CompiledProgramView({ model, inputs, graph: compiled.graph(inputs), result: compiled.result(), events, target: targetName }),
    });

    if (compiled._ready) {
      const self = this;
      return compiled._ready.then(() => {
        if (debug) self.output(formatTrace(events));
        if (showSnippet) self.output(compiled.snippet());
        return compiled;
      });
    }

    if (inputs) {
      if (debug) this.output(formatTrace(events));
      if (showSnippet) this.output(compiled.snippet());
    }

    return compiled;
  }
}

function isTensorValue(value) {
  return value instanceof Tensor || value instanceof SymbolicTensor;
}

const WEBGPU_HOST_READS = new Set(['item', 'toArray', 'tolist']);

function makeDeviceMove(object, fn) {
  return async (...args) => {
    const last = args[args.length - 1];
    let device;
    if (last && last.__named) { args.pop(); device = last.device; }
    else if (args.length) device = args[args.length - 1];
    device = resolveDeviceName(device);
    if (device === WEBGPU_DEVICE) {
      if (typeof navigator === 'undefined' || !navigator.gpu) {
        throw new Error('webgpu device requires a browser environment (navigator.gpu); it is not available in the node CLI');
      }
      await preloadWebGPU();
    } else if (device === GPU_DEVICE) {
      await preloadCudaRuntime();
    }
    return fn.call(object, device);
  };
}

function makeTrainModeToggle(object, fn, prop) {
  return (...args) => {
    const result = fn.apply(object, args);
    GradMode.setEnabled(prop === 'train' ? (args.length === 0 ? true : !!args[0]) : false);
    return result;
  };
}

function makeWebgpuHostRead(object, fn) {
  return async (...args) => {
    await flushWebGPUEager();
    return bindTensorMethod(object, fn)(...args);
  };
}

function bindTensorMethod(object, fn) {
  return (...args) => {
    const last = args[args.length - 1];
    if (last && last.__named) {
      args.pop();
      const dim = last.axis ?? last.dim;
      const keep = last.keep ?? last.keepdim;
      if (dim !== undefined) args.push(dim);
      if (keep !== undefined) args.push(keep);
    }
    return fn.apply(object, args);
  };
}

function promoteScalars(left, right) {
  const reference = left instanceof Tensor ? left : right instanceof Tensor ? right : null;
  if (!reference) return [left, right];
  const options = { dtype: reference.dtype, device: reference.device };
  if (!isTensorValue(left)) left = fw.tensor(left, options);
  if (!isTensorValue(right)) right = fw.tensor(right, options);
  return [left, right];
}

function buildStepEnv(instance, modelEnv, fields, modelName) {
  const callEnv = new Environment(modelEnv);
  callEnv.define(modelName, instance);
  for (const field of fields) {
    if (field.type === 'Assign') callEnv.define(field.name, instance[field.name]);
  }
  return callEnv;
}

function bindLog(callEnv, instance) {
  callEnv.define('log', (name, value, ...rest) => {
    const named = rest.length > 0 && rest[rest.length - 1] && rest[rest.length - 1].__named ? rest.pop() : {};
    delete named.__named;
    let v = value;
    if (v && typeof v === 'object' && typeof v.compute === 'function' && !(v instanceof Tensor)) {
      v = v.compute();
    }
    const opts = {};
    if (named.on_step !== undefined) opts.onStep = named.on_step;
    if (named.on_epoch !== undefined) opts.onEpoch = named.on_epoch;
    if (named.prog_bar !== undefined) opts.progBar = named.prog_bar;
    if (named.reduce_fx !== undefined) opts.reduceFx = named.reduce_fx;
    instance.log(name, v, opts);
  });
}

export class LangRuntimeError extends Error {
  constructor(message, line, column, cause) {
    super(`${message} at ${line}:${column}`, { cause });
    this.name = 'LangRuntimeError';
    this.line = line;
    this.column = column;
  }
}
