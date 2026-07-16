import {
  Module, LightningModule, Tensor,
  setDefaultDevice, WASM_DEVICE, WEBGPU_DEVICE, GPU_DEVICE,
  preloadWebGPU, preloadCudaRuntime, flushWebGPUEager,
  GradMode, SymbolicTensor, compile as tracingCompile, TraceLevel,
  tensor, ones,
  add, sub, mul, div, neg, pow, matmul, sign, floor, abs,
  eq, ne, lt, le, gt, ge,
  CPUTarget, CUDATarget, WasmTarget, WebGPUTarget,
} from '@slexisvn/mlfw';
import { parseAndElaborate } from './elaborate.js';
import { defaultMethodReturns } from './default_method_returns.js';
import { CompiledProgramView, formatTrace } from './format.js';
import { installBuiltins, installSignatures, takeNamed, createDataFrameFromColumns, setUploadedCsv, removeUploadedCsv, beginUploadedCsv, resolveDeviceName, saveModelCheckpoint } from './builtins.js';
import { lookupCollectionMethod } from './collection_methods.js';
import { SignatureRegistry } from './signature_registry.js';
import { ANY, TENSOR, moduleType } from './types.js';

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
  constructor({ output = console.log, methodReturns = null } = {}) {
    this.output = output;
    setDefaultDevice(WASM_DEVICE);
    this.global = new Environment();
    this.globalTypes = new Map();
    this.methodReturns = methodReturns ?? defaultMethodReturns();
    this.signatureRegistry = new SignatureRegistry();
    this._installBuiltins();
    installSignatures(this.signatureRegistry);
  }

  registerDataFrame(name, columns) {
    const df = createDataFrameFromColumns(columns);
    this.global.define(name, df);
    this.globalTypes.set(name, moduleType('DataFrame'));
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

  execute(source) {
    try {
      const { program, diagnostics } = parseAndElaborate(source, { methodReturns: this.methodReturns, globals: this.globalTypes });
      this.throwBlockingDiagnostics(diagnostics);
      if (program.async) throw new Error('Program contains async operations; use executeAsync()');
      const result = this.evaluateProgram(program, this.global);
      this.rememberGlobalTypes(program);
      return result;
    } catch (error) {
      if (error.line !== undefined) throw error;
      throw new LangRuntimeError(error.message, this.currentNode?.line ?? 1, this.currentNode?.column ?? 1, error);
    }
  }

  async executeAsync(source) {
    try {
      const { program, diagnostics } = parseAndElaborate(source, { methodReturns: this.methodReturns, globals: this.globalTypes });
      this.throwBlockingDiagnostics(diagnostics);
      const result = await this.evaluateProgramAsync(program, this.global);
      this.rememberGlobalTypes(program);
      return result;
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

  registerGlobal(name, value, type = ANY) {
    if (typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) {
      throw new Error('Global name must be a valid identifier');
    }
    this.globalTypes.set(name, type);
    return this.global.define(name, value);
  }

  rememberGlobalTypes(program) {
    for (const statement of program.body) {
      if (statement.type === 'Assign') this.globalTypes.set(statement.name, this.typeOfValue(this.getVariable(statement.name)));
      else if (statement.type === 'DestructureAssign') {
        for (const name of statement.names) this.globalTypes.set(name, this.typeOfValue(this.getVariable(name)));
      } else if (statement.type === 'FunctionDeclaration') {
        this.globalTypes.set(statement.name, ANY);
      } else if (statement.type === 'ModelDeclaration') {
        this.globalTypes.set(statement.name, ANY);
      }
    }
  }

  typeOfValue(value) {
    if (isTensorValue(value)) return TENSOR;
    if (isDataFrameValue(value)) return moduleType('DataFrame');
    if (value instanceof Module) return moduleType(value._langName ?? value.constructor?.name ?? 'Model');
    return ANY;
  }

  throwBlockingDiagnostics(diagnostics) {
    const diagnostic = diagnostics.find(error => error.message.includes('async call requires await'));
    if (diagnostic) throw diagnostic;
  }

  evaluateProgram(program, env) {
    let value;
    for (const statement of program.body) {
      const result = this.evaluateStatement(statement, env);
      if (result && (result.__return || result.__break || result.__continue)) return result;
      value = result;
    }
    return value;
  }

  evaluateStatement(node, env) {
    return this.withNode(node, () => {
      if (node.type === 'Assign') return env.define(node.name, this.evaluateExpression(node.value, env));
      if (node.type === 'CompoundAssign') {
        const current = env.get(node.name);
        const right = this.evaluateExpression(node.value, env);
        return env.set(node.name, this.applyBinary(node.op, current, right));
      }
      if (node.type === 'If') return this.evaluateIf(node, env);
      if (node.type === 'For') return this.evaluateFor(node, env);
      if (node.type === 'While') return this.evaluateWhile(node, env);
      if (node.type === 'Break') return { __break: true };
      if (node.type === 'Continue') return { __continue: true };
      if (node.type === 'ExpressionStatement') return this.evaluateExpression(node.expression, env);
      if (node.type === 'Return') return { __return: true, value: this.evaluateExpression(node.value, env) };
      if (node.type === 'FunctionDeclaration') return this.defineFunction(node, env);
      if (node.type === 'ModelDeclaration') return this.defineModel(node, env);
      if (node.type === 'ForwardDeclaration') throw new Error('forward can only appear inside model');
      if (node.type === 'TrainDeclaration') throw new Error('train can only appear inside model');
      if (node.type === 'ValidateDeclaration') throw new Error('validate can only appear inside model');
      if (node.type === 'OptimizerDeclaration') throw new Error('optimizer can only appear inside model');
      if (node.type === 'DestructureAssign') return this.evaluateDestructure(node, env);
      if (node.type === 'IndexAssign') return this.evaluateIndexAssign(node, env);
      throw new Error(`Unsupported statement ${node.type}`);
    });
  }

  evaluateExpression(node, env) {
    return this.withNode(node, () => {
      if (node.type === 'Await') throw new Error('await requires executeAsync()');
      if (node.type === 'Literal') return node.value;
      if (node.type === 'Identifier') return env.get(node.name);
      if (node.type === 'Array') {
        const elements = [];
        for (const x of node.elements) elements.push(this.evaluateExpression(x, env));
        return elements;
      }
      if (node.type === 'Dict') {
        const map = new Map();
        for (const entry of node.entries) {
          map.set(this.evaluateExpression(entry.key, env), this.evaluateExpression(entry.value, env));
        }
        return map;
      }
      if (node.type === 'ListComprehension') return this.evaluateComprehension(node, env);
      if (node.type === 'Unary') {
        const value = this.evaluateExpression(node.value, env);
        if (node.op === '-') return this.applyUnaryMinus(value);
        if (node.op === 'not') return this.applyUnaryNot(value);
        return value;
      }
      if (node.type === 'Binary') {
        if (node.op === 'and' || node.op === 'or') {
          const left = this.evaluateExpression(node.left, env);
          if (!isTensorValue(left)) {
            if (node.op === 'and') return left ? this.evaluateExpression(node.right, env) : left;
            return left ? left : this.evaluateExpression(node.right, env);
          }
          const right = this.evaluateExpression(node.right, env);
          return this.applyBinary(node.op, left, right);
        }
        return this.applyBinary(node.op, this.evaluateExpression(node.left, env), this.evaluateExpression(node.right, env));
      }
      if (node.type === 'Member') {
        const object = this.evaluateExpression(node.object, env);
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
      if (node.type === 'Index') return this.evaluateIndex(node, env);
      if (node.type === 'Call') return this.evaluateCall(node, env);
      throw new Error(`Unsupported expression ${node.type}`);
    });
  }

  evaluateCall(node, env) {
    const callable = this.evaluateExpression(node.callee, env);
    const positional = [];
    const named = {};
    for (const arg of node.args) {
      const value = this.evaluateExpression(arg.value, env);
      if (arg.name) named[arg.name] = value;
      else positional.push(value);
    }
    if (Object.keys(named).length > 0) positional.push({ __named: true, ...named });
    let result;
    if (callable instanceof Module) result = callable.forward(...positional);
    else if (callable && typeof callable.forward === 'function' && typeof callable !== 'function') result = callable.forward(...positional);
    else if (typeof callable !== 'function') throw new Error('Value is not callable');
    else result = callable(...positional);
    return this.requireSync(result);
  }

  async evaluateProgramAsync(program, env) {
    if (!program.async) return this.evaluateProgram(program, env);
    let value;
    for (const statement of program.body) {
      const result = !statement.async ? this.evaluateStatement(statement, env) : await this.evaluateStatementAsync(statement, env);
      if (result && (result.__return || result.__break || result.__continue)) return result;
      value = result;
    }
    return value;
  }

  async evaluateStatementAsync(node, env) {
    if (!node.async) return this.evaluateStatement(node, env);
    return this.withNodeAsync(node, async () => {
      if (node.type === 'Assign') return env.define(node.name, await this.evaluateExpressionAsync(node.value, env));
      if (node.type === 'CompoundAssign') {
        const current = env.get(node.name);
        const right = await this.evaluateExpressionAsync(node.value, env);
        return env.set(node.name, this.applyBinary(node.op, current, right));
      }
      if (node.type === 'If') return await this.evaluateIfAsync(node, env);
      if (node.type === 'For') return await this.evaluateForAsync(node, env);
      if (node.type === 'While') return await this.evaluateWhileAsync(node, env);
      if (node.type === 'ExpressionStatement') return await this.evaluateExpressionAsync(node.expression, env);
      if (node.type === 'Return') return { __return: true, value: await this.evaluateExpressionAsync(node.value, env) };
      if (node.type === 'DestructureAssign') return await this.evaluateDestructureAsync(node, env);
      if (node.type === 'IndexAssign') return await this.evaluateIndexAssignAsync(node, env);
      return this.evaluateStatement(node, env);
    });
  }

  async evaluateExpressionAsync(node, env) {
    if (!node.async && node.type !== 'Await') return this.evaluateExpression(node, env);
    return this.withNodeAsync(node, async () => {
      if (node.type === 'Await') return await this.evaluateExpressionAsync(node.value, env);
      if (node.type === 'Array') {
        const elements = [];
        for (const x of node.elements) elements.push(!x.async ? this.evaluateExpression(x, env) : await this.evaluateExpressionAsync(x, env));
        return elements;
      }
      if (node.type === 'Dict') {
        const map = new Map();
        for (const entry of node.entries) {
          const key = !entry.key.async ? this.evaluateExpression(entry.key, env) : await this.evaluateExpressionAsync(entry.key, env);
          const value = !entry.value.async ? this.evaluateExpression(entry.value, env) : await this.evaluateExpressionAsync(entry.value, env);
          map.set(key, value);
        }
        return map;
      }
      if (node.type === 'ListComprehension') return await this.evaluateComprehensionAsync(node, env);
      if (node.type === 'Unary') {
        const value = await this.evaluateExpressionAsync(node.value, env);
        if (node.op === '-') return this.applyUnaryMinus(value);
        if (node.op === 'not') return this.applyUnaryNot(value);
        return value;
      }
      if (node.type === 'Binary') {
        if (node.op === 'and' || node.op === 'or') {
          const left = await this.evaluateExpressionAsync(node.left, env);
          if (!isTensorValue(left)) {
            if (node.op === 'and') return left ? await this.evaluateExpressionAsync(node.right, env) : left;
            return left ? left : await this.evaluateExpressionAsync(node.right, env);
          }
          const right = await this.evaluateExpressionAsync(node.right, env);
          return this.applyBinary(node.op, left, right);
        }
        return this.applyBinary(node.op, !node.left.async ? this.evaluateExpression(node.left, env) : await this.evaluateExpressionAsync(node.left, env), !node.right.async ? this.evaluateExpression(node.right, env) : await this.evaluateExpressionAsync(node.right, env));
      }
      if (node.type === 'Member') return this.evaluateExpression(node, env);
      if (node.type === 'Index') return await this.evaluateIndexAsync(node, env);
      if (node.type === 'Call') return await this.evaluateCallAsync(node, env);
      return this.evaluateExpression(node, env);
    });
  }

  async evaluateCallAsync(node, env) {
    const callable = !node.callee.async ? this.evaluateExpression(node.callee, env) : await this.evaluateExpressionAsync(node.callee, env);
    const positional = [];
    const named = {};
    for (const arg of node.args) {
      const value = !arg.value.async ? this.evaluateExpression(arg.value, env) : await this.evaluateExpressionAsync(arg.value, env);
      if (arg.name) named[arg.name] = value;
      else positional.push(value);
    }
    if (Object.keys(named).length > 0) positional.push({ __named: true, ...named });
    if (callable instanceof Module) return callable.forward(...positional);
    if (callable && typeof callable.forward === 'function' && typeof callable !== 'function') return callable.forward(...positional);
    if (typeof callable !== 'function') throw new Error('Value is not callable');
    return callable(...positional);
  }

  applyUnaryMinus(value) {
    if (isTensorValue(value)) return neg(value);
    return -value;
  }

  applyUnaryNot(value) {
    if (isTensorValue(value)) {
      const one = ones(value.shape, { dtype: value.dtype, device: value.device });
      return sub(one, value);
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
      '+': add, '-': sub, '*': mul, '/': div, '**': pow, '@': matmul,
      '%': (a, b) => {
        const q = div(a, b);
        return sub(a, mul(mul(sign(q), floor(abs(q))), b));
      },
      '==': eq, '!=': ne, '<': lt, '<=': le, '>': gt, '>=': ge,
      'and': mul,
      'or': (a, b) => sub(add(a, b), mul(a, b)),
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

  evaluateIf(node, env) {
    if (this.isTruthy(this.evaluateExpression(node.condition, env))) {
      return this.evaluateProgram({ type: 'Program', body: node.body }, env);
    }
    for (const elif of node.elifs) {
      if (this.isTruthy(this.evaluateExpression(elif.condition, env))) {
        return this.evaluateProgram({ type: 'Program', body: elif.body }, env);
      }
    }
    if (node.elseBody) {
      return this.evaluateProgram({ type: 'Program', body: node.elseBody }, env);
    }
    return undefined;
  }

  evaluateFor(node, env) {
    const iterable = this.evaluateExpression(node.iterable, env);
    const items = Array.isArray(iterable) ? iterable : iterable instanceof Map ? [...iterable.keys()] : null;
    if (!items) throw new Error('for...in expects an array or map');
    let value;
    for (const item of items) {
      env.define(node.variable, item);
      const result = this.evaluateProgram({ type: 'Program', body: node.body }, env);
      if (result && result.__return) return result;
      if (result && result.__break) break;
      if (result && result.__continue) continue;
      value = result;
    }
    return value;
  }

  evaluateWhile(node, env) {
    let value;
    while (this.isTruthy(this.evaluateExpression(node.condition, env))) {
      const result = this.evaluateProgram({ type: 'Program', body: node.body }, env);
      if (result && result.__return) return result;
      if (result && result.__break) break;
      if (result && result.__continue) continue;
      value = result;
    }
    return value;
  }

  defineFunction(node, declarationEnv) {
    const runtime = this;
    const asyncFunction = node.functionEffect === 'async';
    const run = asyncFunction ? runtime.evaluateProgramAsync.bind(runtime) : runtime.evaluateProgram.bind(runtime);
    const func = asyncFunction ? async (...args) => {
      const callEnv = new Environment(declarationEnv);
      node.params.forEach((name, i) => callEnv.define(name, args[i]));
      const result = await run({ type: 'Program', body: node.body, async: true }, callEnv);
      return result && result.__return ? result.value : result;
    } : (...args) => {
      const callEnv = new Environment(declarationEnv);
      node.params.forEach((name, i) => callEnv.define(name, args[i]));
      const result = run({ type: 'Program', body: node.body, async: false }, callEnv);
      return result && result.__return ? result.value : result;
    };
    func._langName = node.name;
    declarationEnv.define(node.name, func);
    this.signatureRegistry.register(node.name, node.params.map(name => ({ name })));
    return func;
  }

  evaluateDestructure(node, env) {
    const value = this.evaluateExpression(node.value, env);
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

    const factory = (...args) => {
      const named = takeNamed(args);
      const modelEnv = new Environment(declarationEnv);
      node.params.forEach((name, i) => modelEnv.define(name, named[name] ?? args[i]));
      const runForward = forward.async ? runtime.evaluateProgramAsync.bind(runtime) : runtime.evaluateProgram.bind(runtime);

      class LangModel extends BaseClass {
        constructor() {
          super();
          this._langName = modelName;
        }
        forward(...inputs) {
          const callEnv = new Environment(modelEnv);
          for (const field of fields) {
            if (field.type === 'Assign') callEnv.define(field.name, this[field.name]);
          }
          forward.params.forEach((name, i) => callEnv.define(name, inputs[i]));
          const result = runForward({ type: 'Program', body: forward.body, async: forward.async === true }, callEnv);
          return forward.async ? result.then(value => value && value.__return ? value.value : value) : (result && result.__return ? result.value : result);
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
          const result = await runtime.evaluateProgramAsync({ type: 'Program', body: trainBlock.body, async: true }, callEnv);
          return result && result.__return ? result.value : result;
        };
      }

      if (validateBlock) {
        LangModel.prototype.validationStep = async function(batch, batchIdx) {
          const callEnv = buildStepEnv(this, modelEnv, fields, modelName);
          bindLog(callEnv, this);
          if (validateBlock.params[0]) callEnv.define(validateBlock.params[0], batch);
          if (validateBlock.params[1]) callEnv.define(validateBlock.params[1], batchIdx);
          const result = await runtime.evaluateProgramAsync({ type: 'Program', body: validateBlock.body, async: true }, callEnv);
          return result && result.__return ? result.value : result;
        };
      }

      if (optimizerBlock) {
        LangModel.prototype.configureOptimizers = async function() {
          const callEnv = buildStepEnv(this, modelEnv, fields, modelName);
          const result = await runtime.evaluateProgramAsync({ type: 'Program', body: optimizerBlock.body, async: true }, callEnv);
          return result && result.__return ? result.value : result;
        };
      }

      const instance = new LangModel();
      for (const field of fields) {
        const value = runtime.evaluateStatement(field, modelEnv);
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

  evaluateIndex(node, env) {
    let value = this.evaluateExpression(node.object, env);
    if (Array.isArray(value)) return this.indexArray(value, node.items, env);
    if (value instanceof Map) return this.indexMap(value, node.items, env);
    if (typeof value === 'string') return this.indexString(value, node.items, env);
    if (!(value instanceof Tensor)) throw new Error('Indexing currently expects a Tensor, array, map, or string');
    let dim = 0;
    for (const item of node.items) {
      if (dim >= value.ndim) throw new Error(`Too many indices for tensor with ${value.ndim} dimensions`);
      if (item.type === 'Slice') {
        const start = item.start ? this.evaluateExpression(item.start, env) : 0;
        const end = item.end ? this.evaluateExpression(item.end, env) : value.shape[dim];
        const step = item.step ? this.evaluateExpression(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        value = value.slice(dim, start, end, step);
        dim++;
      } else {
        let index = this.evaluateExpression(item, env);
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

  indexArray(value, items, env) {
    let current = value;
    for (const item of items) {
      if (!Array.isArray(current)) throw new Error('Too many indices for array');
      if (item.type === 'Slice') {
        const len = current.length;
        let start = item.start ? this.evaluateExpression(item.start, env) : 0;
        let end = item.end ? this.evaluateExpression(item.end, env) : len;
        const step = item.step ? this.evaluateExpression(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        if (start < 0) start += len;
        if (end < 0) end += len;
        const out = [];
        for (let i = Math.max(0, start); i < Math.min(len, end); i += step) out.push(current[i]);
        current = out;
      } else {
        let index = this.evaluateExpression(item, env);
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

  indexMap(value, items, env) {
    let current = value;
    for (const item of items) {
      if (!(current instanceof Map)) throw new Error('Too many indices for map');
      if (item.type === 'Slice') throw new Error('Cannot slice a map');
      const key = this.evaluateExpression(item, env);
      current = current.has(key) ? current.get(key) : null;
    }
    return current;
  }

  indexString(value, items, env) {
    let current = value;
    for (const item of items) {
      if (typeof current !== 'string') throw new Error('Too many indices for string');
      if (item.type === 'Slice') {
        const len = current.length;
        let start = item.start ? this.evaluateExpression(item.start, env) : 0;
        let end = item.end ? this.evaluateExpression(item.end, env) : len;
        const step = item.step ? this.evaluateExpression(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        if (start < 0) start += len;
        if (end < 0) end += len;
        let out = '';
        for (let i = Math.max(0, start); i < Math.min(len, end); i += step) out += current[i];
        current = out;
      } else {
        let index = this.evaluateExpression(item, env);
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

  evaluateComprehension(node, env) {
    const iterable = this.evaluateExpression(node.iterable, env);
    const items = Array.isArray(iterable) ? iterable : iterable instanceof Map ? [...iterable.keys()] : null;
    if (!items) throw new Error('Comprehension expects an array or map');
    const scope = new Environment(env);
    const result = [];
    for (const item of items) {
      scope.define(node.variable, item);
      if (node.condition && !this.isTruthy(this.evaluateExpression(node.condition, scope))) continue;
      result.push(this.evaluateExpression(node.expr, scope));
    }
    return result;
  }

  evaluateIndexAssign(node, env) {
    let container = this.evaluateExpression(node.object, env);
    const keys = [];
    for (const item of node.items) {
      if (item.type === 'Slice') throw new Error('Slice assignment is not supported');
      keys.push(this.evaluateExpression(item, env));
    }
    for (let d = 0; d < keys.length - 1; d++) container = this.readContainer(container, keys[d]);
    const key = keys[keys.length - 1];
    let value = this.evaluateExpression(node.value, env);
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

  withNode(node, evaluate) {
    const previous = this.currentNode;
    this.currentNode = node;
    try {
      return evaluate();
    } catch (error) {
      if (error.line !== undefined) throw error;
      throw new LangRuntimeError(error.message, node.line ?? 1, node.column ?? 1, error);
    } finally {
      this.currentNode = previous;
    }
  }

  requireSync(value) {
    if (isThenable(value)) throw new Error('Async value used without await');
    return value;
  }

  async withNodeAsync(node, evaluate) {
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

  async evaluateIndexAsync(node, env) {
    let value = !node.object.async ? this.evaluateExpression(node.object, env) : await this.evaluateExpressionAsync(node.object, env);
    if (Array.isArray(value)) return await this.indexArrayAsync(value, node.items, env);
    if (value instanceof Map) return await this.indexMapAsync(value, node.items, env);
    if (typeof value === 'string') return await this.indexStringAsync(value, node.items, env);
    if (!(value instanceof Tensor)) throw new Error('Indexing currently expects a Tensor, array, map, or string');
    let dim = 0;
    for (const item of node.items) {
      if (dim >= value.ndim) throw new Error(`Too many indices for tensor with ${value.ndim} dimensions`);
      if (item.type === 'Slice') {
        const start = item.start ? await this.evaluateExpressionAsync(item.start, env) : 0;
        const end = item.end ? await this.evaluateExpressionAsync(item.end, env) : value.shape[dim];
        const step = item.step ? await this.evaluateExpressionAsync(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        value = value.slice(dim, start, end, step);
        dim++;
      } else {
        let index = !item.async ? this.evaluateExpression(item, env) : await this.evaluateExpressionAsync(item, env);
        if (!Number.isInteger(index)) throw new Error('Tensor index must be an integer');
        if (index < 0) index += value.shape[dim];
        if (index < 0 || index >= value.shape[dim]) throw new Error(`Index ${index} is out of bounds for dimension ${dim} with size ${value.shape[dim]}`);
        value = value.select(dim, index);
        if (value.ndim === 0) return value.item();
      }
    }
    return value;
  }

  async indexArrayAsync(value, items, env) {
    let current = value;
    for (const item of items) {
      if (!Array.isArray(current)) throw new Error('Too many indices for array');
      if (item.type === 'Slice') {
        const len = current.length;
        let start = item.start ? await this.evaluateExpressionAsync(item.start, env) : 0;
        let end = item.end ? await this.evaluateExpressionAsync(item.end, env) : len;
        const step = item.step ? await this.evaluateExpressionAsync(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        if (start < 0) start += len;
        if (end < 0) end += len;
        const out = [];
        for (let i = Math.max(0, start); i < Math.min(len, end); i += step) out.push(current[i]);
        current = out;
      } else {
        let index = !item.async ? this.evaluateExpression(item, env) : await this.evaluateExpressionAsync(item, env);
        if (!Number.isInteger(index)) throw new Error('Array index must be an integer');
        if (index < 0) index += current.length;
        if (index < 0 || index >= current.length) throw new Error(`Index ${index} is out of bounds for array of length ${current.length}`);
        current = current[index];
      }
    }
    return current;
  }

  async indexMapAsync(value, items, env) {
    let current = value;
    for (const item of items) {
      if (!(current instanceof Map)) throw new Error('Too many indices for map');
      if (item.type === 'Slice') throw new Error('Cannot slice a map');
      const key = !item.async ? this.evaluateExpression(item, env) : await this.evaluateExpressionAsync(item, env);
      current = current.has(key) ? current.get(key) : null;
    }
    return current;
  }

  async indexStringAsync(value, items, env) {
    let current = value;
    for (const item of items) {
      if (typeof current !== 'string') throw new Error('Too many indices for string');
      if (item.type === 'Slice') {
        const len = current.length;
        let start = item.start ? await this.evaluateExpressionAsync(item.start, env) : 0;
        let end = item.end ? await this.evaluateExpressionAsync(item.end, env) : len;
        const step = item.step ? await this.evaluateExpressionAsync(item.step, env) : 1;
        if (![start, end, step].every(Number.isInteger)) throw new Error('Slice bounds must be integers');
        if (step <= 0) throw new Error('Slice step must be a positive integer');
        if (start < 0) start += len;
        if (end < 0) end += len;
        let out = '';
        for (let i = Math.max(0, start); i < Math.min(len, end); i += step) out += current[i];
        current = out;
      } else {
        let index = !item.async ? this.evaluateExpression(item, env) : await this.evaluateExpressionAsync(item, env);
        if (!Number.isInteger(index)) throw new Error('String index must be an integer');
        if (index < 0) index += current.length;
        if (index < 0 || index >= current.length) throw new Error(`Index ${index} is out of bounds for string of length ${current.length}`);
        current = current[index];
      }
    }
    return current;
  }

  async evaluateComprehensionAsync(node, env) {
    const iterable = !node.iterable.async ? this.evaluateExpression(node.iterable, env) : await this.evaluateExpressionAsync(node.iterable, env);
    const items = Array.isArray(iterable) ? iterable : iterable instanceof Map ? [...iterable.keys()] : null;
    if (!items) throw new Error('Comprehension expects an array or map');
    const scope = new Environment(env);
    const result = [];
    for (const item of items) {
      scope.define(node.variable, item);
      if (node.condition && !this.isTruthy(!node.condition.async ? this.evaluateExpression(node.condition, scope) : await this.evaluateExpressionAsync(node.condition, scope))) continue;
      result.push(!node.expr.async ? this.evaluateExpression(node.expr, scope) : await this.evaluateExpressionAsync(node.expr, scope));
    }
    return result;
  }

  async evaluateDestructureAsync(node, env) {
    const value = !node.value.async ? this.evaluateExpression(node.value, env) : await this.evaluateExpressionAsync(node.value, env);
    if (!Array.isArray(value)) throw new Error('Destructuring requires an array value');
    if (value.length < node.names.length) throw new Error(`Not enough values to unpack (expected ${node.names.length}, got ${value.length})`);
    for (let i = 0; i < node.names.length; i++) env.define(node.names[i], value[i]);
    return value;
  }

  async evaluateIndexAssignAsync(node, env) {
    let container = !node.object.async ? this.evaluateExpression(node.object, env) : await this.evaluateExpressionAsync(node.object, env);
    const keys = [];
    for (const item of node.items) {
      if (item.type === 'Slice') throw new Error('Slice assignment is not supported');
      keys.push(!item.async ? this.evaluateExpression(item, env) : await this.evaluateExpressionAsync(item, env));
    }
    for (let d = 0; d < keys.length - 1; d++) container = this.readContainer(container, keys[d]);
    const key = keys[keys.length - 1];
    let value = !node.value.async ? this.evaluateExpression(node.value, env) : await this.evaluateExpressionAsync(node.value, env);
    if (node.op) value = this.applyBinary(node.op, this.readContainer(container, key), value);
    this.writeContainer(container, key, value);
    return value;
  }

  async evaluateIfAsync(node, env) {
    if (this.isTruthy(await this.evaluateExpressionAsync(node.condition, env))) {
      return await this.evaluateProgramAsync({ type: 'Program', body: node.body, effect: node.effect }, env);
    }
    for (const elif of node.elifs) {
      if (this.isTruthy(await this.evaluateExpressionAsync(elif.condition, env))) {
        return await this.evaluateProgramAsync({ type: 'Program', body: elif.body, effect: node.effect }, env);
      }
    }
    if (node.elseBody) return await this.evaluateProgramAsync({ type: 'Program', body: node.elseBody, effect: node.effect }, env);
    return undefined;
  }

  async evaluateForAsync(node, env) {
    const iterable = await this.evaluateExpressionAsync(node.iterable, env);
    const items = Array.isArray(iterable) ? iterable : iterable instanceof Map ? [...iterable.keys()] : null;
    if (!items) throw new Error('for...in expects an array or map');
    let value;
    for (const item of items) {
      env.define(node.variable, item);
      const result = await this.evaluateProgramAsync({ type: 'Program', body: node.body, effect: node.effect }, env);
      if (result && result.__return) return result;
      if (result && result.__break) break;
      if (result && result.__continue) continue;
      value = result;
    }
    return value;
  }

  async evaluateWhileAsync(node, env) {
    let value;
    while (this.isTruthy(await this.evaluateExpressionAsync(node.condition, env))) {
      const result = await this.evaluateProgramAsync({ type: 'Program', body: node.body, effect: node.effect }, env);
      if (result && result.__return) return result;
      if (result && result.__break) break;
      if (result && result.__continue) continue;
      value = result;
    }
    return value;
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
    const target = targetName === 'gpu' ? CUDATarget() : targetName === 'wasm' ? WasmTarget() : targetName === 'webgpu' ? WebGPUTarget() : CPUTarget();
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

function isThenable(value) {
  return value && typeof value.then === 'function';
}

function isDataFrameValue(value) {
  return value && typeof value.select === 'function' && typeof value.collect === 'function' && typeof value.count === 'function';
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
  if (!isTensorValue(left)) left = tensor(left, options);
  if (!isTensorValue(right)) right = tensor(right, options);
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
