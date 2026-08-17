import { describe, it, expect } from "vitest";
import { heapPayloadLiveBytesEstimate } from "../../../src/core/value/index.js";
import { Engine } from "../../../src/api/engine.js";

describe("heap-payload reachability sweep (boxed-primitive reclamation)", () => {
  it("keeps the boxed-primitive slab bounded under a double-heavy loop", () => {
    const engine = new Engine();
    engine.run(`s = 0.0
i = 0
while i < 1500000:
  s = s + (i * 1.5) - 0.25
  i = i + 1`);

    expect(heapPayloadLiveBytesEstimate()).toBeLessThan(1 << 20);
  }, 120000);

  it("preserves live state (objects, arrays, closures, generators) across sweeps", () => {
    const engine = new Engine();
    engine.run(`keep = []
i = 0
while i < 30:
  keep.push({v: i * 1.5 + 0.5})
  i = i + 1
fn mk(b):
  fn inner():
    return b
  return inner
clo = mk(7.75)
fn* g():
  a = 1.25
  while true:
    yield a
    a = a + 0.5
it = g()
first = it.next().value`);

    engine.run(`t = 0.0
i = 0
while i < 1500000:
  t = t + keep[i%30].v * 1.5
  i = i + 1`);
    expect(engine.runValue("return keep[0].v;").value).toBe(0.5);
    expect(engine.runValue("return keep[20].v;").value).toBe(30.5);
    expect(engine.runValue("return keep.length;").value).toBe(30);
    expect(engine.runValue("return clo();").value).toBe(7.75);
    expect(engine.runValue("return first;").value).toBe(1.25);
    expect(engine.runValue("return it.next().value;").value).toBe(1.75);
    expect(engine.runValue("return it.next().value;").value).toBe(2.25);
  }, 120000);

  it("keeps the slab bounded once the loop runs in baseline-compiled code", () => {
    const engine = new Engine({
      tieringPolicy: { baselineThreshold: 2, jitThreshold: Number.MAX_SAFE_INTEGER },
    });
    const boxedDoubles = 4 * 250000;

    engine.run(`fn spin(n):
  total = 0.5
  i = 0
  while i < n:
    total = total + 0.25
    i = i + 1
  return total
r = 0.0
for k of range(4):
  r = spin(250000)`);

    expect(engine.runValue("return r;").value).toBe(62500.5);
    expect(engine.valueHeap.heapPayloadCount()).toBeLessThan(boxedDoubles / 2);
  }, 60000);

  it("still reaches a safepoint when the back edge is a conditional jump", () => {
    const engine = new Engine({
      tieringPolicy: { baselineThreshold: 2, jitThreshold: Number.MAX_SAFE_INTEGER },
    });
    const boxedDoubles = 4 * 250000;

    engine.run(`fn spin(n):
  total = 0.5
  i = 0
  while true:
    if i >= n:
      return total
    total = total + 0.25
    i = i + 1
  return total
r = 0.0
for k of range(4):
  r = spin(250000)`);

    expect(engine.runValue("return r;").value).toBe(62500.5);
    expect(engine.valueHeap.heapPayloadCount()).toBeLessThan(boxedDoubles / 2);
  }, 60000);
});

describe("suspended coroutine frames are collection roots", () => {
  const gc = { youngGenSize: 1024 };

  it("preserves an async coroutine's heap local across collections", () => {
    const engine = new Engine({ gc });
    engine.run(`class Cell:
  public constructor(v: int):
    this.v = v
async fn tick() -> int:
  return 1
fn churn(n: int) -> int:
  t = 0
  i = 0
  while i < n:
    t = t + Cell(1).v
    i = i + 1
  return t
async fn hold(n: int) -> int:
  held = Cell(n)
  step = await tick()
  return Cell(held.v + step).v
pending = hold(41)
churned = churn(5000)
resumed = await pending`);

    expect(engine.runValue("return churned;").value).toBe(5000);
    expect(engine.runValue("return resumed;").value).toBe(42);
  }, 20000);

  it("preserves a generator's heap argument before it starts and while it is suspended", () => {
    const engine = new Engine({ gc });
    engine.run(`class Cell:
  public constructor(v: int):
    this.v = v
fn* counter(seed):
  yield seed.v
  yield seed.v + 1
fn make():
  return counter(Cell(7))
fn churn(n: int) -> int:
  t = 0
  i = 0
  while i < n:
    t = t + Cell(1).v
    i = i + 1
  return t
steps = make()
beforeStart = churn(5000)
first = steps.next().value
whileSuspended = churn(5000)
second = steps.next().value`);

    expect(engine.runValue("return beforeStart;").value).toBe(5000);
    expect(engine.runValue("return whileSuspended;").value).toBe(5000);
    expect(engine.runValue("return first;").value).toBe(7);
    expect(engine.runValue("return second;").value).toBe(8);
  }, 20000);
});

describe("an iterable reachable only through its iterator is a collection root", () => {
  it("keeps a temporary array alive for the whole for-of loop", () => {
    const engine = new Engine();
    engine.run(`last = 0
for j of range(1000000):
  last = j`);

    expect(engine.runValue("return last;").value).toBe(999999);
  }, 120000);
});
