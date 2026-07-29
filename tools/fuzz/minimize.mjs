import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generator.mjs";
import { renderProgram } from "./ir.mjs";
import { reduce, size } from "./reductions.mjs";
import { ORACLE, describe, isHostFailure, runConfig, sameOutcome } from "./engines.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const seed = Number(args.get("--seed"));
const config = args.get("--config");
const memLimitMb = Number(args.get("--mem") ?? 1200);
const statePath = args.get("--state") ?? join(here, "out", `min-${seed}-${config}.json`);
const isChild = args.has("--child");

const RESTART_CODE = 7;

const loadProgram = () => {
  if (existsSync(statePath)) return JSON.parse(readFileSync(statePath, "utf8")).program;
  return generate(seed).program;
};

const save = (program) => {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ seed, config, program }, null, 1));
};

const outcomeFor = (source) => {
  const expected = runConfig(ORACLE, source);
  if (!expected.ok && isHostFailure(expected.error)) return null;
  const actual = runConfig(config, source);
  if (!actual.ok && isHostFailure(actual.error)) return null;
  return { expected, actual };
};

const reproduces = (program) => {
  const outcome = outcomeFor(renderProgram(program));
  return outcome !== null && !sameOutcome(outcome.expected, outcome.actual);
};

const rssMb = () => process.memoryUsage().rss / 1048576;

if (isChild) {
  const start = loadProgram();
  if (!reproduces(start)) {
    process.stdout.write("  candidate no longer reproduces\n");
    process.exit(0);
  }
  const best = reduce(start, {
    test: reproduces,
    accept: save,
    shouldStop: () => rssMb() > memLimitMb,
  });
  save(best);
  process.exit(rssMb() > memLimitMb ? RESTART_CODE : 0);
}

mkdirSync(dirname(statePath), { recursive: true });
let rounds = 0;
for (;;) {
  const child = spawnSync(
    process.execPath,
    ["--max-old-space-size=4096", fileURLToPath(import.meta.url),
      "--seed", String(seed), "--config", config, "--state", statePath, "--mem", String(memLimitMb), "--child", "1"],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  rounds += 1;
  if (child.status !== RESTART_CODE) break;
  process.stdout.write(`  restart ${rounds}: ${size(loadProgram())} chars\n`);
}

const program = loadProgram();
const source = renderProgram(program);
const outcome = outcomeFor(source);
process.stdout.write(`\n${source}\n\n`);
if (outcome === null) {
  process.stdout.write("minimized program no longer runs cleanly\n");
} else {
  process.stdout.write(`oracle   ${describe(outcome.expected)}\n${config.padEnd(8)} ${describe(outcome.actual)}\n`);
}
