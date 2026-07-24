import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, "worker.mjs");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const from = Number(args.get("--from") ?? 0);
const count = Number(args.get("--count") ?? 500);
const lanes = Number(args.get("--jobs") ?? 3);
const seedTimeoutMs = Number(args.get("--timeout") ?? 30000);
const memLimitMb = Number(args.get("--mem") ?? 1400);
const configs = args.get("--configs");
const outDir = args.get("--out") ?? join(here, "out");
const label = args.get("--label") ?? "run";

mkdirSync(outDir, { recursive: true });
const failurePath = join(outDir, `${label}.ndjson`);
rmSync(failurePath, { force: true });

const totals = { checked: 0, failed: 0, skipped: 0, timedOut: 0 };
const seen = new Set();

function record(event) {
  if (event.type === "fail") {
    const key = `${event.seed}:${event.config}`;
    if (seen.has(key)) return;
    seen.add(key);
    totals.failed += 1;
    appendFileSync(failurePath, `${JSON.stringify(event)}\n`);
    process.stdout.write(`FAIL seed=${event.seed} config=${event.config}\n  expected ${event.expected}\n  actual   ${event.actual}\n`);
    return;
  }
  if (event.type === "skip") totals.skipped += 1;
  if (event.type === "timeout") {
    totals.timedOut += 1;
    appendFileSync(failurePath, `${JSON.stringify(event)}\n`);
    process.stdout.write(`TIMEOUT seed=${event.seed}\n`);
  }
}

function spawnWorker(rangeFrom, rangeTo) {
  return new Promise((resolve) => {
    const workerArgs = [
      "--max-old-space-size=4096",
      workerPath,
      "--from", String(rangeFrom),
      "--to", String(rangeTo),
      "--mem", String(memLimitMb),
    ];
    if (configs) workerArgs.push("--configs", configs);
    const child = spawn(process.execPath, workerArgs, { stdio: ["ignore", "pipe", "pipe"] });

    let buffer = "";
    let lastSeed = rangeFrom;
    let settled = false;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ kind: "timeout", seed: lastSeed });
      }, seedTimeoutMs);
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.length === 0) continue;
        const event = JSON.parse(line);
        if (event.type === "progress") {
          lastSeed = event.seed;
          totals.checked += 1;
          arm();
          continue;
        }
        if (event.type === "stop" || event.type === "done") {
          finish({ kind: "resume", next: event.next });
          continue;
        }
        record(event);
      }
    });

    child.stderr.on("data", () => {});
    child.on("exit", () => finish({ kind: "resume", next: lastSeed + 1 }));
    arm();
  });
}

async function runLane(laneFrom, laneTo) {
  let cursor = laneFrom;
  while (cursor < laneTo) {
    const result = await spawnWorker(cursor, laneTo);
    if (result.kind === "timeout") {
      record({ type: "timeout", seed: result.seed });
      cursor = result.seed + 1;
    } else {
      cursor = Math.max(result.next, cursor + 1);
    }
  }
}

const laneSize = Math.ceil(count / lanes);
const jobs = [];
for (let lane = 0; lane < lanes; lane++) {
  const laneFrom = from + lane * laneSize;
  const laneTo = Math.min(from + count, laneFrom + laneSize);
  if (laneFrom < laneTo) jobs.push(runLane(laneFrom, laneTo));
}

const started = Date.now();
await Promise.all(jobs);
process.stdout.write(
  `\nseeds=${totals.checked} failures=${totals.failed} skipped=${totals.skipped} timeouts=${totals.timedOut} elapsed=${Math.round((Date.now() - started) / 1000)}s\n`,
);
if (totals.failed > 0) process.stdout.write(`failures written to ${failurePath}\n`);
