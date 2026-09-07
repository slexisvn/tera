# 80. The Agreement Contract   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** Frame states, deoptimization, dependency invalidation, speculative-type taint,
OSR, one-answer-per-value-kind and differential testing are not seven unrelated
mechanisms — they exist for one reason, which is to make four machines answer the same
thing.

**What arrived.** Four working machines and the instruments that watch them: a
`RegisterCompiledFunction` carrying a feedback vector, generated JavaScript, a
`WebAssembly.Instance` with `runtimeStub`/`deopt` imports and a registered `Dependency[]`,
a native `PE32+`/`ELF64` file that can do none of that, and `--trace-deopt`, `--verify`
and `tests/helpers/tiers.ts` from Part XII.

**What leaves.** One sentence — *four machines, one answer* — and the divergence ledger:
the enumerated places where that sentence is currently false, each naming a file and a
symbol. [Ch 81] then argues that refusal is what makes the sentence affordable.

**New ideas.** None new. This chapter is the synthesis that pipeline order earns: every
concept it uses was taught at the point of first need, and the work here is putting seven
of them side by side. It does introduce one *piece of notation*: the dependency key
`kind:id:version` as a single string, which is how `dependencyKey` in
`src/deopt/dependencies.ts` writes a fact down.

**Length.** 12 pages

## Anchors

- `src/deopt/dependencies.ts` — `DEP_MAP`, `DEP_ELEMENTS_KIND`, `DEP_CALL_TARGET`,
  `DEP_PROTO_VALIDITY`, `DependencyKind`, `Dependency` (`{kind, id, version?}`),
  `dependencyKey(kind, id, version)`, `DependencyRegistry` (`byKey`, `byFunction`,
  `osrByKey`, `osrByFunction`, `lazyMarker`, `register`, `registerOsr`, `unregister`,
  `unregisterOsr`, `invalidate`, `getSummary`, `bindLazyMarker`, `clear`),
  `normalizeDependencies`, `withDependencyRegistry`, `getCurrentDependencyRegistry`, and
  the `dependencyRegistry` `Proxy` that forwards every access to whichever registry is
  ambient.
- `src/deopt/frame-state.ts` — `FrameState` (`compiledFunction`, `bytecodeOffset`,
  `localValues`, `stackValues`, `thisValue`, `callerFrameState`, `isInlinedFrame`,
  `safepoint`, `sunkAllocations`), `clone`, `matches`, `getInlineChain`, `getInlineDepth`,
  `toCompact`, `toString`, `FrameStateBuilder.capture`, `FrameValue`,
  `VirtualAllocation`.
- `src/optimizing/analyses/type-inference.ts` — `TypeInference` (the two-method interface:
  `typeOf` and `isSpeculative`), `SPECULATIVE_SOURCES` (the seven check opcodes),
  `TypeSolver.propagateSpeculation` (taint is a second, monotone worklist running
  alongside the type join), `inferTypes`, `typeInferenceAnalysisId`.
- `src/runtime/member-lookup.ts` — `MEMBER_LOOKUPS` built by `lookupTable(...)` — one
  array indexed by `codeOf(receiver)` — `memberLookupValue`, and the ten entries
  (`arrayMember`, `stringMember`, `regexMember`, `generatorMember`, `promiseMember`,
  `functionMember`, `numberMember`, `booleanMember`). This is the "by construction" half
  of agreement.
- `src/optimizing/metadata/builtin-methods.ts` — `BUILTIN_METHOD_DECLARATIONS`,
  `GLOBAL_BUILTIN_DECLARATIONS`, `NAMESPACE_FUNCTION_DECLARATIONS`,
  `BUILTIN_METHOD_NAMES`, `GLOBAL_BUILTIN_NAMES`, `STRING_PRODUCING_BUILTINS`,
  `builtinMethodIntrinsicByName`, `builtinIntrinsicByName`. Note what these are: *names
  and signatures*, not implementations. The asymmetry with `member-lookup.ts` is the
  chapter's sharpest point.
- `tests/helpers/tiers.ts` — `TIERS` (the seven named threshold sets: `oracle`,
  `baseline`, `jit`, `osr`, `eager`, `baselineOsr`, `production`), `differential`,
  `differentialModules`, `tierUp`, `PRINTS_INSTEAD_OF_ANSWERING`, `answersNothingVisible`.
