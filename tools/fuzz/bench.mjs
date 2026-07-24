import { Engine } from "../../dist/index.node.js";

const src = (...lines) => lines.join("\n");

const CASES = {
  arithmetic: src(
    "fn step(a, i):",
    "  return ((a * 3) + i) % 1000003",
    "fn run(n):",
    "  acc = 1",
    "  i = 0",
    "  while i < n:",
    "    acc = step(acc, i)",
    "    i = i + 1",
    "  return acc",
    "run(400000)",
  ),
  callChain: src(
    "fn f0(a, i):",
    "  return (a + i) | 0",
    "fn f1(a, i):",
    "  return f0(a, i) + 1",
    "fn f2(a, i):",
    "  return f1(a, i) - 1",
    "fn run(n):",
    "  acc = 0",
    "  i = 0",
    "  while i < n:",
    "    acc = f2(acc, i) % 999983",
    "    i = i + 1",
    "  return acc",
    "run(300000)",
  ),
  objectFields: src(
    "fn run(n):",
    "  s = 0",
    "  i = 0",
    "  while i < n:",
    "    p = {x: i, y: i + 1}",
    "    s = (s + p.x + p.y) % 1000003",
    "    i = i + 1",
    "  return s",
    "run(300000)",
  ),
  arrayElements: src(
    "fn run(n):",
    "  a = [0, 0, 0, 0]",
    "  i = 0",
    "  while i < n:",
    "    a[i % 4] = a[i % 4] + i",
    "    i = i + 1",
    "  return a[0] + a[1] + a[2] + a[3]",
    "run(400000)",
  ),
  arrayReads: src(
    "fn run(n):",
    "  a = [10, 20, 30, 40]",
    "  i = 0",
    "  s = 0",
    "  while i < n:",
    "    s = s + a[i % 4]",
    "    i = i + 1",
    "  return s",
    "run(400000)",
  ),
  booleanLogic: src(
    "fn pick(a, i):",
    "  return (i % 3 == 0) and (a % 2 == 0)",
    "fn run(n):",
    "  c = 0",
    "  i = 0",
    "  while i < n:",
    "    if pick(c, i):",
    "      c = c + 1",
    "    else:",
    "      c = c + 2",
    "    i = i + 1",
    "  return c",
    "run(300000)",
  ),
  branchyLoop: src(
    "fn run(n):",
    "  s = 0",
    "  i = 0",
    "  while i < n:",
    "    i = i + 1",
    "    if i % 7 == 0:",
    "      continue",
    "    if i % 11 == 0:",
    "      s = s - 1",
    "    else:",
    "      s = s + 2",
    "  return s",
    "run(400000)",
  ),
  recursion: src(
    "fn fib(k):",
    "  if k < 2:",
    "    return k",
    "  return fib(k - 1) + fib(k - 2)",
    "fn run(n):",
    "  s = 0",
    "  i = 0",
    "  while i < n:",
    "    s = s + fib(15)",
    "    i = i + 1",
    "  return s",
    "run(120)",
  ),
};

const repeats = Number(process.argv[2] ?? 3);
const results = {};

for (const [name, source] of Object.entries(CASES)) {
  const timings = [];
  for (let attempt = 0; attempt < repeats; attempt++) {
    const engine = new Engine({ typecheck: "off" });
    const started = performance.now();
    engine.runNative(source);
    timings.push(performance.now() - started);
  }
  results[name] = Math.min(...timings);
}

process.stdout.write(`${JSON.stringify(results)}\n`);
for (const [name, ms] of Object.entries(results)) {
  process.stdout.write(`${name.padEnd(16)} ${ms.toFixed(1)}ms\n`);
}
