import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, inject, it } from "vitest";
import { removeDirectory } from "./workspace.js";
import { BINARY, INCLUDES, build } from "./c-toolchain.js";
import { cIdentifier } from "../../src/optimizing/backends/c/emit.js";
import { PROGRAM_ENTRY_NAME } from "../../src/optimizing/target/program-entry.js";
import type { AotProgram } from "../../src/optimizing/drivers/aot.js";

export type CArgument = number | string;

export interface CProgramRun {
  readonly status: number | null;
  readonly stdout: string;
}

export const cCompiler = inject("cCompiler");
export const itNative = it.skipIf(cCompiler === null);

const DEFINITION = /^(int32_t|double|void|tera_fn|const char \*|unsigned char \*)\s*(\w+)\s*\(([^)]*)\)\s*\{/gm;
const POINTER_PARAMETER = /^(const char|unsigned char) \*\w*$/;
const VALUE_PARAMETER = /^(int32_t|double|tera_fn)\s+\w+$/;
const LOCAL_INCLUDE = /^#include\s+"[^"]*"\s*$/gm;
const TOKEN = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_]\w*/g;
const NEWLINE = /\r\n/g;
const UNIT_SUFFIX = "_u";
const RUN_TIMEOUT_MS = 30_000;
const UNSELECTED_STATUS = 97;
const BATCH_SIZE = 64;
const TEXT_RETURN = "const char *";

interface Definition {
  readonly returns: string;
  readonly name: string;
  readonly params: string;
  readonly at: number;
}

interface Unit {
  readonly index: number;
  readonly head: string;
  readonly body: string;
  readonly prototypes: readonly string[];
  readonly renamed: ReadonlyMap<string, string>;
  readonly definitions: ReadonlyMap<string, Definition>;
}

interface Case {
  readonly declaration: string;
  readonly statements: readonly string[];
}

