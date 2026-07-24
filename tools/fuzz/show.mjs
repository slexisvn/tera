import { generate } from "./generator.mjs";
import { CONFIGS, ORACLE, TARGET_CONFIGS, describe, runConfig } from "./engines.mjs";

const args = new Map();
for (let i = 3; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const seed = Number(process.argv[2]);
const { source } = generate(seed);
process.stdout.write(`${source}\n`);

if (args.has("--run")) {
  const names = [ORACLE, ...(args.get("--configs") ?? TARGET_CONFIGS.join(",")).split(",").filter((n) => n in CONFIGS)];
  for (const name of names) {
    const started = Date.now();
    const outcome = runConfig(name, source);
    process.stdout.write(`${name.padEnd(9)} ${Date.now() - started}ms  ${describe(outcome)}\n`);
  }
}
