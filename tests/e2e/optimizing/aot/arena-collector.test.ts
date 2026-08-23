import { describe, expect, it } from "vitest";
import { nodeEngine } from "../../../helpers/engine.js";
import { cSource, itNative, runCFunction } from "../../../helpers/c-executor.js";
import { itRunsPe, runPe } from "../../../helpers/pe-runner.js";
import {
  TERA_BARRIER_SYMBOL,
  TERA_CONTEXT,
  TERA_HEAP_COMMIT_BYTES,
  TERA_STATICS,
  TERA_YOUNG_CAPACITY,
} from "../../../../src/optimizing/target/runtime-layout.js";
import { aotBackends } from "../../../../src/cli/targets.js";
import { scalarWidth, SCALAR_POINTER } from "../../../../src/optimizing/types/scalar.js";

const src = (...lines: string[]) => lines.join("\n");

function compile(source: string) {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "c",
  });
  expect(program.skipped).toEqual([]);
  return cSource(program);
}

const CELL = [
  "class Cell:",
  "  public constructor(v: int):",
  "    this.v = v",
  "  public get value() -> int:",
  "    return this.v",
];

const HOLDER = [
  ...CELL,
  "class Holder:",
  "  public constructor(inner: Cell):",
  "    this.inner = inner",
  "  public get reading() -> int:",
  "    return this.inner.value",
];

const CELL_BYTES = 16;
const ROUNDS_PAST_THE_ARENA = Math.ceil((TERA_HEAP_COMMIT_BYTES / CELL_BYTES) * 4);
const KEPT_CELLS = Math.floor(
  TERA_HEAP_COMMIT_BYTES / (CELL_BYTES + scalarWidth(SCALAR_POINTER)) / 8,
);
const KEPT_SUM = (KEPT_CELLS * (KEPT_CELLS - 1)) / 2;
const SURVIVES_A_NURSERY = TERA_YOUNG_CAPACITY * 2;

function image(source: string): Uint8Array {
  const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, {
    backend: "x64-windows",
    format: "executable",
  });
  expect(program.skipped).toEqual([]);
  return program.files[0]!.contents as Uint8Array;
}

const CHURN = [
  ...CELL,
  "fn churn(rounds: int) -> int:",
  "  seen = 0",
  "  i = 0",
  "  while i < rounds:",
  "    seen = (seen + Cell(i & 7).value) & 65535",
  "    i = i + 1",
  "  return seen",
];

const RETAIN = [
  ...HOLDER,
  "fn churn(rounds: int) -> int:",
  "  keeper = Holder(Cell(1234))",
  "  i = 0",
  "  seen = 0",
  "  while i < rounds:",
  "    seen = (seen + Holder(Cell(i & 3)).reading) & 65535",
  "    i = i + 1",
  "  return keeper.reading",
];

const GROWN = [
  ...CELL,
  "fn churn(rounds: int) -> int:",
  "  xs = [Cell(0)]",
  "  i = 1",
  `  while i < ${KEPT_CELLS}:`,
  "    xs.push(Cell(i))",
  "    i = i + 1",
  "  j = 0",
  "  while j < rounds:",
  "    dropped = Cell(j)",
  "    j = j + 1",
  "  seen = 0",
  "  for c of xs:",
  "    seen = seen + c.value",
  "  return seen",
];

function churned(rounds: number): number {
  let seen = 0;
  for (let index = 0; index < rounds; index++) seen = (seen + (index & 7)) & 65535;
  return seen;
}

