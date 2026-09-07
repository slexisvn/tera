# 76. The visualizer: replaying every pass   ⟨**I** · B · **J** · **N**⟩

> **Status:** outline

**Thesis.** Six hooks made the optimizer observable, and the hardest part is recording a
compiler without perturbing it.

**What arrived.** The shape chapter 75 ended on: a synchronous hook that produces one
serializable record which a different thread reads, and the honest admission that the
debugger's hook *does* perturb — `forceInterpreter` pins the program to tier zero, so the
JIT can be driven but never watched ([Ch 75 § pinning-the-tier]).

**What leaves.** `tools/visualizer/src/workers/observe.ts`: four oracle functions —
`observeInterpreter`, `observeBaseline`, `observeJit`, `observeAot` — each reducing a whole
compile-and-run to one `Observation` with a `signature`, and each already threading an
`OptBisect` counter through `compilerOptions`. Chapter 77 turns that pair (an oracle and a
counter with a limit) into a binary search.

**New ideas.** An *observer effect* in a compiler harness — a host that watches the engine
can change what the engine does; a *recording gate*; the difference between a *pass trace*
and a *log*; an identity-keyed diff versus a line diff; BFS layering and why longest-path
layering does not terminate on a cyclic graph; orthogonal edge routing; *dominance* and the
*loop forest* recomputed from printed text; an *optimization remark*.

**Length.** 14 pages

## Anchors

- `tools/visualizer/src/workers/compiler-worker.ts` — the whole recording layer. `run`
  (565-626), `report` (628-648), `runJit` (650-699), `runAot` (725-768), `execute` (770-782),
  `StageCollector` (257-463), `frontendStages` (465-490), `stageOrExplain` (500-531),
  `bytecodeStages` (538-554), `uniqueByName` (556-563), `nestedFunctions` (717-723),
  `declineText` (701-707), `hexDump` (784-793), `targets` (235-243), `sourceLinesOf`
  (245-255), `shapeEdgeOf` (189-201), `deoptOriginOf` (220-233), `stageRemark` (169-175),
  `OutputSink` (90-98), `runPass`/`runPasses` (118-167), and the budgets `EVENT_BUDGET`
  (63-70), `DEFAULT_EVENT_BUDGET = 80`, `OUTPUT_BUDGET = 400`, `SHAPE_BUDGET = 300`.
- `tools/visualizer/src/workers/compiler-worker.ts:582-614` — the six hooks in one place:
  `compilerOptions(request.optLevel)` as the base, then `verifyEachPass`, `passTracer`,
  and (on the AOT path, 736-742) `machineTracer`, `allocationTracer`, `moduleTracer`, plus
  the engine's own `onTrace` sink.
- `tools/visualizer/src/workers/compiler-worker.ts:301-331, 360-390, 654-662` — the
  recording gate: `StageCollector.recording`, the `capture` / `ExecutedGraph` path taken
  while it is `false`, `executedStages()`, and `runJit` flipping it around `engine.run`.
- `tools/visualizer/src/types/stage.ts` — `Stage` (34-56, sixteen fields), `StageGroup`
  (3-12), `StageKind` (13), `StageMetrics`, `StageRemark` and `RemarkKind` (20-27),
  `REMARK_TITLES`, `DeoptOrigin` (71-79), `RuntimeEvent` (80-86), `RunRequest` /
  `RunResult`, `OptLevelId` (89), `VISUALIZER_PASS_NAMES` (187-197), `GROUP_ORDER`,
  `GROUP_TITLES`, and the shared empty constants `NO_REMARKS` / `NOTHING_BROKEN` /
  `NO_ANALYSES` / `NO_POSITIONS`.
- `tools/visualizer/src/services/ir-diff.ts` — `diffIR` (75-116), `index` (38-63),
  `blockOpenedBy` (30-36), `rowFor` (65-73), `summarize`, `DiffKind`
  (`same`/`added`/`removed`/`changed`/`moved`), and the five patterns `VALUE`, `BLOCK`,
  `MACHINE_BLOCK`, `MACHINE_HEADER`, `GRAPH`, `HEADER`.