- `src/objects/maps/hidden-class.ts:375` — `HiddenClass.invalidate(reason)`: bumps
  `version` and `prototypeValidityCell.version`, then calls
  `dependencyRegistry.invalidate` twice, once for `DEP_MAP` and once for
  `DEP_PROTO_VALIDITY`, both against the **old** version.
- `src/objects/heap/js-object.ts:216` — `invalidatePrototypeDependents(reason)`, the
  prototype-store half; and `:333`, `oldHC.invalidate(\`add:${name}\`)`, the
  add-a-property half, guarded by `!hadTransition && oldHC.objectCount > 1`.
- `src/optimizing/builder/ir-builder.ts:1106, :1222` and
  `src/optimizing/builder/inline.ts:549, :609` — `graph.addDependency(DEP_MAP, mapId,
  mapVersion)`, the four places a `CheckMap` is paired with a promise.
- `src/api/engine.ts:1798` — `this.dependencyRegistry.register(compiledFn,
  optimizerResult.graph.dependencies || [])`, the one call that turns a graph's collected
  facts into a live subscription; and `:1968`, `flushOptimizedCode`, which unregisters.

## Worked example

One dependency, followed as a single number across three files and three chapters, then
broken.

> **A note on rule 1.** `docs/example/stats-deopt.tera` breaks an *elements-kind*
> dependency, and it is the file this chapter ships with. But no file in `docs/example/`
> registers and then breaks a **map** dependency, which is the one the reader met in
> [Ch 34] and [Ch 39]. Rather than contrive a ninth variation, this chapter uses a
> seventeen-line probe written in the chapter itself and shows the `stats-deopt.tera`
> output beside it. If a later edition wants this in the example set, the probe below is
> what it should become — and `tests/e2e/docs/book-examples.test.ts` would need an entry.

Write this probe (any path):

```
class Point:
  public constructor(x: float, y: float):
    this.x = x
    this.y = y

fn sum(p) -> float:
  return p.x + p.y

p = Point(1.0, 2.0)
total = 0.0
i = 0
while i < 200:
  total += sum(p)
  i += 1
q = Point(3.0, 4.0)
q.z = 5.0
total += sum(q)
print(total)
```

```bash
node dist/cli.js --trace-deopt dep.tera
```

produces, verbatim:

```
[DEOPT] Dependency registered: sum -> map:87:0
[DEOPT] DEOPT "sum": Marked for lazy deopt: add:z
[DEOPT] Dependency invalidated: sum (add:z)
[DEOPT] Dependency registered: sum -> map:87:0
[DEOPT] DEOPT "sum": map-check-failed at bytecode:2
607
```

Five lines that are the whole chapter. `map:87:0` is `dependencyKey(DEP_MAP, 87, 0)` — one
string carrying kind, id and version. It is written by the IC [Ch 34], turned into a
`CheckMap` plus an `addDependency` by the builder [Ch 39], registered by
`Engine.optimizeFunctionInRuntime`, invalidated by `HiddenClass.invalidate` when `q.z = 5.0`
transitions a map that more than one object was using, routed through
`Deoptimizer.lazyMarker`, and finally *also* caught by the guard the compiler emitted —
belt and braces, and the chapter says why both exist.

`docs/example/stats-deopt.tera` is the elements-kind twin of the same story, and is the
version that ships in the example set:

```bash
node dist/cli.js --trace-deopt docs/example/stats-deopt.tera
```

## Outline

- [ ] **§ the-one-sentence** — Establish the contract in one line, and establish that it is
      *stronger* than it sounds: `differential` compares with `toEqual`, and `peAgrees`
      compares stdout bytes. Not "close enough", not "same to a rounding". State the two
      halves of how it is kept — *by construction* (one table, four readers) and *by
      proof* (differential testing) — and that the chapter is about which mechanism does
      which.
- [ ] **§ frame-state-recall** — Recall [Ch 40] in one page. A `FrameState` is a
      description of a frame you no longer have: `{compiledFunction, bytecodeOffset,
      localValues, stackValues, thisValue}` plus `callerFrameState` for an inlined frame
      and `sunkAllocations` for objects that were optimized out of existence. Its job in
      *this* chapter's terms: it is how a machine takes a bet back without the program
      noticing. Note that `matches` compares by identity of every value — it is a cache
      key, not a semantic equality.
