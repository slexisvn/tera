import { writeSync } from "node:fs";
import { generate } from "./generator.mjs";
import { CONFIGS, ORACLE, TARGET_CONFIGS, describe, isHostFailure, runConfig, sameOutcome } from "./engines.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const from = Number(args.get("--from"));
const to = Number(args.get("--to"));
const memLimitMb = Number(args.get("--mem") ?? 1400);
const configs = (args.get("--configs") ?? TARGET_CONFIGS.join(",")).split(",").filter((n) => n in CONFIGS);

const emit = (event) => writeSync(1, `${JSON.stringify(event)}\n`);
const rssMb = () => process.memoryUsage().rss / 1048576;

for (let seed = from; seed < to; seed++) {
  emit({ type: "progress", seed });
  const { source } = generate(seed);
  const expected = runConfig(ORACLE, source);
  if (!expected.ok && isHostFailure(expected.error)) {
    emit({ type: "skip", seed, reason: expected.error });
  } else {
    for (const name of configs) {
      const actual = runConfig(name, source);
      if (sameOutcome(expected, actual)) continue;
      if (!actual.ok && isHostFailure(actual.error)) {
        emit({ type: "skip", seed, reason: actual.error });
        break;
      }
      if (!sameOutcome(expected, runConfig(ORACLE, source))) {
        emit({ type: "skip", seed, reason: "oracle is not deterministic" });
        break;
      }
      emit({ type: "fail", seed, config: name, expected: describe(expected), actual: describe(actual) });
      break;
    }
  }
  if (rssMb() > memLimitMb) {
    emit({ type: "stop", next: seed + 1 });
    process.exit(0);
  }
}
emit({ type: "done", next: to });