describe("AOT arena collector", () => {
  it("describes every class the collector has to sweep", () => {
    const source = compile(src(...HOLDER, "fn go() -> int:", "  return Holder(Cell(1)).reading"));

    expect(source).toContain("tera_classes[] = {");
    expect(source).toMatch(/tera_fields_\d+\[\] = \{ 8 \}/);
  });

  it("gives every function that holds a reference a root frame", () => {
    const source = compile(src(...HOLDER, "fn go() -> int:", "  return Holder(Cell(1)).reading"));

    expect(source).toContain("tera_context.root_count");
    expect(source).toContain("tera_context.roots_base[roots + 0]");
  });

  itNative("keeps allocating past the size of the arena", () => {
    const source = compile(
      src(
        ...CELL,
        "fn churn(rounds: int) -> int:",
        "  seen = 0",
        "  i = 0",
        "  while i < rounds:",
        "    seen = (seen + Cell(i & 7).value) & 65535",
        "    i = i + 1",
        "  return seen",
      ),
    );

    expect(runCFunction(source, "churn", [ROUNDS_PAST_THE_ARENA])).toBe(
      runCFunction(source, "churn", [ROUNDS_PAST_THE_ARENA]),
    );
  });

  itNative("keeps a graph reachable only through a field alive across collections", () => {
    const source = compile(
      src(
        ...HOLDER,
        "fn churn(rounds: int) -> int:",
        "  keeper = Holder(Cell(1234))",
        "  i = 0",
        "  seen = 0",
        "  while i < rounds:",
        "    seen = (seen + Holder(Cell(i & 3)).reading) & 65535",
        "    i = i + 1",
        "  return keeper.reading",
      ),
    );

    expect(runCFunction(source, "churn", [ROUNDS_PAST_THE_ARENA])).toBe(1234);
  });

  itNative("agrees with the interpreter on a run the arena could hold outright", () => {
    const body = src(
      ...HOLDER,
      "fn churn(rounds: int) -> int:",
      "  keeper = Holder(Cell(7))",
      "  i = 0",
      "  seen = 0",
      "  while i < rounds:",
      "    seen = (seen + Holder(Cell(i & 3)).reading + keeper.reading) & 65535",
      "    i = i + 1",
      "  return seen",
    );

    expect(runCFunction(compile(body), "churn", [1000])).toBe(
      nodeEngine({ typecheck: "off" }).runNative(`${body}\nchurn(1000)\n`),
    );
  });

  itNative("keeps the elements of a grown array alive across collections", () => {
    expect(runCFunction(compile(src(...GROWN)), "churn", [ROUNDS_PAST_THE_ARENA])).toBe(
      KEPT_SUM,
    );
  });
});

describe("native arena collector", () => {
  itRunsPe("keeps allocating past the size of the arena", () => {
    const run = runPe(image(src(...CHURN, `print(churn(${ROUNDS_PAST_THE_ARENA}))`)));

    expect([run.status, run.stdout.trim()]).toEqual([
      0,
      String(churned(ROUNDS_PAST_THE_ARENA)),
    ]);
  });

  itRunsPe("keeps a graph reachable only through a field alive across collections", () => {
    const run = runPe(image(src(...RETAIN, `print(churn(${ROUNDS_PAST_THE_ARENA}))`)));

    expect([run.status, run.stdout.trim()]).toEqual([0, "1234"]);
  });

  itRunsPe("keeps the elements of a grown array alive across collections", () => {
    const run = runPe(image(src(...GROWN, `print(churn(${ROUNDS_PAST_THE_ARENA}))`)));

    expect([run.status, run.stdout.trim()]).toEqual([0, String(KEPT_SUM)]);
  });

  itRunsPe("still reclaims when the roots live in a class the program keeps", () => {
    const run = runPe(
      image(
        src(
          ...HOLDER,
          "keeper = Holder(Cell(99))",
          "i = 0",
          "while i < 200000:",
          "  junk = Holder(Cell(i & 1))",
          "  i = i + 1",
          "print(keeper.reading)",
        ),
      ),
    );

    expect([run.status, run.stdout.trim()]).toEqual([0, "99"]);
  });
});