- [ ] **§ deopt-recall** — Recall [Ch 54]. Three ways a bet stops paying: the guard fires
      (`map-check-failed`, `elements-kind-check-failed`, `wrong-call-target` — the
      contents of `IC_FAILURE_REASONS` in `src/deopt/deoptimizer.ts`); the dependency
      registry says the fact is gone; or the stub itself throws a `DeoptSignal`. Establish
      that all three land in the same place — `Deoptimizer` — and that only the second is
      *lazy*, i.e. takes effect at the next entry rather than immediately.
- [ ] **§ one-number-three-chapters** — The chapter's spine, and the reason it is in
      pipeline order at all. Follow `map:87:0` through the three files it lives in, in the
      order the reader met them: `src/feedback/ic/index.ts` records the map and its version
      on a hit [Ch 34]; `src/optimizing/builder/ir-builder.ts:1106` emits `CheckMap` *and*
      `graph.addDependency(DEP_MAP, mapId, mapVersion)` in the same breath [Ch 39];
      `src/objects/maps/hidden-class.ts:375` calls
      `dependencyRegistry.invalidate(DEP_MAP, this.id, oldVersion, reason)` [Ch 54]. One
      string, three chapters, three files. Then the design point: the guard and the
      dependency are *redundant on purpose* — the guard catches the object in front of you,
      the dependency catches every compiled function that assumed the fact, including ones
      that are not on the stack.
- [ ] **§ versioned-and-unversioned** — Establish the subtlety in `invalidate`: it builds
      **two** keys, `kind:id:version` and `kind:id`, and unions the functions found under
      both. A registration that named no version subscribes to *every* version of that
      fact; a registration that named one subscribes only to that one. Invariant →
      enforcement → test.
- [ ] **§ osr-registrations-are-separate** — Establish why `osrByKey`/`osrByFunction` are a
      second, parallel index. An OSR entry [Ch 37] is a bet *entered in the middle*, so
      invalidating it cannot mean "deoptimize on next entry" — there is no next entry. So
      `invalidate` handles OSR by `fn.osrCache.clear()` and `unregisterOsr`, with no marker
      and no deopt. Establish that this is the one place in the mechanism where two kinds
      of bet need genuinely different revocation.
- [ ] **§ speculative-taint** — Recall [Ch 49] in one page and put it beside the others. A
      `CheckSmi` narrows a type, but the narrowing is only true *because a guard is
      standing there*; AOT deletes the guard. So `TypeSolver` carries a second, monotone
      worklist — `propagateSpeculation` — that marks every value reachable from one of the
      seven `SPECULATIVE_SOURCES`, and `TypeInference` exposes `isSpeculative` next to
      `typeOf`. The general rule, stated once: **a fold must ask whether its own
      justification survives the tier it is folding for.**
- [ ] **§ by-construction** — Recall [Ch 25]. `src/runtime/member-lookup.ts` is one array
      indexed by tag code; `memberLookupValue` is fifteen lines. Three tiers cannot
      disagree about what `.length` means on a string because there is exactly one place
      that answers. Establish the general shape: *make the disagreement unrepresentable*
      beats *test that it does not happen*, and name what it cost (every value kind's
      lookup had to be pulled out of the interpreter and given a uniform signature).
- [ ] **§ the-asymmetry** — *Where they disagree anyway.* Establish the contrast plainly:
      `member-lookup.ts` shares an **implementation**; `builtin-methods.ts` shares only a
      **list of names and signatures** — `BUILTIN_METHOD_DECLARATIONS` is nineteen
      declarations of the form `{owner, name, pure, params?, returns?}` and no code. AOT
      re-implements every one of them, in tera and in three backends [Ch 60]. So the string
      methods are agreed by *convention plus tests*, not by construction. Say exactly what
      this buys (AOT needs no interpreter at run time) and exactly what it costs (every
      `to_fixed`, `parse_float`, `Math.exp` is a second implementation that can drift, and
      two of them have).
- [ ] **§ differential-is-the-only-proof** — Recall [Ch 79]. Read `tests/helpers/tiers.ts`
      closely: `TIERS` is seven threshold sets, not seven engines; `differential` runs the
      `oracle` and then asserts `toEqual` for each named tier; `peAgrees`
      (`tests/helpers/aot-agreement.ts`) is the native half and compares stdout, not
      values. Establish the guard the helper carries — `answersNothingVisible` throws
      `PRINTS_INSTEAD_OF_ANSWERING` when the source ends in a `print(`, because the tiers
      would then be compared as `undefined === undefined`. That guard is a small, exact
      illustration of the chapter's whole subject: a test that agrees for the wrong reason
      is worse than no test.