- `tools/visualizer/src/services/ir-graph.ts` — `parseGraphText` (56), `layerBlocks`
  (102-129, the BFS), `locateNode` (136), `nodeByKey`, `isBackEdge` (150),
  `IrGraphModel`/`IrBlock`/`IrNode`.
- `tools/visualizer/src/services/cfg-analysis.ts` — `dominanceOf` (38-103) with
  `reachableOrder` (18-36) and the `meet` function (56-64), `loopForestOf` (122-160),
  `bodyOf` (105-120), and the types `Dominance` and `Loop`.
- `tools/visualizer/src/services/graph-layout.ts` — `ARROW_KINDS`
  (`forward`/`back`/`data`), `arrowMarkerId`, `RoutedEdge`, `GraphLayout`, `PlacedBlock`,
  `PlacedNode`, `orthogonal` (100), `neckOf` (114), `trim` (87), `distinct` (96),
  `routedEdge` (126), and the geometry constants `ARROW_LENGTH = 9`, `CORNER = 10`,
  `DATA_LANE_NEAR`, `DATA_LANE_FAR`, `DATA_GUTTER`, `BLOCK_WIDTH = 260`, `ROW_GAP = 46`,
  `LANE_SHARE` (`forward: 0.3`, `back: 0.72`).
- `tools/visualizer/src/services/pass-cost.ts` — `costOf` (21-44), `CostReport`
  (`measured`, `total`, `wasted`, `idle`, `slowest`), `PassCost`.
- `tools/visualizer/src/services/node-history.ts` — `historyOf` (38-67), `siteIn`,
  `kindOf`, `MomentKind` (`born`/`rewritten`/`moved`/`held`/`gone`), and the line that
  excludes the executed graph: `stage.group === "executed"` (line 47).
- `tools/visualizer/src/services/deopt-link.ts` — `targetForDeopt` (44-80), `guardOf`
  (24-27), `opcodesOf` (14-21), `ownedGraphs` (29-35), `atLine` (37-42), and the four
  verdicts `DeoptMatch = "node" | "line" | "retired" | "graph"`.
- `tools/visualizer/src/services/fixture.ts` — `fixtureFor` (60-83), `goneLines` (23-28),
  `freshOpcodes` (30-37), `exactly` (39-41), `roughly` (43-58), `quote` (10-12), and the
  `stable` test on line 68 that decides between the two.
- `tools/visualizer/src/content/passes.ts` — `PASS_NOTES` (551 lines), `PassNote`
  (`what`, `why`, `tier`, `source?`, `rerun?`), `RERUNS` (the six suffixes),
  `noteFor` (the suffix fallback).
- `tools/visualizer/src/workers/tiers.ts` — `compareTiers`, the `TierReport` the
  visualizer's tier table renders.
- `tools/visualizer/src/workers/observe.ts` — `runWith`, `buildWith`, `seen`,
  `observationOf`, `observeInterpreter`, `observeBaseline`, `observeJit`, `observeAot`,
  `Observation` (`signature`, `lines`, `attempts`, `ok`), `Watch`.
- `tools/visualizer/src/workers/engine-options.ts` — `HOT_TIERING` (`jit: 2, baseline: 1,
  loopOsr: 2`), `FORCED_TIERING`, `COLD_TIERING`, `BASELINE_TIERING`, `TRACED_CATEGORIES`
  (the seven categories the visualizer subscribes to).
- `tools/visualizer/src/content/samples.ts` — the eight samples, including
  `branching-call` (46-65) which this chapter measures.
- `tools/ui/vite.ts` — `teraAliases` mapping bare `tera` to
  `src/index.browser.ts` (line 36) and `tera-data/*` to `data/*`, `teraViteConfig`,
  `teraTestConfig`, and `server.fs.allow` reaching outside the app root so the app can
  import the engine's own sources.
- `src/index.browser.ts` — the browser entry the alias resolves to; the compiler runs *in
  the page*, which is why there is no server in this architecture.

## Worked example

The **Cost** tab on the `branching-call` sample. `costOf` sums `Stage.elapsedMs` over the
stages that carry a measurement and are not `skipped`, and separately sums the ones whose
`changed` flag is false. Measured on 2026-09-07 on this machine, one case in one fresh
process, at the visualizer's default `speed` opt level, replicating what `runJit` records:

