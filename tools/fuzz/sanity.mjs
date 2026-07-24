import { generate } from "./generator.mjs";
import { ORACLE, describe, isHostFailure, runConfig } from "./engines.mjs";

const from = Number(process.argv[2] ?? 0);
const to = Number(process.argv[3] ?? 40);

const errors = new Map();
let thrown = 0;
let slowest = 0;
let slowestSeed = -1;

for (let seed = from; seed < to; seed++) {
  const { source } = generate(seed);
  const started = Date.now();
  const outcome = runConfig(ORACLE, source);
  const elapsed = Date.now() - started;
  if (elapsed > slowest) {
    slowest = elapsed;
    slowestSeed = seed;
  }
  if (!outcome.ok) {
    thrown += 1;
    const key = isHostFailure(outcome.error) ? `HOST: ${outcome.error}` : outcome.error;
    errors.set(key, (errors.get(key) ?? 0) + 1);
    if (outcome.error.includes("Parser")) {
      const line = Number(outcome.error.match(/at (\d+):/)?.[1] ?? 0);
      process.stdout.write(`PARSE seed=${seed} ${outcome.error}\n  ${source.split("\n")[line - 1]}\n`);
    }
  }
  if (seed - from < 3) process.stdout.write(`seed ${seed}: ${describe(outcome).slice(0, 120)}\n`);
}

process.stdout.write(`\nprograms=${to - from} thrown=${thrown} slowest=${slowest}ms (seed ${slowestSeed})\n`);
for (const [message, count] of [...errors].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${count}x ${message.slice(0, 100)}\n`);
}