- [ ] **§ divergence-ledger** — The close. A table generated by hand from the honesty
      markers of the preceding seventy-nine chapters, listing every place the four machines
      are known **not** to agree, with the file and symbol and the marker that raised it.
      At minimum: the optimizing tier vs `--no-opt` on an `int[]` comparison that returns
      early from inside a `while` (see Honesty items — this reproduces today); AOT's
      re-implemented builtins vs the host's (`Math.exp(1)` is fdlibm's, not V8's, [Ch 60]);
      AOT's two absence values vs the interpreter's [Ch 57]; and every function AOT refuses
      outright, which is [Ch 81]'s subject. State the rule: **an entry leaves this table
      only when a test pins the agreement, not when someone believes it was fixed.**

## Honesty items

- > **Broken.** The optimizing tier answers differently from `--no-opt` on a program with
  no module-level state beyond two `int[]`s. A `compare(a: int[], b: int[]) -> int` that
  returns early from inside a `while` starts answering `0` after roughly fifty calls, once
  the tier has warmed. Verified on 2026-09-07: `--no-opt` prints `-1` then fifty-three
  `1`s; the default tiering prints the same for forty-nine and then five `0`s. The
  reproducer is in Verify it yourself. `tests/e2e/optimizing/decimal-formatter.test.ts >
  "prints what toFixed prints, at every tier"` passes, so the existing regression test does
  **not** cover this shape. Cost of closing: bisect with `--opt-bisect` and per-pass
  `--verify` [Ch 77] to name the pass, which nobody has done; it is not known whether the
  fault is in narrowing, in range analysis, or in the early-return merge.
- > **Unenforced.** Nothing checks that a `CheckMap` and its `addDependency` stay paired.
  `ir-builder.ts` and `inline.ts` emit them adjacently by hand at six sites; a seventh site
  that emitted the check and forgot the dependency would produce code that is *still
  correct* (the guard fires) but loses the eager invalidation, and no test would notice.
  Cost of closing: a graph invariant in `verifyAfterPass`
  (`src/optimizing/pipeline.ts:291`) asserting that every `IR_CHECK_MAP` has a matching
  entry in `graph.dependencies`.
- > **Unenforced.** `DependencyKind` is `... | string` (`src/deopt/dependencies.ts:17`), so
  a typo in a kind is a silent no-op: it registers under a key nothing ever invalidates.
  The four real kinds are named constants; the union's open end exists for extensions
  [Ch 29] and is not gated on anything. Cost of closing: make the type closed and give
  extensions a registration call.
- > **Never runs.** `AdaptiveTieringPolicy.shouldOSR` (`src/runtime/tiering/adaptive.ts:172`)
  is called by nothing in `src/`. The interpreter declares an optional hook for it —
  `shouldOSR?: (compiledFn, loopCount) => boolean` at
  `src/bytecode/register/interpreter/index.ts:198` — that nothing assigns. Its only caller
  is `tests/runtime/tiering/adaptive.test.ts > "shouldOSR returns false without optimized
  OSR entry"`. OSR tier-up is decided in `src/runtime/tiering/osr.ts` instead. Cost of
  finishing: either wire the hook or delete both halves; leaving a policy method that looks
  live is the expensive option.
- > **Unfinished.** The divergence ledger in § divergence-ledger has no generator. Rule 6
  of `docs/CONVENTIONS.md` already requires every marker to be copied by hand into
  `appendix/d-inventory.md`; this chapter's table is a second hand-copy of a subset. Cost
  of finishing: one script that greps `> \*\*(Dead|Never runs|Broken|Measured worse|
  Unfinished|Unenforced)\.\*\*` across `docs/` and emits both tables — but the book has no
  build step by design, so the honest option may be to keep copying and say so.

## Verify it yourself

```bash
node dist/cli.js --trace-deopt docs/example/stats-deopt.tera
cat > /tmp/dep.tera <<'EOF'
class Point:
  public constructor(x: float, y: float):
    this.x = x
    this.y = y

fn sum(p) -> float:
  return p.x + p.y

p = Point(1.0, 2.0)
total = 0.0
i = 0
while i < 200:
  total += sum(p)
  i += 1
q = Point(3.0, 4.0)
q.z = 5.0
total += sum(q)
print(total)
EOF
node dist/cli.js --trace-deopt /tmp/dep.tera
npx vitest run --project unit tests/deopt/dependencies.test.ts tests/runtime/member-lookup.test.ts
npx vitest run --project e2e tests/e2e/optimizing/member-lookup-tiers.test.ts
npx vitest run --project e2e tests/e2e/optimizing/differential-guard.test.ts
```

