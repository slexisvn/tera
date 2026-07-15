import terminalKit from 'terminal-kit';
import { formatValue } from './format.js';
import { TeraRuntime } from './runtime.js';
import { BANNER, handleReplCommand } from './help.js';
import { formatDiagnostic } from './diagnostics.js';
import { parseCallContext } from './call_context.js';

const KEYWORDS = new Set([
  'model', 'forward', 'return', 'true', 'false', 'null',
  'and', 'or', 'not', 'fn',
  'if', 'else', 'for', 'in', 'while', 'break', 'continue',
]);
const BUILTINS = new Set([
  'tensor', 'zeros', 'ones', 'empty', 'full', 'randn', 'arange', 'eye', 'linspace',
  'zerosLike', 'onesLike', 'emptyLike', 'fullLike', 'randnLike',
  'add', 'sub', 'mul', 'div', 'neg', 'pow', 'remainder', 'maximum', 'minimum',
  'exp', 'log', 'sqrt', 'rsqrt', 'abs', 'sin', 'cos', 'tanh', 'sigmoid', 'relu',
  'gelu', 'silu', 'sign', 'floor', 'ceil', 'eq', 'ne', 'lt', 'le', 'gt', 'ge',
  'where', 'matmul', 'dot', 'cat', 'stack', 'clone', 'softmax', 'log_softmax',
  'sum', 'mean', 'max', 'min', 'argmax', 'argmin', 'prod',
  'reshape', 'transpose', 'permute', 'expand', 'slice', 'unsqueeze', 'squeeze',
  'narrow', 'select', 'contiguous', 'detach', 'requires_grad', 'grad', 'backward',
  'range', 'len', 'shape', 'dtype', 'print', 'trace', 'graph', 'compile',
]);
const COMMANDS = ['help', 'help tensor', 'help model', 'help fn', 'help control', 'help compile', 'examples',
  'example tensor', 'example linear', 'example custom', 'example compile', 'exit', 'quit'];

export async function startRepl({ term = terminalKit.terminal } = {}) {
  const write = text => term.noFormat(String(text) + '\n');
  const runtime = new TeraRuntime({ output: write });
  const history = [];
  let buffer = '';
  let depth = 0;
  let interrupted = false;

  term(BANNER + '\n');

  while (true) {
    term(depth > 0 ? '^K...   ^:' : '^Kmlfw> ^:');
    const controller = term.inputField({
      history,
      autoComplete: input => completeInput(input, runtime, buffer),
      autoCompleteHint: true,
      autoCompleteMenu: {
        style: term.brightBlack,
        selectedStyle: term.bgCyan.black,
      },
      cancelable: true,
      autoClosePairs: {
        '(': ')',
        '[': ']',
        '"': '"',
        "'": "'",
      },
      tokenRegExp: /#[^\n]*|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|\*\*=?|==|!=|<=|>=|[+\-*\/@]=|[^\s]/g,
      tokenHook,
    });
    const onKey = key => {
      if (key !== 'CTRL_C') return;
      interrupted = true;
      controller.stop();
    };
    const onSigint = () => {
      interrupted = true;
      controller.stop();
    };
    term.on('key', onKey);
    process.once('SIGINT', onSigint);

    let line;
    try {
      line = await controller.promise;
    } finally {
      term.removeListener('key', onKey);
      process.removeListener('SIGINT', onSigint);
    }
    term('\n');
    if (interrupted) {
      shutdownTerminal(term);
      term.brightBlack('^C\n');
      process.exitCode = 130;
      break;
    }
    if (line === undefined || (!buffer && (line.trim() === 'exit' || line.trim() === 'quit'))) {
      term.brightBlack('Bye.\n');
      break;
    }
    if (line.trim()) history.push(line);

    if (!buffer) {
      const commandOutput = handleReplCommand(line);
      if (commandOutput !== null) {
        write(commandOutput);
        continue;
      }
    }

    buffer += line + '\n';

    if (line.trim().endsWith(':')) {
      depth = 1;
    } else if (depth > 0 && line.trim() === '') {
      depth = 0;
    } else {
      depth += bracketDelta(line);
    }
    if (depth > 0) continue;

    try {
      const value = await runtime.execute(buffer);
      const text = formatValue(value);
      if (text) write(text);
    } catch (error) {
      term.red.noFormat(`${formatDiagnostic(error, buffer)}\n`);
    }
    buffer = '';
    depth = 0;
  }

  shutdownTerminal(term);
  return { runtime, history };
}