```
148 timed passes, 3.2 ms
139 changed nothing, 2.4 ms
```

The pass counts are stable across runs; the milliseconds move by a few tenths, which is
the whole reason the tab reports both a count and a time. The point is the ratio, and it
is the argument for chapter 41's pass manager and for chapter 77's bisect: on a
fourteen-line program, **94 % of the timed passes rewrite nothing at all**, and finding
which one broke your program by reading them is not a strategy.

Reproduce it with the script in *Verify it yourself*; the same numbers appear in the UI by
running the sample and opening the Cost tab.

## Outline

- [ ] **The architecture in one sentence: there is no server.** Establish that the whole
      engine — lexer, checker, bytecode compiler, middle end, both backends — is imported
      into a browser worker. `tools/ui/vite.ts`'s `teraAliases` points the bare specifier
      `tera` at `src/index.browser.ts`, and `server.fs.allow` is widened to the repo's
      parent so Vite will serve the engine's own TypeScript. Land the consequence used
      throughout: everything the visualizer knows, it knows by *running the compiler*, not
      by parsing a log file. Cross-reference [Ch 82 § the-tools-workspace].
- [ ] **Six hooks.** Establish the recording surface as it appears in one object literal
      (`compiler-worker.ts:582-586` and `736-742`): `compilerOptions(optLevel)` is the base
      the engine would have used anyway; `passTracer` fires per middle-end and lowering
      pass; `machineTracer` per machine-IR stage; `moduleTracer` per module-level AOT stage;
      `allocationTracer` once per emitted symbol; and the engine's own `onTrace` is the
      seventh party — the *runtime* event sink, categorically different because it fires
      while the program runs, not while it compiles. Establish `verifyEachPass` riding along
      as the reader's `--verify` ([Ch 78 § verify-each-pass]). **New idea:** a *trace record*
      is structured data with an ordinal, not a formatted line; that is what lets a UI diff
      two of them.
- [ ] **The `Stage` record is the whole vocabulary.** Establish `Stage`'s sixteen fields and
      that every pane in the app is a projection of a `readonly Stage[]`: `group` and `kind`
      drive the tree, `text` the code pane, `changed` the diff badge, `elapsedMs` the Cost
      tab, `verification` the failure banner, `requires`/`invalidated` the analysis view,
      `remarks` the remark list, `positions` the source-line links and the deopt back-link.
      Establish `StageCollector.plain` filling the fields a non-pass stage does not have from
      shared frozen constants (`NO_REMARKS`, `NOTHING_BROKEN`, `NO_ANALYSES`,
      `NO_POSITIONS`) so every consumer can read every field unconditionally.
- [ ] **The observer effect, and the gate that fixes it.** The chapter's central beat.
      Establish the problem concretely: the engine tiers functions up *by itself* once
      `HOT_TIERING` (`jit: 2`) trips, so `engine.run(source)` already compiles `drive` — and
      then `runJit` calls `engine.optimizeFunction` on every hot function to produce a
      pipeline the reader can page through. Without a gate, every pass would be recorded
      twice, with two different sets of value ids. Establish the answer:
      `collect.recording = false` around `engine.run`, during which `tracer` diverts to
      `capture` instead of pushing a stage. **Why the obvious design fails:** simply *not*
      installing the tracer during the run would lose the one graph that matters, because
      the ids the runtime later reports in a `[DEOPT]` line belong to the graph the engine
      actually ran, not to the replay.
- [ ] **The frozen executed graph.** Establish `ExecutedGraph` and `capture`'s three-line
      state machine: first record for an owner wins the slot; a later record with a *lower*
      ordinal means the engine has started a second compile of the same function, so
      `frozen = true` and the slot never changes again; otherwise keep the latest *changed*
      printing. Establish `executedStages()` emitting one stage per owner in the `executed`
      group, titled `as the engine ran it, after <pass>`, and its note in `PASS_NOTES`
      (`executed-graph`) saying exactly why it exists: *"the one graph whose value numbers
      match what the runtime reports"*. Establish that `node-history` deliberately excludes
      it, because it is not a step in the pipeline.