## Tests that pin this

- The dependency key is one string carrying three things:
  `tests/deopt/dependencies.test.ts` > `"formats kind:id without version"`,
  `"formats kind:id:version with version"`,
  `"treats null/undefined version as no version"`,
  `"treats numeric version 0 as present"`, `"accepts a string id"`.
- Versioned vs unversioned subscription: `tests/deopt/dependencies.test.ts` >
  `"without a version does not match versioned-only registrations"`,
  `"with a version matches both versioned and unversioned registrations"`,
  `"marks a function once when it matches under both versioned and unversioned keys"`.
- Invalidation reaches everyone who bet on the fact, and only them:
  `tests/deopt/dependencies.test.ts` > `"invalidates every function sharing a dependency"`,
  `"marks the function with the full deopt reason, kind and id"`,
  `"counts the function but does not mark it when optimizedCode is null"`,
  `"routes to the lazy marker once bound"`,
  `"leaves other functions sharing the dependency registered"`.
- Re-optimizing replaces the old subscription rather than adding to it:
  `tests/deopt/dependencies.test.ts` >
  `"removes every old dependency before adding the new ones"`,
  `"deduplicates the same dependency"`,
  `"normalizes a missing version to null and preserves a supplied one"`.
- A frame state describes a frame that is gone: `tests/deopt/frame-state.test.ts` >
  `"setLocal/getLocal/hasLocal roundtrip"`, `"getLocalsArray fills gaps with null"`,
  `"clone produces independent copy of locals and stack"`,
  `"clone copies sunkAllocations independently"`,
  `"preserves safepoint and inlined state through clone"`,
  `"getInlineChain returns chain from inner to outer"`,
  `"setCallerFrame marks frame as inlined"`.
- Frame-state identity is by reference, not by value:
  `tests/deopt/frame-state.test.ts` > `"matches identical frame states"`,
  `"returns false for different compiledFunction references"`,
  `"does not match different bytecodeOffset"`,
  `"returns true for two empty frame states with same function and offset"`.
- Lazy invalidation lands at the next entry, not immediately:
  `tests/deopt/deoptimizer.test.ts` >
  `"markForDeopt sets pending, hasPendingDeopt returns true"`,
  `"markForDeopt is idempotent (does not overwrite first mark)"`,
  `"consumeDeopt returns info and removes pending"`,
  `"invalidateDependents marks matching functions"`,
  `"invalidateDependents skips functions without optimizedCode"`.
- A speculation is not a fact: `tests/optimizing/passes/type-narrowing.test.ts` >
  `"keeps it when only a speculation says the value cannot be null"`,
  `"folds it away when the value is declared as one that cannot be null"`,
  `"keeps it when the value is declared as one that can be null"`.
- One table, every value kind: `tests/runtime/member-lookup.test.ts` >
  `"routes each prototype-backed value kind to its own prototype"`,
  `"answers a value kind's own members without consulting a prototype"`,
  `"declines the kinds its callers resolve themselves"`,
  `"declines a prototype member when no interpreter can supply prototypes"`,
  `"answers undefined rather than declining when a coroutine member cannot settle"`.
- The same answers once the reader leaves the interpreter:
  `tests/e2e/optimizing/member-lookup-tiers.test.ts` >
  `"reads an array's own length"`, `"reads a string method off the string prototype"`,
  `"reads a number method off the number prototype"`, `"reads next off a generator"`,
  `"answers undefined for a member no value kind provides"`.
- Differential testing refuses a comparison it cannot observe:
  `tests/e2e/optimizing/differential-guard.test.ts` >
  `"refuses a program whose last statement only prints"`,
  `"compares a program that answers with the value itself"`,
  `"still allows a print that is not the last statement"`.
- The running example itself agrees: `tests/e2e/docs/book-examples.test.ts` >
  `"stats.tera prints what the book says it prints"`,
  `"stats-deopt.tera prints what the book says it prints"`,
  `"covers every example file, so a new one cannot be added untested"`.