export function shutdownTerminal(term) {
  if (typeof term.grabInput === 'function') term.grabInput(false);
  if (typeof term.hideCursor === 'function') term.hideCursor(false);
  if (typeof term.styleReset === 'function') term.styleReset();
}

export function completeInput(input, runtime, buffer = '') {
  const ctx = parseCallContext(input);
  if (ctx) {
    const sig = runtime.signatureRegistry.lookup(ctx.functionName);
    if (sig) {
      const hint = formatParamHint(input, sig);
      if (hint !== input) return hint;
    }
  }

  const dotMatch = input.match(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/);
  if (dotMatch) {
    const obj = runtime.getVariable(dotMatch[1]);
    if (obj != null && typeof obj === 'object') {
      const propPrefix = dotMatch[2] || '';
      const pre = input.slice(0, dotMatch.index) + dotMatch[1] + '.';
      const props = Object.keys(obj)
        .filter(k => !k.startsWith('_') && k !== 'constructor')
        .filter(k => k.startsWith(propPrefix))
        .sort();
      if (props.length === 0) return input;
      if (props.length === 1) return pre + props[0];
      const common = commonPrefix(props);
      if (common.length > propPrefix.length) return pre + common;
      props.prefix = pre;
      return props;
    }
    return input;
  }

  const match = input.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  if (!match) return input;

  const prefix = input.slice(0, match.index);
  const word = match[0];
  const bufferNames = extractBufferNames(buffer);
  const candidates = [...new Set([...COMMANDS, ...KEYWORDS, ...runtime.getCompletionNames(), ...bufferNames])]
    .filter(name => name.startsWith(word))
    .sort();

  if (candidates.length === 0) return input;
  if (candidates.length === 1) return prefix + candidates[0];
  const common = commonPrefix(candidates);
  if (common.length > word.length) return prefix + common;
  candidates.prefix = prefix;
  return candidates;
}

function extractBufferNames(buffer) {
  if (!buffer) return [];
  const names = [];
  for (const m of buffer.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    const name = m[1];
    if (!KEYWORDS.has(name)) names.push(name);
  }
  for (const m of buffer.matchAll(/\b(?:fn|model)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.push(m[1]);
  }
  for (const m of buffer.matchAll(/\bforward\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.push(m[1]);
  }
  return names;
}

function commonPrefix(values) {
  let prefix = values[0] || '';
  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

export function tokenHook(token, _isEnd, _previous, term) {
  if (token.startsWith('#')) return term.brightBlack;
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return term.green;
  if (/^\d+(?:\.\d+)?$/.test(token)) return term.magenta;
  if (KEYWORDS.has(token)) return term.brightBlue;
  if (BUILTINS.has(token)) return term.yellow;
  if (/^(?:\*\*=?|==|!=|<=|>=|[+\-*\/@][=]?|[=<>])$/.test(token)) return term.brightBlack;
  if (/^[A-Z]/.test(token)) return term.cyan;
  return term;
}

function formatParamHint(input, sig) {
  const afterSep = input.match(/.*[,(]\s*(.*)$/s);
  if (!afterSep) return input;
  const typed = afterSep[1];
  if (!typed || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(typed)) return input;
  for (const p of sig.params) {
    const label = p.defaultValue != null ? `${p.name}=${p.defaultValue}` : p.name;
    if (label.startsWith(typed) && label !== typed) return input + label.slice(typed.length);
  }
  return input;
}

function bracketDelta(line) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
  }
  return depth;
}