- [ ] **The AOT path records more and runs the program twice.** Establish `runAot`:
      `engine.compile` for bytecode (via `nestedFunctions`, because AOT never runs anything
      so nested functions never surface on their own), then `engine.compileAot` with all
      four tracers, then a `codegen` stage per emitted file — text as text, bytes through
      `hexDump`. Establish `execute()` building a *second, untraced* `Engine` to run the
      program for its output, and why: a browser cannot run an ELF or a PE, so the only
      honest way to show "what this program prints" beside "what the compiler emitted" is to
      interpret it. Establish `program.skipped` surfacing as the run's `error` — the refusal
      vocabulary of [Ch 56 § what-aot-declines] arriving in a UI.
- [ ] **Budgets, and the one that had to stop being shared.** Establish `EVENT_BUDGET` as a
      *per-category* cap (`jit: 200`, `deopt: 200`, `feedback: 120`, `hidden_class: 120`,
      `gc: 120`, `ic: 150`, everything else 80) with a `dropped` counter reported back so the
      UI can say how much it threw away, plus `OUTPUT_BUDGET = 400` on printed lines and
      `SHAPE_BUDGET = 300` on hidden-class edges. **What was tried and rejected:** one shared
      cap. Inline-cache events are the most numerous category by a wide margin, so a single
      budget let `ic` traces exhaust it before the `[DEOPT]` line the reader opened the tool
      to see was ever recorded. Per-category budgets are the fix, and the `dropped` map is
      what keeps the truncation visible instead of silent. Cross-reference
      [Ch 54 § reading-a-deopt].
- [ ] **Reading a pass, part one: the diff has to be keyed by identity.** Establish `index`
      in `ir-diff.ts` building a `Map` keyed by SSA value name (`v12`), block label (`B3`),
      or a per-block ordinal for anything unnamed, and `rowFor` classifying `changed`
      (text differs), `moved` (same text, different block) and `same`. **New idea:** a line
      diff answers "which lines of this file differ"; an SSA graph is not a file, and the
      question is "what happened to *this value*". Establish the case that forced it: `licm`
      hoists a node out of a loop without altering a character of it, which a line diff
      reports as a deletion and an insertion and an identity diff reports as one `moved`
      row. Establish `dropUntil` preserving removal order. Pin with
      `"keys rows by value id, not by line position"`,
      `"reports a value hoisted into another block as moved, not as unchanged"` and
      `"keys instructions inside their own block, so an edit stays local"`.
- [ ] **Reading a pass, part two: drawing a graph that has cycles.** Establish
      `layerBlocks` as a breadth-first layering: each block's row is its BFS distance from
      the entry, and unreachable blocks are pushed to `deepest + 1`. **New idea:** the
      textbook layered-graph algorithm assigns each node the *longest* path from the entry,
      which is only defined on a DAG — a loop has no longest path, so the obvious algorithm
      does not terminate on any graph with a back edge, which is every interesting one.
      BFS is chosen because it terminates and because a back edge then visibly climbs the
      page. Establish `isBackEdge` and `ARROW_KINDS` splitting edges into `forward`, `back`
      and `data`. Pin with `"puts each block in the row its distance from the entry earns
      it"` and `"sends an edge that climbs the page around the right of every row it spans"`.
- [ ] **Orthogonal routing is held down by geometry tests.** Establish that
      `graph-layout.ts` produces `RoutedEdge` corner lists, not SVG curves, and that the
      constants (`ARROW_LENGTH`, `CORNER`, `DATA_LANE_NEAR`/`FAR`, `DATA_GUTTER`,
      `LANE_SHARE`) are the whole design. Establish the unusual thing worth naming: the
      twenty-odd tests in `graph-layout.test.ts` assert *geometry* — that a stroke stops one
      arrow-head short of the border, approaches square for the arrow's whole length, never
      doubles back while rounding a corner, and that two edges from a repeated input get
      lanes of their own. A rendering bug in a teaching tool is a *wrong explanation*, which
      is why it is pinned like a compiler invariant.
