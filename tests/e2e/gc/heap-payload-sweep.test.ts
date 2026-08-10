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
  }, 20000);
});