interface CaseResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Request {
  readonly make: () => string;
  readonly shape: (unit: Unit) => Case;
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

function attempt<T>(make: () => T): Outcome<T> {
  try {
    return { ok: true, value: make() };
  } catch (error) {
    return { ok: false, error };
  }
}

function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

function requireCompiler(): string {
  if (cCompiler === null) throw new Error("no C compiler available");
  return cCompiler;
}

export function cSource(program: AotProgram): string {
  const file = program.files.find((candidate) => candidate.name.endsWith(".c"));
  if (file === undefined) throw new Error("program has no C source file");
  return String(file.contents);
}

function definitionsOf(source: string): Definition[] {
  const found: Definition[] = [];
  DEFINITION.lastIndex = 0;
  for (let match = DEFINITION.exec(source); match !== null; match = DEFINITION.exec(source)) {
    found.push({ returns: match[1]!, name: match[2]!, params: match[3]!, at: match.index });
  }
  return found;
}

function parameterTypes(params: string): string[] {
  const trimmed = params.trim();
  if (trimmed.length === 0 || trimmed === "void") return [];
  return trimmed.split(",").map((param) => {
    const text = param.trim();
    const pointer = text.match(POINTER_PARAMETER);
    if (pointer !== null) return `${pointer[1]!} *`;
    const value = text.match(VALUE_PARAMETER);
    if (value === null) throw new Error(`unsupported parameter: ${param}`);
    return value[1]!;
  });
}

function literal(type: string, value: CArgument): string {
  if (type === TEXT_RETURN) {
    if (typeof value !== "string") throw new Error(`expected a string argument, got ${value}`);
    return JSON.stringify(value);
  }
  if (typeof value !== "number") throw new Error(`expected a numeric argument, got ${value}`);
  if (type === "int32_t") return `(int32_t)${Math.trunc(value)}`;
  const negative = value < 0 || Object.is(value, -0);
  return `${negative ? "-" : ""}${Math.abs(value).toExponential()}`;
}

function prototypeOf(definition: Definition): string {
  return `${definition.returns} ${definition.name}(${definition.params});`;
}

function renameSymbols(body: string, renamed: ReadonlyMap<string, string>): string {
  return body.replace(TOKEN, (token) =>
    token.startsWith('"') || token.startsWith("'") ? token : (renamed.get(token) ?? token),
  );
}

function makeUnit(source: string, index: number): Unit {
  const suffix = `${UNIT_SUFFIX}${index}`;
  const original = source.replace(LOCAL_INCLUDE, "");
  const renamed = new Map(definitionsOf(original).map(({ name }) => [name, `${name}${suffix}`]));
  const text = renameSymbols(original, renamed);
  const found = definitionsOf(text);
  const split = found.length === 0 ? text.length : found[0]!.at;
  return {
    index,
    head: text.slice(0, split),
    body: text.slice(split),
    prototypes: found.map(prototypeOf),
    renamed,
    definitions: new Map(found.map((definition) => [definition.name, definition])),
  };
}

function definitionIn(unit: Unit, symbol: string): Definition {
  const name = unit.renamed.get(cIdentifier(symbol));
  const definition = name === undefined ? undefined : unit.definitions.get(name);
  if (definition === undefined) throw new Error(`missing function ${symbol}`);
  return definition;
}

function programCase(unit: Unit): Case {
  const definition = definitionIn(unit, PROGRAM_ENTRY_NAME);
  return { declaration: prototypeOf(definition), statements: [`return (int)${definition.name}();`] };
}

function callCase(unit: Unit, symbol: string, args: readonly CArgument[]): Case {
  const definition = definitionIn(unit, symbol);
  const types = parameterTypes(definition.params);
  if (types.length !== args.length) {
    throw new Error(`expected ${types.length} args, got ${args.length}`);
  }
  const call = `${definition.name}(${types.map((type, index) => literal(type, args[index]!)).join(", ")})`;
  const print =
    definition.returns === TEXT_RETURN
      ? `printf("%s", ${call});`
      : `printf("%.17g\\n", (double)${call});`;
  return { declaration: prototypeOf(definition), statements: [print, "return 0;"] };
}

function dispatchMain(selected: ReadonlyMap<number, Case>): string {
  const branches: string[] = [];
  for (const [index, entry] of selected) {
    branches.push(`    case ${index}: {`, ...entry.statements.map((line) => `      ${line}`), "    }");
  }
  return [
    ...INCLUDES,
    ...[...selected.values()].map((entry) => entry.declaration),
    "int main(int argc, char **argv) {",
    "  switch (argc > 1 ? atoi(argv[1]) : -1) {",
    ...branches,
    "  }",
    `  return ${UNSELECTED_STATUS};`,
    "}",
    "",
  ].join("\n");
}

function link(
  directory: string,
  units: readonly Unit[],
  selected: ReadonlyMap<number, Case>,
  name: string,
): string {
  const compiler = requireCompiler();
  const sharing = new Map<string, Unit[]>();
  for (const unit of units) {
    const group = sharing.get(unit.head);
    if (group === undefined) sharing.set(unit.head, [unit]);
    else group.push(unit);
  }
  const sources = [...sharing].map(([head, group], index) => {
    const file = join(directory, `${name}-group${index}.c`);
    const prototypes = group.flatMap((unit) => unit.prototypes);
    const bodies = group.map((unit) => unit.body);
    writeFileSync(file, [...INCLUDES, head, ...prototypes, ...bodies].join("\n"));
    return file;
  });
  const main = join(directory, `${name}.c`);
  writeFileSync(main, dispatchMain(selected));
  const binary = join(directory, `${name}${BINARY}`);
  const built = build(compiler, [...sources, main], binary);
  if (built.status !== 0) throw new Error(`compilation failed:\n${built.stderr}`);
  return binary;
}

function runCase(binary: string, index: number): CaseResult {
  const run = spawnSync(binary, [String(index)], { encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  if (run.error !== undefined) throw run.error;
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function resolve(
  requests: readonly Request[],
  directory: string,
  label: string,
): Array<Outcome<CaseResult>> {
  const units = new Map<string, Unit>();
  const order: Unit[] = [];
  const owners = new Map<number, Unit>();
  const prepared = requests.map((request, index) =>
    attempt(() => {
      const source = request.make();
      const existing = units.get(source);
      const unit = existing ?? makeUnit(source, order.length);
      if (existing === undefined) {
        units.set(source, unit);
        order.push(unit);
      }
      owners.set(index, unit);
      return request.shape(unit);
    }),
  );

  const selected = new Map<number, Case>();
  prepared.forEach((outcome, index) => {
    if (outcome.ok) selected.set(index, outcome.value);
  });
  if (selected.size === 0) return prepared;

  const batch = attempt(() => link(directory, order, selected, label));
  return prepared.map((outcome, index) => {
    if (!outcome.ok) return outcome;
    if (batch.ok) return attempt(() => runCase(batch.value, index));
    const single = new Map([[index, outcome.value]]);
    const alone = `${label}-${index}`;
    return attempt(() => runCase(link(directory, [owners.get(index)!], single, alone), index));
  });
}

function only(request: Request): CaseResult {
  const directory = mkdtempSync(join(tmpdir(), "tera-c-"));
  try {
    return unwrap(resolve([request], directory, "single")[0]!);
  } finally {
    removeDirectory(directory);
  }
}

function asProgramRun(result: CaseResult): CProgramRun {
  return { status: result.status, stdout: result.stdout.replace(NEWLINE, "\n") };
}

function textOf(symbol: string, result: CaseResult): string {
  if (result.status !== 0) {
    throw new Error(`execution failed for ${symbol}: ${result.stderr || result.status}`);
  }
  return result.stdout;
}

function numberOf(symbol: string, result: CaseResult): number {
  const stdout = textOf(symbol, result);
  const value = Number(stdout.trim());
  if (Number.isNaN(value) && stdout.trim() !== "nan") {
    throw new Error(`unexpected output for ${symbol}: ${stdout}`);
  }
  return value;
}

export interface CBatch {
  program(make: () => string): () => CProgramRun;
  callText(make: () => string, symbol: string, args: readonly CArgument[]): () => string;
  callNumber(make: () => string, symbol: string, args: readonly CArgument[]): () => number;
}

export function cBatch(): CBatch {
  const requests: Request[] = [];
  const chunks = new Map<number, Array<Outcome<CaseResult>>>();
  let directory: string | null = null;

  afterAll(() => {
    if (directory !== null) removeDirectory(directory);
  });

  const workspace = (): string => (directory ??= mkdtempSync(join(tmpdir(), "tera-c-")));

  const resultAt = (index: number): Outcome<CaseResult> => {
    const chunk = Math.floor(index / BATCH_SIZE);
    const start = chunk * BATCH_SIZE;
    let resolved = chunks.get(chunk);
    if (resolved === undefined) {
      resolved = resolve(requests.slice(start, start + BATCH_SIZE), workspace(), `batch${chunk}`);
      chunks.set(chunk, resolved);
    }
    return resolved[index - start] ?? resolve([requests[index]!], workspace(), `late${index}`)[0]!;
  };

  const add = <T>(request: Request, read: (result: CaseResult) => T): (() => T) => {
    const index = requests.length;
    requests.push(request);
    return () => read(unwrap(resultAt(index)));
  };

  return {
    program: (make) => add({ make, shape: programCase }, asProgramRun),
    callText: (make, symbol, args) =>
      add({ make, shape: (unit) => callCase(unit, symbol, args) }, (result) => textOf(symbol, result)),
    callNumber: (make, symbol, args) =>
      add({ make, shape: (unit) => callCase(unit, symbol, args) }, (result) => numberOf(symbol, result)),
  };
}

export function runCProgram(source: string): CProgramRun {
  return asProgramRun(only({ make: () => source, shape: programCase }));
}

export function runCStringFunction(
  source: string,
  symbol: string,
  args: readonly CArgument[],
): string {
  return textOf(symbol, only({ make: () => source, shape: (unit) => callCase(unit, symbol, args) }));
}

export function runCFunction(
  source: string,
  symbol: string,
  args: readonly CArgument[],
): number {
  return numberOf(symbol, only({ make: () => source, shape: (unit) => callCase(unit, symbol, args) }));
}