- [ ] **Dominance and the loop forest, recomputed in the browser.** Establish
      `dominanceOf` running Cooper–Harvey–Kennedy over `parseGraphText`'s model: reverse
      post-order via `reachableOrder`, the two-pointer `meet` climbing by rank, and the
      iterate-to-fixpoint loop. **New idea:** *dominance* — block A dominates B when every
      path from the entry to B goes through A — and a *fixpoint*: repeat until nothing
      changes. Establish `loopForestOf` finding back edges as successors that dominate their
      source, `bodyOf` walking predecessors from the latches, and nesting by body
      containment. Land the point: the visualizer re-derives these from *printed text*
      rather than trusting the compiler's own analysis, so the two can disagree — which is
      what makes the pane worth looking at. Pin with
      `"hangs a merge off the branch, not off either arm"`,
      `"finds the loop whose back edge returns to a block that dominates it"` and
      `"nests an inner loop under the outer one it sits inside"`.
- [ ] **Remarks, analyses and node history.** Establish `stageRemark` carrying the
      compiler's own `Remark` through with its `kind` (`missed` / `applied` / `analysis`) and
      its node renamed to `v<id>` — the compiler saying *why a pass did not fire*, which is
      the thing a pass diff can never show. Establish `requires`/`invalidated` naming
      analyses by their symbol descriptions. Establish `historyOf` following one value across
      every stage of one owner and classifying each step `born` / `rewritten` / `moved` /
      `held` / `gone`, so the reader can ask "when did `v12` die?" instead of paging.
      Pin with `"tells born, untouched, moved, rewritten and deleted apart"` and
      `"names the pass that created it and the pass that deleted it"`.
- [ ] **The tier table and the deopt back-link.** Establish `compareTiers` running the
      program four ways (`COLD_TIERING`, `BASELINE_TIERING`, plain JIT, forced JIT) plus, for
      an AOT target, a *build* row rather than a run row — the same honest asymmetry
      `observeAot` makes, and the seed of chapter 79's differential argument. Then
      `targetForDeopt`: given a `DeoptOrigin` scraped out of a runtime trace event, find the
      guard by node id and opcode in the latest stage that still holds it; failing that,
      fall back to the reported source line but only when it resolves to exactly one node;
      and failing that, report `retired` when the opcode is gone from the graph entirely, or
      plain `graph` when it is merely ambiguous. Land the design claim: a tool that cannot
      find the answer says which kind of not-found it is. Pin with
      `"reports the guard as retired when the graph no longer contains that operation at
      all"`, `"picks no node, but does not call the guard retired, when the line holds
      several of that operation"` and `"prefers the latest stage that still holds the
      guard"`.
- [ ] **Copy as test, and the node ids that will not sit still.** Establish `fixtureFor`
      turning any IR stage plus its predecessor into a runnable vitest file against
      `afterNamedPass`. Establish the problem it must dodge: value ids are minted by an
      ambient counter, so a pass that *creates* nodes produces ids that are not reproducible
      across a different compile ([Ch 43 § node-id-stamping]). Establish the `stable` test —
      no new ids, or nothing removed and no new opcode — choosing between `exactly` (assert
      the whole graph) and `roughly` (assert at most four removed lines and four new
      opcodes). Pin with `"asserts on the exact graph when the pass minted no new value"` and
      `"drops the exact graph when the pass minted values, since their ids are not
      reproducible"`.
- [ ] **The prose that cannot rot.** Close on `PASS_NOTES`: 551 lines of teaching text,
      one entry per pass with `what`, `why`, `tier` and a `source` path, plus `RERUNS`
      mapping six suffixes (`-early`, `-after-escape`, `-after-late-escape`,
      `-after-unreachable`, `-after-peeling`, `-late`) onto their base note so a rerun is
      explained as *why it runs again*. Establish `passes.test.ts` as the mechanism this
      whole book envies: it builds the real pass name set from `middleEndPassNames`, every
      backend's `loweringPipeline`, and the machine and module stage lists, then asserts
      both directions — no note for a pass that does not exist, and no pass without a note.
      It goes further and asserts the *tiers*: that `representation-selection` is JIT-only
      because only a tagged backend has it, that `speculation-lowering` is AOT because only
      the JIT settles a guess by deoptimizing, and that `allocation-shape` is JIT because
      `capabilityCheck` refuses a `CheckMap` on every AOT target. Then state the honest
      thing in *Honesty items*: in this working tree that test is red, which is the
      mechanism working, not failing.

