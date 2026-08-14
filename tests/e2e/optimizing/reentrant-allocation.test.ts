import { describe, it } from "vitest";
import { differential, src } from "../../helpers/tiers.js";

const driver = (call: string, iterations = 300) => src(
  "fn driver(m):",
  "  k = 0",
  "  t = 0",
  "  while k < m:",
  `    t = ${call}`,
  "    k = k + 1",
  "  return t",
  `driver(${iterations})`,
);

const relay = src(
  "fn relay(d):",
  "  t = d * 20",
  "  if d > 0:",
  "    t = t + host(d - 1)",
  "  return t",
);

describe("a re-entered optimized frame keeps its own allocations", () => {
  it("preserves an object mutated after a nested call re-enters the same function", () => {
    differential(src(
      "fn host(d):",
      "  p = {a: d, b: d * 10}",
      "  if d > 0:",
      "    n = relay(d - 1)",
      "    p.b = p.b + n",
      "  return p.a + p.b",
      relay,
      driver("host(2)"),
    ));
  });

  it("preserves every live object when a re-entered frame holds more than one", () => {
    differential(src(
      "fn host(d):",
      "  p = {a: d, b: d * 10}",
      "  s = {a: d * 100, b: d * 1000}",
      "  if d > 0:",
      "    n = relay(d - 1)",
      "    p.b = p.b + n",
      "  return p.a + p.b + s.a + s.b",
      relay,
      driver("host(2)"),
    ));
  });

  it("keeps mutually recursive frames from aliasing each other's objects", () => {
    differential(src(
      "fn even(d):",
      "  p = {a: d, b: d * 10}",
      "  if d > 0:",
      "    q = odd(d - 1)",
      "    p.b = p.b + q.a",
      "  return p",
      "fn odd(d):",
      "  p = {a: d, b: d * 20}",
      "  if d > 0:",
      "    q = even(d - 1)",
      "    p.b = p.b + q.b",
      "  return p",
      "fn top(d):",
      "  r = even(d)",
      "  return r.a + r.b",
      driver("top(2)"),
    ));
  });

  it("keeps mutually recursive frames apart when both sides allocate the same shape", () => {
    differential(src(
      "fn even(d):",
      "  p = {a: d, b: d * 10}",
      "  if d > 0:",
      "    q = odd(d - 1)",
      "    p.b = p.b + q.a",
      "  return p",
      "fn odd(d):",
      "  p = {a: d, b: d * 20}",
      "  if d > 0:",
      "    q = even(d - 1)",
      "    p.b = p.b + q.b",
      "  return p",
      "fn top(d):",
      "  r = even(d)",
      "  return r.a + r.b",
      driver("top(2)"),
    ));
  });

  it("preserves a reallocated object across a nested call that re-enters the same function", () => {
    differential(src(
      "fn host(d):",
      "  p = {a: d, b: d * 10}",
      "  if d > 0:",
      "    n = relay(d - 1)",
      "    p = {a: p.a, b: p.b + n}",
      "  return p.a + p.b",
      relay,
      driver("host(2)"),
    ));
  });

  it("stays correct when the re-entered frame allocates nothing", () => {
    differential(src(
      "fn host(d):",
      "  acc = d * 10",
      "  if d > 0:",
      "    n = relay(d - 1)",
      "    acc = acc + n",
      "  return d + acc",
      relay,
      driver("host(2)"),
    ));
  });

  it("stays correct when mutual recursion returns only numbers", () => {
    differential(src(
      "fn even(d):",
      "  t = d * 10",
      "  if d > 0:",
      "    t = t + odd(d - 1)",
      "  return t",
      "fn odd(d):",
      "  t = d * 20",
      "  if d > 0:",
      "    t = t + even(d - 1)",
      "  return t",
      driver("even(6)"),
    ));
  });

  it("stays correct when distinct optimized frames return objects up a chain", () => {
    differential(src(
      "fn leaf(d):",
      "  p = {a: d, b: d * 10}",
      "  return p",
      "fn mid(d):",
      "  q = leaf(d)",
      "  p = {a: q.a, b: q.b + 1}",
      "  return p",
      "fn outer(d):",
      "  q = mid(d)",
      "  p = {a: q.a, b: q.b + 100}",
      "  return p",
      "fn top(d):",
      "  r = outer(d)",
      "  return r.a + r.b",
      driver("top(3)"),
    ));
  });
});