const REPLACES = [
  ...CELL,
  "class Holder:",
  "  public constructor(inner: Cell):",
  "    this.inner = inner",
  "  public get reading() -> int:",
  "    return this.inner.value",
  "  public take(fresh: Cell) -> int:",
  "    this.inner = fresh",
  "    return 0",
  "fn refresh(target: Holder, v: int) -> int:",
  "  return target.take(Cell(v))",
  "fn churn(rounds: int) -> int:",
  "  keeper: Holder = Holder(Cell(0))",
  "  i = 0",
  "  while i < rounds:",
  "    dropped = Cell(i & 7)",
  "    i = i + 1",
  "  refresh(keeper, 4321)",
  "  j = 0",
  "  while j < rounds:",
  "    litter = Cell(j & 7)",
  "    j = j + 1",
  "  return keeper.reading",
];

describe("generational collector", () => {
  it("takes the write barrier on a reference store and leaves a number store alone", () => {
    const source = compile(
      src(
        ...HOLDER,
        "fn go(h: Holder, c: Cell) -> int:",
        "  h.inner = c",
        "  return h.reading",
      ),
    );

    expect(source).toContain("tera_write_barrier(");
    expect(source.match(/tera_write_barrier\(/g)!.length).toBeGreaterThan(0);
  });

  it("leaves a store into static memory without a barrier", () => {
    const source = compile(
      src(
        ...CELL,
        "keeper: Cell = Cell(1)",
        "fn swap(v: int) -> int:",
        "  keeper = Cell(v)",
        "  return 0",
        "fn read() -> int:",
        "  return keeper.value",
        "swap(7)",
        "print(read())",
      ),
    );
    const swapping = source.slice(source.indexOf("int32_t swap("));
    const body = swapping.slice(0, swapping.indexOf("\n}"));

    expect(body).toContain(`&${TERA_STATICS.symbol}`);
    expect(body).not.toContain(`${TERA_BARRIER_SYMBOL}(`);
  });

  it("leaves a store into the runtime context without a barrier", () => {
    const source = compile(
      src("async fn g() -> int:", "  return 1", "async fn f() -> int:", "  return await g()", "print(await f())"),
    );
    const queued = source.slice(source.indexOf(`${TERA_CONTEXT.symbol}.queue_head =`));

    expect(queued.slice(0, queued.indexOf(";"))).not.toContain(TERA_BARRIER_SYMBOL);
  });

  it("leaves a purely numeric store without a barrier", () => {
    const source = compile(
      src(...CELL, "fn go(c: Cell, v: int) -> int:", "  c.v = v", "  return c.value"),
    );
    const body = source.slice(source.indexOf("int32_t go("));

    expect(body).not.toContain("tera_write_barrier(");
  });

  it("emits the barrier from exactly the backends that declare a generational heap", () => {
    const source = src(
      ...HOLDER,
      "fn go(h: Holder, c: Cell) -> int:",
      "  h.inner = c",
      "  return h.reading",
    );
    for (const backend of ["c", "x64-windows", "riscv64"] as const) {
      const program = nodeEngine({ typecheck: "off" }).compileAot(`${source}\n`, { backend });
      const text = program.files.map((file) => String(file.contents)).join("\n");
      const model = aotBackends().find((candidate) => candidate.id === backend)!.target;
      expect([backend, new RegExp(`\\b${TERA_BARRIER_SYMBOL}\\b`).test(text)]).toEqual([
        backend,
        model.capabilities.has("generational-heap"),
      ]);
    }
  });

  itNative("keeps a young object stored into a promoted one alive", () => {
    expect(runCFunction(compile(src(...REPLACES)), "churn", [SURVIVES_A_NURSERY])).toBe(4321);
  });

  itRunsPe("keeps a young object stored into a promoted one alive", () => {
    const run = runPe(image(src(...REPLACES, `print(churn(${SURVIVES_A_NURSERY}))`)));

    expect([run.status, run.stdout.trim()]).toEqual([0, "4321"]);
  });

  itRunsPe("promotes a survivor instead of sweeping it on the next nursery", () => {
    const run = runPe(
      image(
        src(
          ...RETAIN,
          `print(churn(${SURVIVES_A_NURSERY * 4}))`,
        ),
      ),
    );

    expect([run.status, run.stdout.trim()]).toEqual([0, "1234"]);
  });
});