## Honesty items

> **Broken.** `tools/visualizer/tests/passes.test.ts` fails three of its twelve assertions
> in this working tree (verified 2026-09-07: 3 failed, 173 passed across the visualizer
> suite). `PASS_NOTES` has a note for `boolean-text`, a pass name no pipeline produces any
> more; `int32-overflow-widening` is a middle-end pass with no note; and seven lowering
> passes have none — `float-remainder`, `element-types`, `type-narrowing-after-generators`,
> `text-method-calls`, `printed-text`, `text-concatenation`, `parse-number-surface`. This is
> the coverage test doing its job: the pipeline moved and the teaching prose did not. Cost:
> eight `PassNote` entries, one deletion, and one more suffix (`-after-generators`) in
> `RERUNS` — under an hour, and the test tells you when you are done.

> **Unenforced.** Nothing checks that `VISUALIZER_PASS_NAMES` — the visualizer's own
> synthetic stage names (`tokenize`, `parse`, `typecheck`, `bytecode`, `declined`,
> `codegen`, `executed-graph`) — stay disjoint from the compiler's real pass names. They are
> merged into one `Set` in `passes.test.ts`'s `realPassNames`, so a real pass that ever took
> one of those names would be silently accepted as documented. Cost: one `expect` asserting
> the intersection is empty.

> **Unenforced.** `MACHINE_STAGES` and `MODULE_STAGES` in `passes.test.ts` are hand-written
> string arrays. The middle-end and lowering halves of the same test derive their names from
> `middleEndPassNames` and `backend.loweringPipeline`; these two do not, so a renamed machine
> or module stage produces a stale note that the test still calls covered. Cost: export the
> stage name lists from the machine and AOT drivers the way `middleEndPassNames` already is.

> **Unfinished.** `Stage.elapsedMs` is `0` for every stage that is not a `passTracer`
> record. `machine`, `module`, frontend, bytecode and codegen stages are all hard-coded to
> zero, and `costOf` filters on `elapsedMs > 0` — so the Cost tab reports the middle end and
> lowering only, and a reader looking at an AOT run cannot see what instruction selection or
> register allocation cost. Cost: an `elapsedMs` field on `MachineTraceRecord` and
> `ModuleTraceRecord`, and a `performance.now()` pair at each call site.

> **Unfinished.** The recording gate is a public mutable field (`StageCollector.recording`)
> that only `runJit` sets. `runAot` never touches it, so on the AOT path the field is `true`
> for the whole compile and `capture` never runs — which is correct today only because
> `runAot` calls `engine.compileAot` exactly once. Nothing enforces that. Cost: make the gate
> a scoped helper that both paths must use.

> **Unenforced.** `deoptOriginOf` and `shapeEdgeOf` reconstruct structured data by
> `typeof`-checking untyped fields off a trace event's `data` bag (`traced.reason`,
> `traced.nodeId`, `traced.from`, `traced.property`). A rename on the producing side —
> anywhere in `src/` that calls `tracer.log("deopt", …)` — silently yields `null`, and the
> deopt back-link quietly stops working with no error anywhere. Cost: a declared payload type
> per trace category, shared by the logger and the reader. This is the same unchecked-category
> problem [Ch 73 § trace-categories] raises, one level deeper.

> **Unfinished.** `runJit` reports `"No function collected feedback: call a function so the
> JIT has something to optimize."` as an *error*, not as an explanation, for any program
> whose functions never got hot — which includes `docs/example/stats.tera`, since it calls
> `mean` twice. The tool's own `HOT_TIERING` (`jit: 2`) is what makes the samples work; the
> book's running example does not reach it. That is why every listing in this chapter comes
> from `tools/visualizer/src/content/samples.ts` instead.

## Verify it yourself

```bash
npm --workspace tools/visualizer run test
npm --workspace tools/visualizer run test -- tests/passes.test.ts
npm --workspace tools/visualizer run test -- tests/ir-diff.test.ts tests/cfg-analysis.test.ts tests/deopt-link.test.ts tests/pass-cost.test.ts
```

