import fs from 'node:fs';
import { TeraRuntime } from './runtime.js';
import { checkSource } from './check.js';
import { buildMethodReturns } from './method_returns.js';
import { formatValue } from './format.js';
import { formatDiagnostic } from './diagnostics.js';
import { startRepl } from './repl.js';

let cachedMethodReturns;
function methodReturns() {
  if (cachedMethodReturns !== undefined) return cachedMethodReturns;
  try {
    const url = new URL('../../vscode-ext/language-data.json', import.meta.url);
    cachedMethodReturns = buildMethodReturns(JSON.parse(fs.readFileSync(url, 'utf8')));
  } catch {
    cachedMethodReturns = null;
  }
  return cachedMethodReturns;
}

export const CLI_USAGE = `Usage:
  mlfw                 Start the Tera REPL
  mlfw check <file>    Type-check a Tera file without executing
  mlfw <file>          Execute a Tera file (.tera)`;

function reportDiagnostics(diagnostics, source, filename, stderr) {
  for (const diagnostic of diagnostics) stderr(formatDiagnostic(diagnostic, source, filename));
  return diagnostics.length > 0;
}

export async function runCli(args, {
  stdout = console.log,
  stderr = console.error,
  readFile = file => fs.readFileSync(file, 'utf8'),
  repl = startRepl,
  stdinIsTTY = process.stdin.isTTY,
  readStdin = () => readStream(process.stdin),
} = {}) {
  const [command, operand, ...extra] = args;
  if (!command || command === 'repl') {
    if (operand || extra.length) return fail(stderr, 'repl does not accept arguments');
    if (!stdinIsTTY) {
      return await executeSource(await readStdin(), { stdout, stderr, filename: '<stdin>', stripExit: true });
    }
    await repl();
    return 0;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    stdout(CLI_USAGE);
    return 0;
  }

  const mode = command === 'run' || command === 'check' ? command : 'run';
  const file = mode === command ? operand : command;
  if (!file || extra.length || (mode !== command && operand)) {
    return fail(stderr, `Invalid arguments.\n\n${CLI_USAGE}`);
  }

  let source;
  try {
    source = readFile(file);
    if (mode === 'check') {
      const { diagnostics } = checkSource(source, { methodReturns: methodReturns() });
      if (reportDiagnostics(diagnostics, source, file, stderr)) return 1;
      stdout(`${file}: OK`);
      return 0;
    }
    return await executeSource(source, { stdout, stderr, filename: file });
  } catch (error) {
    stderr(source === undefined ? `${error.name || 'Error'}: ${error.message}` : formatDiagnostic(error, source, file));
    return 1;
  }
}

export async function executeSource(source, {
  stdout = console.log,
  stderr = console.error,
  filename = null,
  stripExit = false,
} = {}) {
  if (stripExit) source = source.replace(/(?:^|\n)\s*(?:exit|quit)\s*;?\s*$/u, '');
  try {
    const { diagnostics } = checkSource(source, { methodReturns: methodReturns() });
    if (reportDiagnostics(diagnostics, source, filename, stderr)) return 1;
    const result = await new TeraRuntime({ output: stdout }).execute(source);
    const text = formatValue(result);
    if (text) stdout(text);
    return 0;
  } catch (error) {
    stderr(formatDiagnostic(error, source, filename));
    return 1;
  }
}

function fail(stderr, message) {
  stderr(message);
  return 1;
}

async function readStream(stream) {
  let source = '';
  for await (const chunk of stream) source += chunk;
  return source;
}
