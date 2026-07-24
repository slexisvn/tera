# Differential fuzzer for the optimizing JIT

Seeded generative fuzzer. A seed deterministically produces one program; the
interpreter is the oracle and every other tier must agree with it.

Run `npm run build` first — everything here loads `dist/index.node.js`.

## Running

```bash
node tools/fuzz/fuzz.mjs --from 0 --count 600 --jobs 3 --mem 1100 --timeout 90000 --label run1
```

Failures are appended to `tools/fuzz/out/<label>.ndjson`. Each engine retains
memory that is never released, so workers are chunked across subprocesses and
exit once their RSS crosses `--mem`; the orchestrator respawns them from where
they stopped. A per-seed watchdog (`--timeout`) kills and skips programs that
hang.

## Configurations

`engines.mjs` defines the oracle plus five targets: `baseline`, `jit`,
`jitosr`, `fast`, `fastosr`. The `fast` pair uses `jitThreshold: 30` /
`baselineThreshold: 3` — compilation happens while feedback is still narrow,
which is where several bugs only reproduce.

## Minimizing

```bash
node tools/fuzz/minimize.mjs --seed 204 --config jit
```

Delta-debugging over the generated program's structure, not its text: drop
functions, drop statements, promote block bodies, drop object fields and array
elements, hoist subexpressions, replace expressions with literals, shrink
numbers. Passes sweep sites in reverse document order so one pass applies many
reductions without re-enumerating. Progress is checkpointed to
`out/min-<seed>-<config>.json`; the process restarts itself when it hits its
memory ceiling.

## Other entry points

- `show.mjs <seed> [--run]` — print a generated program, optionally run every config.
- `replay.mjs <file.json|file.tera> [--print]` — run a saved minimization or a source file.
- `sanity.mjs <from> <to>` — oracle-only sweep; reports parse errors and slow seeds.
- `bench.mjs [repeats]` — hot-loop timings, for checking that a fix costs nothing.

## Coverage

Objects and shape transitions, arrays and in/out-of-bounds indexing, strings,
booleans, null/undefined, closures, recursion, method calls, `typeof`, bitwise
and comparison operators, nested loops, break/continue, early returns, globals,
and mixed-type values through one variable. Call chains are one to five deep and
acyclic by construction. Loop bodies switch the observed types partway through a
run to drive deopt/reopt. Literals are drawn from a boundary set that includes
the object-pointer base (1024), the constant-pool base (49152), the int32 and
2^53 limits, ±0, NaN and the infinities; accumulators also reach those values by
arithmetic rather than only as literals.

## Determinism

Generated programs avoid unbounded growth (arrays are capped, string
accumulators are truncated) so the oracle stays computable. On a mismatch the
worker re-runs the oracle and skips the seed if the two runs disagree, which
keeps nondeterministic programs — for example ones that observe a function
value's identity — out of the failure list.