The first reports `3 failed | 173 passed`; the three failures are the `PASS_NOTES` coverage
gap named above, and every other claim in this chapter is in the 173.

The Cost measurement, replicating what `runJit` records — write it to a file in the repo
root and delete it afterwards, because it imports `./src/index.js` and the sample list by
relative path:

```bash
cat > cost-probe.ts <<'EOF'
import { createReactiveTeraOptions } from "@slexisvn/reactive/tera";
import { compilerOptions, createBackendRegistry, Engine, nativeToTagged, taggedToNative } from "./src/index.js";
import { SAMPLES } from "./tools/visualizer/src/content/samples.js";
const source = SAMPLES.find((s: any) => s.id === "branching-call")!.source;
const rows: any[] = [];
let on = false;
const engine = new Engine({
  ...createReactiveTeraOptions({ nativeToTagged, taggedToNative }),
  backends: createBackendRegistry(), typecheck: "off",
  tieringPolicy: { jitThreshold: 2, baselineThreshold: 1, loopOsrThreshold: 2 },
  compilerOptions: { ...compilerOptions("speed"), passTracer: (r: any) => { if (on) rows.push(r); } },
  output: () => {},
} as any);
engine.run(source);
on = true;
const seen = new Set<string>();
for (const f of engine.collectFunctions()) {
  const n = f.name ?? "<anonymous>";
  if (seen.has(n)) continue;
  seen.add(n);
  if (f.feedbackVector !== null) engine.optimizeFunction(f);
}
const timed = rows.filter((r) => r.elapsedMs > 0 && !r.skipped);
const idle = timed.filter((r) => !r.changed);
const ms = (rs: any[]) => rs.reduce((a, r) => a + r.elapsedMs, 0).toFixed(1);
console.log(`${timed.length} timed passes, ${ms(timed)} ms`);
console.log(`${idle.length} changed nothing, ${ms(idle)} ms`);
EOF
npx tsx ./cost-probe.ts && rm cost-probe.ts
```

## Tests that pin this

