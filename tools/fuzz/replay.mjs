import { readFileSync } from "node:fs";
import { renderProgram } from "./ir.mjs";
import { CONFIGS, ORACLE, TARGET_CONFIGS, describe, runConfig, sameOutcome } from "./engines.mjs";

const args = new Map();
for (let i = 3; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const source = process.argv[2].endsWith(".json")
  ? renderProgram(JSON.parse(readFileSync(process.argv[2], "utf8")).program)
  : readFileSync(process.argv[2], "utf8");

if (args.has("--print")) process.stdout.write(`${source}\n\n`);

const names = (args.get("--configs") ?? TARGET_CONFIGS.join(",")).split(",").filter((name) => name in CONFIGS);
const expected = runConfig(ORACLE, source);
process.stdout.write(`${ORACLE.padEnd(9)} ${describe(expected)}\n`);
for (const name of names) {
  const actual = runConfig(name, source);
  process.stdout.write(`${name.padEnd(9)} ${sameOutcome(expected, actual) ? "ok  " : "DIFF"} ${describe(actual)}\n`);
}
