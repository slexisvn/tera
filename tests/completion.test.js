import { describe, expect, it } from 'vitest';
import { completeInput, shutdownTerminal, tokenHook } from '../src/repl.js';
import { TeraRuntime } from '../src/runtime.js';

describe('Tera completion', () => {
  it('completes builtins and preserves the expression prefix', () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(completeInput('linsp', runtime)).toBe('linspace');
    const randResult = completeInput('x = rand', runtime);
    expect(Array.isArray(randResult)).toBe(true);
    expect(randResult).toContain('randn');
    expect(randResult).toContain('randperm');
    expect(completeInput('mod', runtime)).toBe('model');
    expect(completeInput('ret', runtime)).toBe('return');
  });

  it('includes names created during the session', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute('weights = randn([2, 2])');
    expect(completeInput('wei', runtime)).toBe('weights');
  });

  it('completes user-defined functions and model names', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute('fn my_normalize(x): return x / x.sum()');
    expect(completeInput('my_n', runtime)).toBe('my_normalize');

    await runtime.execute(`model MyNet:
  forward x:
    return x.relu()`);
    expect(completeInput('MyN', runtime)).toBe('MyNet');
  });

  it('completes properties of custom model instances', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute(`model MLP(h):
  fc1 = Linear(2, h)
  fc2 = Linear(h, 1)
  forward x:
    return fc2(fc1(x).relu())`);
    await runtime.execute('net = MLP(4)');

    expect(completeInput('net.f', runtime)).toBe('net.fc');
    const props = completeInput('net.fc', runtime);
    expect(Array.isArray(props)).toBe(true);
    expect(props).toContain('fc1');
    expect(props).toContain('fc2');
  });

  it('completes properties of builtin modules', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute('layer = Linear(4, 2)');
    expect(completeInput('layer.w', runtime)).toBe('layer.weight');
  });

  it('suggests names from the current buffer before execution', () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const buffer = `model MLP(h):
  fc1 = Linear(2, h)
  fc2 = Linear(h, 1)
  forward x:
`;
    const result = completeInput('fc', runtime, buffer);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toContain('fc1');
    expect(result).toContain('fc2');

    expect(completeInput('ML', runtime, buffer)).toBe('MLP');

    expect(completeInput('x = f', runtime, buffer)).toContain('fc1');
  });

  it('returns alternatives for ambiguous input', () => {
    const runtime = new TeraRuntime({ output: () => {} });
    const result = completeInput('help ', runtime);
    expect(result).toBe('help ');

    const alternatives = completeInput('ex', runtime);
    expect(Array.isArray(alternatives)).toBe(true);
    expect(alternatives).toContain('examples');
    expect(alternatives).toContain('exit');
  });

  it('assigns syntax styles through terminal-kit token hooks', () => {
    const term = {
      brightBlack: 'dim',
      green: 'string',
      magenta: 'number',
      brightBlue: 'keyword',
      yellow: 'builtin',
      cyan: 'type',
    };
    expect(tokenHook('model', false, [], term)).toBe('keyword');
    expect(tokenHook('42', false, [], term)).toBe('number');
    expect(tokenHook('@', false, [], term)).toBe('dim');
    expect(tokenHook('Linear', false, [], term)).toBe('type');
    expect(tokenHook('relu', false, [], term)).toBe('builtin');
    expect(tokenHook('tensor', false, [], term)).toBe('builtin');
    expect(tokenHook('print', false, [], term)).toBe('builtin');
  });

  it('hints param name matching typed prefix inside function calls', () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(completeInput('compile(mod', runtime)).toBe('compile(model');
    expect(completeInput('compile(m, in', runtime)).toBe('compile(m, input');
    expect(completeInput('compile(m, tar', runtime)).toBe('compile(m, target=cpu');
    expect(completeInput('compile(m, de', runtime)).toBe('compile(m, debug');
    expect(completeInput('Linear(64, out', runtime)).toBe('Linear(64, outFeatures');
    expect(completeInput('Linear(64, bi', runtime)).toBe('Linear(64, bias=true');
  });

  it('does not hint when typing values or no prefix', () => {
    const runtime = new TeraRuntime({ output: () => {} });
    expect(completeInput('compile(', runtime)).toBe('compile(');
    expect(completeInput('compile(m, ', runtime)).toBe('compile(m, ');
    expect(completeInput('compile(m, input=2', runtime)).toBe('compile(m, input=2');
    expect(completeInput('compile(m, x', runtime)).toBe('compile(m, x');
  });

  it('hints param names for user-defined functions', async () => {
    const runtime = new TeraRuntime({ output: () => {} });
    await runtime.execute('fn apply(weights, data, scale): return weights');
    expect(completeInput('apply(wei', runtime)).toBe('apply(weights');
    expect(completeInput('apply(w, da', runtime)).toBe('apply(w, data');
    expect(completeInput('apply(w, d, sc', runtime)).toBe('apply(w, d, scale');
  });

  it('restores terminal state before exiting', () => {
    const calls = [];
    const term = {
      grabInput: value => calls.push(['grabInput', value]),
      hideCursor: value => calls.push(['hideCursor', value]),
      styleReset: () => calls.push(['styleReset']),
    };
    shutdownTerminal(term);
    expect(calls).toEqual([['grabInput', false], ['hideCursor', false], ['styleReset']]);
  });

});