- `tools/visualizer/tests/ir-diff.test.ts` > `"keys rows by value id, not by line position"`
- `tools/visualizer/tests/ir-diff.test.ts` > `"reports a value hoisted into another block as moved, not as unchanged"`
- `tools/visualizer/tests/ir-diff.test.ts` > `"reports a value the pass deleted as removed"`
- `tools/visualizer/tests/ir-diff.test.ts` > `"reports a value the pass introduced as added"`
- `tools/visualizer/tests/ir-diff.test.ts` > `"reports a rewritten value as changed and keeps the old text"`
- `tools/visualizer/tests/ir-diff.test.ts` > `"treats the graph attribute line as its own row"`
- `tools/visualizer/tests/ir-diff.test.ts` > `"keys instructions inside their own block, so an edit stays local"`
- `tools/visualizer/tests/ir-diff.test.ts` > `"does not report the second block as changed when only the first one shrank"`
- `tools/visualizer/tests/cfg-analysis.test.ts` > `"makes the entry the root, dominating everything reachable"`
- `tools/visualizer/tests/cfg-analysis.test.ts` > `"hangs a merge off the branch, not off either arm"`
- `tools/visualizer/tests/cfg-analysis.test.ts` > `"finds the loop whose back edge returns to a block that dominates it"`
- `tools/visualizer/tests/cfg-analysis.test.ts` > `"leaves the exit block outside the loop body"`
- `tools/visualizer/tests/cfg-analysis.test.ts` > `"nests an inner loop under the outer one it sits inside"`
- `tools/visualizer/tests/cfg-analysis.test.ts` > `"finds no loop in a graph with no back edge"`
- `tools/visualizer/tests/graph-layout.test.ts` > `"puts each block in the row its distance from the entry earns it"`
- `tools/visualizer/tests/graph-layout.test.ts` > `"sends an edge that climbs the page around the right of every row it spans"`
- `tools/visualizer/tests/graph-layout.test.ts` > `"stops the stroke one arrow head short of the border it points at"`
- `tools/visualizer/tests/graph-layout.test.ts` > `"never doubles back on itself while rounding a corner"`
- `tools/visualizer/tests/graph-layout.test.ts` > `"draws a block that jumps to itself as a loop below it, not as a point"`
- `tools/visualizer/tests/graph-layout.test.ts` > `"gives the two edges of a repeated input lanes of their own to travel in"`
- `tools/visualizer/tests/graph-layout.test.ts` > `"marks the edges that climb the page apart from the ones that descend"`
- `tools/visualizer/tests/pass-cost.test.ts` > `"adds up only the passes that carry a measurement"`
- `tools/visualizer/tests/pass-cost.test.ts` > `"counts time spent by passes that changed nothing as wasted"`
- `tools/visualizer/tests/pass-cost.test.ts` > `"leaves out a pass the bisect skipped, since it never ran"`
- `tools/visualizer/tests/pass-cost.test.ts` > `"lists the slowest passes first and keeps only as many as asked"`
- `tools/visualizer/tests/node-history.test.ts` > `"tells born, untouched, moved, rewritten and deleted apart"`
- `tools/visualizer/tests/node-history.test.ts` > `"names the pass that created it and the pass that deleted it"`
- `tools/visualizer/tests/node-history.test.ts` > `"leaves the executed-graph copy out, since it is not a step in the pipeline"`
- `tools/visualizer/tests/deopt-link.test.ts` > `"selects the node when a stage agrees on both its id and its opcode"`
- `tools/visualizer/tests/deopt-link.test.ts` > `"reports the guard as retired when the graph no longer contains that operation at all"`
- `tools/visualizer/tests/deopt-link.test.ts` > `"falls back to the one guard on the reported source line after a renumbering"`
- `tools/visualizer/tests/deopt-link.test.ts` > `"picks no node, but does not call the guard retired, when the line holds several of that operation"`
- `tools/visualizer/tests/deopt-link.test.ts` > `"prefers the latest stage that still holds the guard"`
- `tools/visualizer/tests/deopt-link.test.ts` > `"refuses to guess between several candidates"`
- `tools/visualizer/tests/fixture.test.ts` > `"asserts on the exact graph when the pass minted no new value"`
- `tools/visualizer/tests/fixture.test.ts` > `"drops the exact graph when the pass minted values, since their ids are not reproducible"`
- `tools/visualizer/tests/fixture.test.ts` > `"names the pass and the function it ran on"`
- `tools/visualizer/tests/fixture.test.ts` > `"escapes anything that would end the template literal"`
- `tools/visualizer/tests/tiers.test.ts` > `"runs the interpreter, the baseline and both JIT settings"`
- `tools/visualizer/tests/tiers.test.ts` > `"adds the build as its own row for an AOT target"`
- `tools/visualizer/tests/tiers.test.ts` > `"still agrees when every tier fails the same way"`
- `tools/visualizer/tests/passes.test.ts` > `"says JIT for the representation passes because only the JIT backend is tagged"`
- `tools/visualizer/tests/passes.test.ts` > `"says AOT for speculation lowering, because only the JIT settles a guess by deoptimizing"`
- `tools/visualizer/tests/passes.test.ts` > `"says JIT for the guard-shaped passes, because no AOT target may hold a guard"`
- `tools/visualizer/tests/passes.test.ts` > `"keeps dead-store elimination on both tiers, where allocation sinking leaves the AOT one"`
- `tools/visualizer/tests/passes.test.ts` > `"explains a rerun by pointing at the base pass and saying why it runs again"`
- `tools/visualizer/tests/passes.test.ts` > `"writes no note for a pass name the compiler does not have"` — **currently failing**
- `tools/visualizer/tests/passes.test.ts` > `"covers every middle-end pass, counting reruns through their base note"` — **currently failing**
- `tools/visualizer/tests/passes.test.ts` > `"covers the lowering pipeline too, which is most of what a reader clicks"` — **currently failing**
- The recording gate itself — `StageCollector.recording`, `capture`, `executedStages` — has
  no test. Nothing asserts that a stage is recorded exactly once, or that the frozen
  executed graph is the one the engine ran. `[unpinned]`
- `EVENT_BUDGET` and the `dropped` map have no test. `[unpinned]`
