# 58. Making the program static   ⟨ N ⟩

> **Status:** outline

**Thesis.** Closures become plain functions, higher-order calls become monomorphised
clones, and an `await` becomes a heap frame plus a state machine — after which a native
backend never needs an indirect call except one.

**What arrived.** From chapter 57: a `ClassTable` built once from checker types, with
`defineSynthetic` still open, and the knowledge that a synthetic class is indistinguishable
from a user class — it gets a layout, an id, a `tera_classes` row and precise collection for
free. This chapter is the biggest customer of that door.

> **A note on order.** Chapters 57 and 58 are told in the order that makes them readable,
> not the order they run. `buildClassTable` (`src/api/engine.ts`:1201) happens first;
> everything in *this* chapter is a **module-level** stage in
> `src/optimizing/drivers/aot.ts` (lines 689-830); chapter 57's `class-member-lowering`
> and `array-allocation-shapes` are **per-function** passes in
> `targetLegalizationPipeline`, and run *after* all of it. The class table is what lets the
> two halves be told apart.

**What leaves.** A module of ordinary functions. No `MakeClosure`, no `LoadContextSlot` /
`StoreContextSlot`, no `Await`, no `Yield`, no parameter that holds a function. Every call
is `CallKnownFunction` on a name, with exactly one exception: `tera_drain` reads a
`SCALAR_CODE` field off a queued frame and calls through it. Chapter 59 receives that
module and asks the one remaining question about it — where the *characters* live.

**New ideas.** *Free variable and capture*; *closure = code + environment*; *closure
conversion / lambda lifting*; *monomorphisation (cloning a function per callee)*; *a
coroutine as a state machine*; *live-in at a program point*; *spilling a value to memory*;
*rematerialization*; *a code pointer / indirect call*.

**Length.** 16 pages

## Anchors

- `src/optimizing/drivers/aot.ts:689-830` — the module pipeline, as named `stage(...)`
  calls in order: `uniquify-graph-names`, `name-callee-constants`, `module-captures`,
  `drop-function-bindings`, `error-surface`, `module-start`, `promote-run-once-globals`,
  `closure-conversion`, `promise-surface`, `argument-specialization`,
  `name-function-values`, `adopt-inferred-types`, then `requireDeclaredParameters`,
  `module-signatures`, `declare-global-variables`, and finally `splitGenerators` (473-539)
  and `splitCoroutines` (541-570).
- `src/optimizing/metadata/module-captures.ts` — 213 lines. `lowerModuleCaptures`
  (156-213), `creatorsIn` (35-44), `moduleVariableOf` (64-81) with its recursion through a
  chain of upvalues, `scopedVariable` (53-62) keying by `cellKey(moduleSpec, name)`,
  `rewrite` (83-117) which drops a store of `undefined` outright, `unwrapClosures`
  (121-146) and `CLOSURE_PROPS`.
- `src/optimizing/metadata/closure-conversion.ts` — 428 lines. `convertClosures` (423-426),
  class `Conversion` (311-421), `capturedOf` (153-188) — the fast-path decision,
  `closureFrameShape` (190-202) minting `tera_closure$<fn>`, `liftBody` (217-250) which
  prepends the parameter, `rewriteAgainstFrame` (252-273), `retireCreator` (275-297),
  `answersClosure` (299-309), `heldValuesOf` (132-151), `storedInSlot` (91-104),
  `CLOSURE_CAPTURE_PROP` / `carriesCapture` (48-52), `capturedFieldName` (44-46).
- `src/optimizing/passes/function-argument-specialization.ts` — 249 lines.
  `specializeFunctionArguments` (247), class `Specializer` (148-245),
  `calledParametersOf` (38-48) — the eligibility rule in six lines, `handoffAt` (162-172),
  `nameFor` (72-74) giving `owner$callee`, `bindCallees` (92-101),
  `withoutParameters` (120-135), `retypeCaptures` (105-118), `redirect` (137-142),
  `adoptWrittenTypes` (50-70), `Specialization { added, retired }`.
- `src/optimizing/passes/coroutines.ts` — 1,378 lines. `splitCoroutine` (905-912) →
  `splitInPlace` (914-968), `suspendPointsOf` (470-509), `severAfter` (332-348),
  class `FrameSpills` (587-674) with `spillInto`, `reloadUses`, `valueAt`,
  `dispatchStates` (850-874), `settleInPlace` (876-903), `suspendAt` (714-757),
  `settleAt` (815-848), `enqueue` (676-712), `localizeInto` (511-541),
  `localizeRuntimeBases` (543-549), `localizeConstantArrays` (562-568) with
  `rematerializable` (556-560), `withFreshNodeIds` (298), `CoroutineSplitError`,
  `buildDrain` (1270-1332) — the indirect call at 1322-1323, `buildSleep`, `buildWake`,
  `buildReportRejections`, `drainBeforeExit`, `lowerAwaitedPromises`.
- `src/optimizing/metadata/coroutines.ts` — 143 lines, the shape vocabulary.
  `CORO_FRAME_BASE = "tera_frame"`, `CORO_RESUME_TYPE = "(tera_frame) -> int"`,
  `CORO_PROMISE_BASE`, `CORO_TIMER_SHAPE`, the fourteen field-name constants and the state
  constants (26-33), `coroutineFrameName` → `<fn>$frame`, `coroutinePromiseName` →
  `<fn>$promise`, `coroutineResumeName` → `<fn>$resume`, `coroutineSlotName` → `slot<n>`,
  `coroutineParameterName` → `param<n>`, `syntheticSurface` (67-80),
  `coroutineBaseShapes` (82-107), `coroutineFrameShape` (132-143).
- `src/optimizing/passes/generators.ts` — 260 lines. `generatorYieldType` (118-143) with
  its two refusal sentences, `namedYield` (95-116), `joinedNames` (89-93),
  `yieldPointsOf` (145-158), `yieldAt` (160-172), `finishIn`/`finishAt` (174-196),
  `splitGenerator` (254-260) → `splitInPlace` (198-252). It **imports** `FrameSpills`,
  `dispatchStates`, `severAfter`, `localizeRuntimeBases`, `localizeConstantArrays` and
  `returnsOf` straight from `coroutines.ts`.
- `src/optimizing/metadata/generators.ts` — `GEN_STATE_FIELD`, `GEN_STATUS_FIELD`,
  `GEN_VALUE_FIELD = "yielded"`, `GEN_ENTRY_STATE`, `GEN_RUNNING`, `GEN_FINISHED`,
  `generatorFrameName`, `generatorResumeName`, `generatorFrameShape`.
- `src/optimizing/analyses/aot-legality.ts:359-368, 1459-1490` — `CODE_TARGET_PROP`,
  `codeSymbolOf`, `callThroughArguments`, `checkCallThrough` and `codeSignatureOf`: the
  rules the one surviving code pointer has to obey.
- `src/optimizing/backends/c/emit.ts:2235-2255` — `emitCodeAddress` and `emitCallThrough`,
  which produce `(tera_fn)mean_of_resume` and
  `((int32_t (*)(unsigned char *))v16)(v10)`.

## Worked example

Two halves of `docs/example/`, and one program the running example cannot reach.

**Closure conversion — `docs/example/stats-closure.tera`.** `scaler(factor)` returns an
inner `scale(x)` that reads `factor`. `factor` is captured once and never written, so the
frame is skipped entirely and the value is passed directly:

```
$ node dist/cli.js compile docs/example/stats-closure.tera --emit source --target c -o /tmp/closure-c
$ sed -n '1223,1230p' /tmp/closure-c/stats-closure.c
double scaler(double p0) {
  return (double)p0;
}

double scale(double p0, double p1) {
  const double v0 = (double)p1 * (double)p0;
  return (double)v0;
}
```

`scale` gained a parameter at the front — the capture. `scaler` collapsed to `return
factor`, because the closure *value* now **is** the captured value.

**Monomorphisation.** `stats-closure.tera` cannot show this: its second half calls
`values.map(double)`, and no backend implements `map` (see § honesty-items). The same shape
written with an explicit taker does compile, and is chapter 58's monomorphisation listing:

```
fn apply(f: (float) -> float, x: float) -> float:
  return f(x)
fn double(x: float) -> float:
  return x * 2.0
fn scaled(v: float) -> float:
  return apply(double, v)
print(scaled(15.7).to_fixed(2))
```

prints `31.40` under the interpreter, and produces `double apply_double(double p0)` in C —
`apply$double`, with the function parameter **deleted**, not passed and ignored.

**Coroutine splitting — `docs/example/stats-async.tera`.** Three async functions, and the
compiler treats them differently, which is the point:

```
$ node dist/cli.js compile docs/example/stats-async.tera --emit source --target c -o /tmp/async-c
$ grep -n 'load\|_resume' /tmp/async-c/stats-async.h
16:unsigned char * load(const tera_char *p0);
```

`load` contains **no** `await`, so `settleInPlace` leaves it one function that allocates its
promise, resolves it and returns it — no frame, no resume, no state machine.
`mean_of` and `main` each hold an `await`, so each is split into a
`<fn>$frame` class and a `static int32_t <fn>_resume(unsigned char *p0)`.

## Outline

- [ ] **§ four-things-a-native-target-cannot-do** — Open by naming the debts, so the
      chapter's four sections are visibly the four payments. A native backend has: no
      environment object it can create at will, no way to call a value, no way to suspend a
      C-level stack frame, and no interpreter to hand the hard case back to. Each is a
      language feature tera has anyway. State the shape of every answer in one line:
      **each is turned into something the class table and a direct call can already
      express.**
- [ ] **§ a-top-level-variable-is-not-a-capture** — `lowerModuleCaptures`, the cheapest
      win, run first (aot.ts:691). **`> **New idea.** Free variable and capture** — a name
      a function uses but does not declare. Establish the observation the pass rests on: a
      module's top level is a *scope*, and a function that captures a top-level variable is
      not really closing over anything — there is exactly one of it, for the whole program's
      life. So the read becomes `LoadGlobal` and the write `StoreGlobal`, keyed by
      `cellKey(moduleSpec, name)` so an imported module's `total` cannot collide with the
      entry's.
      `moduleVariableOf` (64-81) recurses through an upvalue chain, so a function nested
      three deep still resolves to the module scope. `scopes` is computed as "every compiled
      function nothing creates" plus the entry (167-172) — a definition worth reading
      carefully, because it is what distinguishes a module from a maker.
      Then the payoff: once **every** upvalue of a nested function has become a global, the
      `MakeClosure` itself is pointless, and `unwrapClosures` (121-146) replaces it with a
      plain constant. Note the small correctness detail that `rewrite` deletes a store of
      `undefined` rather than spelling it (95-99): the bytecode emits one to declare a slot,
      and a global does not need declaring.
      `[t: tests/optimizing/metadata/module-captures.test.ts > "turns the entry's own context slot into a bare global"]`
      `[t: tests/optimizing/metadata/module-captures.test.ts > "keys the imported variable by its module so it cannot collide with the entry's"]`
      `[t: tests/optimizing/metadata/module-captures.test.ts > "drops a write of undefined rather than spelling it as a global store"]`
      `[t: tests/optimizing/metadata/module-captures.test.ts > "names a capture of an imported module's variable by that module"]`
      `[t: tests/optimizing/metadata/module-captures.test.ts > "leaves a capture of something that is not a module scope alone"]`
- [ ] **§ what-a-closure-actually-is** — The primer, at the point of need.
      **`> **New idea.** A closure is code plus an environment**, and the interpreter's
      version of the environment is a context: `LoadContextSlot(source, slot)` /
      `StoreContextSlot`, with `source` either `"local"` (the maker's own slot) or
      `"upvalue"` (a slot the closure inherited). Show one before/after pair of IR.
      Establish what the native compiler needs instead: the environment must become **an
      argument**, because an argument is something a direct call can carry.
      **`> **New idea.** Closure conversion / lambda lifting.**
- [ ] **§ the-fast-path-nobody-explains** — `capturedOf` (153-188) makes one decision, and
      the condition is worth quoting in full:

      ```ts
      if (!mutates && held.length === SINGLE_CAPTURE) {
        const only = held[CAPTURE_SLOT]!;
        return { unit, creator, held, captured: only.value,
                 capturedType: only.declaredType, frame: null };
      }
      ```

      — src/optimizing/metadata/closure-conversion.ts:172-182

      **One capture, never written → there is no environment, only a value.** The closure
      value *is* that value, so `MakeClosure` is replaced by the captured value itself
      (`retireCreator`, 275-297), the body takes it as a prepended parameter, and
      `answersClosure` (299-309) retypes the maker's return to the captured type. That is
      exactly what `stats-closure.tera` prints, and it is why `scaler` compiles to `return
      p0`.
      Establish why the condition has two clauses, not one: a *written* capture is shared
      mutable state between the maker and the closure, and a copied value cannot be shared.
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "takes what it captured as its own first parameter"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "hands the captured value over without building a frame for it"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "leaves an unwritten lone capture unboxed"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "leaves no context slot for a backend to refuse"]`
- [ ] **§ otherwise-a-frame-class** — The general case: `closureFrameShape` mints
      `tera_closure$<fn>` through `defineSynthetic` — chapter 57's door, used for the first
      time — with one field `captured<slot>` per captured slot, typed by what the maker
      actually stored (`heldValuesOf` → `storedInSlot`, which refuses if two different
      values reach one slot). `buildFrame` allocates it in the **maker's entry block**, so
      it exists before the closure does. Then `rewriteAgainstFrame` (252-273) rewrites
      *both* sides against that one allocation: the closure's `upvalue` slots become
      `LoadField`/`StoreField` on its new parameter, and the maker's own `local` slots
      become `LoadField`/`StoreField` on the allocation. **That is what makes a written
      capture shared** — both ends now name the same heap field.
      Establish the layout consequence, which is chapter 57 paying off immediately: a
      closure frame is a class, so the collector already traces it, and a captured object is
      a `SCALAR_POINTER` field with a `tera_classes` row entry.
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "takes one frame carrying every value it captured"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "names one field of that frame for every slot the closure reads"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "builds the frame in the maker and stores every captured value into it"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "reads each captured value back off the frame inside the closure"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "boxes a lone capture into a frame instead of handing over its value"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "writes the capture back into that frame"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "reads the maker's own view of the capture back off the frame"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "carries the values in the order the slots were captured, not merged into one"]`
- [ ] **§ what-closure-conversion-refuses** — Brief, and the refusals are all *silent* ones
      — `capturedOf` returns `null` and the closure is simply left alone for a later stage
      to reject. Four ways to fall out: the closure has locals of its own in a context
      (160), an upvalue that is not a `local` of the creator (141), a slot no held value
      covers (169-171), and a captured value whose type cannot be named (147). Establish the
      design difference from chapter 56: this pass **declines**, it does not **refuse** —
      it produces no sentence at all, and the eventual message comes from legality, naming
      the leftover `LoadContextSlot`. That is the recurring "downstream symptom, not cause"
      pattern `docs/CONVENTIONS.md` rule 5 exists for.
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "leaves a closure whose captured value it cannot name"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "types the frame off the real store, not the empty declaration before it"]`
      `[t: tests/optimizing/metadata/closure-conversion.test.ts > "finds the captured value when the maker's slot is not the upvalue index"]`
- [ ] **§ a-parameter-that-is-only-ever-called** — Monomorphisation, and its eligibility
      test is six lines (`calledParametersOf`, 38-48): a parameter whose uses are **all**
      `GenericCall` with the parameter as input 0. Not "a parameter of function type" —
      **a parameter nothing does with except call**. Establish why the stricter rule is the
      right one: a function value that is stored, compared or returned would still need a
      representation; one that is only called never has to exist.
      Then the algorithm: collect every call site of the taker; for each, resolve every such
      argument to a named function (`handoffAt`, 162-172); if *any* site fails, **abandon
      the whole function** (line 204 — `return`, not `continue`, which is a real design
      decision worth naming); clone the taker once per distinct combination as
      `nameFor` = `owner$callee$callee…`; rewrite the calls inside the clone to direct calls
      (`bindCallees`); delete the parameter (`withoutParameters`); redirect the sites.
      **`> **New idea.** Monomorphisation.**
      `[t: tests/optimizing/passes/function-argument-specialization.test.ts > "clones the taker once for the function it was handed"]`
      `[t: tests/optimizing/passes/function-argument-specialization.test.ts > "calls the handed function by name inside the clone"]`
      `[t: tests/optimizing/passes/function-argument-specialization.test.ts > "drops the parameter the function arrived in, since the name says it all"]`
      `[t: tests/e2e/optimizing/aot/higher-order.test.ts > "keeps two callbacks apart at two call sites"]`
      `[t: tests/e2e/optimizing/aot/higher-order.test.ts > "shares one copy when the same callback is handed over twice"]`
      `[t: tests/e2e/optimizing/aot/higher-order.test.ts > "takes a named function as a value"]`
- [ ] **§ when-the-callback-is-a-closure** — The interaction between the previous two
      sections, and the reason `dropped` is computed the way it is (223-227). If the handed
      function is a *closure* (`carriesCapture`, stamped by `Conversion.markClosureValues`),
      the parameter is **kept** — because it is no longer a function, it is the closure's
      frame or captured value, and the clone still needs it. `retypeCaptures` (105-118) then
      retypes it as the callee's first parameter type, and `bindCallees` passes it through
      as argument zero rather than dropping it (line 97). A parameter is dropped only when
      **every** site handed it a plain function.
      Establish the general rule: monomorphisation removes the *code* half of a closure and
      leaves the *environment* half, which is exactly the split § what-a-closure-actually-is
      set up.
      `[t: tests/optimizing/passes/function-argument-specialization.test.ts > "clones the taker for the closure the caller built"]`
      `[t: tests/optimizing/passes/function-argument-specialization.test.ts > "keeps the parameter, because the frame it carries is still needed"]`
      `[t: tests/optimizing/passes/function-argument-specialization.test.ts > "retypes that parameter as the frame the closure body reads"]`
      `[t: tests/optimizing/passes/function-argument-specialization.test.ts > "hands the frame over as the first argument of the closure body"]`
      `[t: tests/e2e/optimizing/aot/higher-order.test.ts > "gives an untyped callback the types of the parameter it fills"]`
      `[t: tests/e2e/optimizing/aot/higher-order.test.ts > "declines a callback the compiler cannot pin down"]`
- [ ] **§ what-a-suspend-costs** — Set up coroutine splitting by naming the problem
      precisely. An `await` in the middle of a function means: stop here, let other code
      run, and later continue *at this point, with these values*. The interpreter has a
      frame object it can park ([Ch 30]). A native binary has a C stack
      it does not control. **`> **New idea.** A coroutine as a state machine** — a function
      cut at its suspend points, its locals moved to the heap, re-entered at the top with a
      state number saying where to go.
      Establish the shape of the answer before the mechanism, as three objects from
      `metadata/coroutines.ts`: a **frame** (`<fn>$frame`, extends `tera_frame`: the resume
      routine, a state, a queue link, the result promise, then one field per spilled value),
      a **promise** (`<fn>$promise`, extends `tera_promise`: state, waiting flag, waiter,
      unreported flag, rejected link, error, and a `value` field typed by the return), and a
      **resume function** (`<fn>$resume`, signature `(tera_frame) -> int`).
      `[t: tests/optimizing/metadata/coroutines.test.ts > "gives every frame the same header so the queue can walk any of them"]`
      `[t: tests/optimizing/metadata/coroutines.test.ts > "traces the queue link and the promise a frame is holding"]`
      `[t: tests/optimizing/metadata/coroutines.test.ts > "lays every synthetic shape out after the object header"]`
      `[t: tests/optimizing/metadata/coroutines.test.ts > "gives each synthetic shape a distinct id the class table can emit"]`
- [ ] **§ no-await-no-machine** — The case the running example makes visible, and it is
      worth its own section because it is the common one. `splitInPlace` (914-921) asks
      `suspendPointsOf` first, and on an empty answer calls `settleInPlace` (876-903): the
      function keeps its body, allocates its promise in the entry block, and every `return`
      becomes "store into the promise, mark it resolved (or rejected), return the promise".
      No frame, no resume, no state field, and `CoroutineSplit.resume` is `null`.
      That is `load` in `stats-async.tera`: `unsigned char *load(const tera_char *p0)`.
      Establish the rule: **`async` alone costs a promise; `await` costs a state machine.**
- [ ] **§ cutting-the-blocks** — `suspendPointsOf` (470-509) walks blocks; `severAfter`
      (332-348) splits a block immediately after the `Await`, and the tail becomes the
      *resume block* for state *n*. The `Await` node itself is unlinked; the value it
      produced is replaced by a `LoadField` of the awaited promise's `value`
      (`deliverSettled`), and two guards are inserted into the resume block:
      `raiseWhenRejected` (416) and `stopWhenPending` (444).
      Note the one refusal this stage writes, verbatim:

      > `<fn> awaits a promise the compiler cannot trace back to the function that settles
      > it; await the call directly, or keep this part interpreted`

      Establish that `promiseOf` is a whole-module answer — awaiting is only compilable
      when the compiler can name which `<fn>$promise` shape the awaited value has, which is
      why the message asks for a direct `await call()`.
      Mermaid diagram: one function with two awaits, before and after cutting.
- [ ] **§ deciding-what-the-frame-must-hold** — `FrameSpills` (587-674), the analysis at the
      centre. **`> **New idea.** Live-in at a program point** — the set of values defined
      before a point and still used after it. Every parameter gets a slot unconditionally
      (`param<n>`); then `computeValueLiveness(graph)` is asked for `liveIn(point.resume)`
      at **every** resume block, the union is the carried set, and each carried value that
      is not a constant gets `slot<n>`. **`> **New idea.** Spilling.**
      Establish the two things that make this a real analysis rather than "save everything":
      a value consumed before the suspend never appears, and a constant is never spilled
      because it can be rebuilt.
      Then naming the slot's type, which is where it can fail:
      `slotTypeOf` → `loadedElementType` → `heldTypeNameOf`, and if all three answer
      nothing:

      > `<fn> keeps a <kind> value across a suspend, and the compiler has no frame slot for
      > that type; annotate it, or keep this part interpreted`

      `[t: tests/optimizing/passes/coroutines.test.ts > "gives a frame slot to the values that outlive a suspend and to nothing else"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "leaves a value consumed before the suspend out of the frame"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "gives the array a frame slot rather than refusing to split"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "names that slot by the shape the array has, not by a number"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "names a slot holding an array of text the same way"]`
- [ ] **§ two-passes-that-shrink-the-frame** — *Why the obvious design fails*, in miniature.
      The obvious frame is "every live value". Two rewrites run **before** `FrameSpills`
      (922-923) specifically to make the live set smaller, and both are the same function
      with a different predicate (`localizeInto`, 511-541). **`> **New idea.**
      Rematerialization — recomputing a value where it is used instead of keeping it
      alive.**
      `localizeRuntimeBases` copies an `IR_RUNTIME_BASE` into every block that uses it, so
      the address of a runtime table is never a frame field.
      `localizeConstantArrays` copies an all-constant `NewArray` into each reading block —
      but only when `rematerializable` (556-560) proves every use is a read: an array a
      later block *writes*, or hands to a call, has identity and must not be duplicated.
      Establish the trade honestly: a frame field costs memory and a store/load per suspend;
      a rematerialized value costs the recompute. Nothing in this tree measures which wins;
      the rule chosen is "duplicate only what has no identity".
      `[t: tests/optimizing/passes/coroutines.test.ts > "copies the array into the block that only reads an element of it"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "copies it into a block that only asks how long it is"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "leaves an array a later block writes into where it was built"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "leaves an array handed to a call where it was built, since the call may keep it"]`
- [ ] **§ spill-store-reload** — `spillInto` (633-642) and `reloadUses` (649-673) as the
      SSA-preserving rewrite. A store goes immediately after each value's definition
      (`definitionEnd`, with the phi case handled separately); then **every use in another
      block** is redirected to a `LoadField` inserted at the top of the *using* block —
      or, for a phi input, at the top of the corresponding **predecessor** (line 655), which
      is the standard trap and is handled. Reloads are memoized per `name@block`.
      Establish the invariant: after this, no value crosses a block boundary except through
      the frame, which is exactly what makes re-entering at the dispatch head legal.
      `[t: tests/optimizing/passes/coroutines.test.ts > "leaves the lowered graph in SSA form"]`
- [ ] **§ the-state-dispatch-chain** — `dispatchStates` (850-874): a new head block loads
      `state` off the frame and tests it against `0, 1, 2, …` in a chain, jumping to the
      body for 0 and to `points[n-1].resume` otherwise, with the **last target
      unconditional** — the same "the cone is exhaustive so the final else needs no test"
      move as chapter 57's dispatch ladder ([Ch 57 § the-dispatch-ladder]). The head is then
      moved to the front with `takeBlocks`.
      Then what the original function becomes (948-965), which is the whole transformation
      in seventeen lines: empty its blocks; allocate the promise and the frame; store the
      result promise, the resume routine as a **code constant**, and the entry state; store
      every parameter into `param<n>`; call `<fn>$resume(frame)` once; return the promise.
      `[t: tests/optimizing/passes/coroutines.test.ts > "resumes at one label per suspend and keeps the entry state"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "hands the collector a frame whose references are all set before the next allocation"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "re-points the queue link at every frame it enqueues"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "copies a string result into the promise instead of pointing at the buffer"]`
      `[t: tests/optimizing/passes/coroutines.test.ts > "copies a thrown value into the promise and marks it rejected"]`
- [ ] **§ generators-are-the-simpler-sibling** — `passes/generators.ts` imports
      `FrameSpills`, `dispatchStates`, `severAfter`, `localizeRuntimeBases`,
      `localizeConstantArrays` and `returnsOf` **from `coroutines.ts`** — the reuse is the
      section's evidence, and worth stating as a claim: a generator is a coroutine with no
      promise, no queue and no rejection path. The frame is three fields plus slots
      (`state`, `status`, `yielded`), a yield stores the value and the next state and
      returns `GEN_RUNNING`, a return stores the terminal state and returns `GEN_FINISHED`,
      and the machine has one extra state (`done = points.length + 1`) so a finished
      generator keeps answering finished.
      Then the part that has no coroutine counterpart: `generatorYieldType` (118-143), which
      must name **one** type for the whole generator because the frame has one `yielded`
      field. `namedYield` walks arithmetic (`+ - *` join, `/` is always float), reads a
      field's declared type, and falls back to `heldTypeNameOf`. Two refusals, verbatim:

      > `<fn> yields a value the compiler has no generator slot for; annotate what it
      > yields, or keep this part interpreted`
      >
      > `<fn> yields both <a> and <b>, and a compiled generator yields one type; yield one
      > type, or keep this part interpreted`

      Note the design smell honestly: `joinedNames` widens `int`+`float` to `float` and
      joins nothing else — no lattice, a two-line special case.
      `[t: tests/optimizing/passes/generators.test.ts > "names a generator yielding whole numbers"]`
      `[t: tests/optimizing/passes/generators.test.ts > "widens a generator yielding whole and fractional numbers to the wider one"]`
      `[t: tests/optimizing/passes/generators.test.ts > "names a generator that yields whole arrays by the shape those arrays have"]`
      `[t: tests/optimizing/passes/generators.test.ts > "names a generator that yields nothing at all"]`
      `[t: tests/optimizing/passes/generators.test.ts > "refuses one that yields both a number and text"]`
      `[t: tests/optimizing/passes/generators.test.ts > "names both types it could not join in the reason it gives"]`
      `[t: tests/optimizing/passes/generators.test.ts > "widens a sum of a whole and a fractional number"]`
      `[t: tests/optimizing/passes/generators.test.ts > "refuses a sum the compiler cannot read as a number"]`
- [ ] **§ the-one-code-pointer** — Close by counting. Everything above removed an indirect
      call: module captures removed the closure object, closure conversion removed the
      environment, monomorphisation removed the callee argument, coroutine splitting turned
      a suspend into a direct call to a named `$resume`. Exactly one indirect call is left,
      and it is *required*: `buildDrain` (1270-1332) pops a frame off the runtime queue and
      does not know which coroutine it belongs to.

      ```ts
      const routine = step.load(head, base, CORO_ROUTINE_FIELD);
      const resumed = irGenericCall(routine, [head]);
      ```

      — src/optimizing/passes/coroutines.ts:1322-1323

      Establish what makes it legal: `CORO_ROUTINE_FIELD` is declared
      `(tera_frame) -> int`, so `fieldScalarOf` gives it `SCALAR_CODE` — a pointer-sized
      **non-reference** scalar the collector skips ([Ch 61 § roots-and-safepoints]) — and
      `checkCallThrough` (aot-legality.ts:1459) verifies the arity and both scalars against
      that declared signature before letting it through. **`> **New idea.** A code pointer,
      and why one is enough**: a scheduler is the one place a program genuinely does not
      know what it is calling. Show the C:

      ```c
      tera_fn v0 = (tera_fn)mean_of_resume;
      ...
      ((int32_t (*)(unsigned char *))v16)(v10);
      ```

      — /tmp/async-c/stats-async.c, the address in `mean_of` and the call in `tera_drain`

      Hand over to chapter 59: the module is now ordinary functions and ordinary structs,
      and exactly one question is left about it.

## Honesty items

- `> **Unfinished.**` — `values.map(f)` does not compile on any backend, which is why
  `docs/example/stats-closure.tera` cannot be this chapter's monomorphisation example even
  though `docs/example/README.md` lists it as one. Measured:

  ```
  $ node dist/cli.js compile docs/example/stats-closure.tera --emit source --target c -o /tmp/closure-c
  tera compile: note: 'tera_program' is not in the binary, and nothing the program runs
    calls it (C backend cannot emit: unsupported property map)
  ```

  Its `scaler`/`scale` half *does* compile, and is § the-fast-path-nobody-explains'
  listing. Cost: `map` would have to lower to an allocate-and-loop in
  `src/optimizing/passes/array-methods.ts` the way `push` does, over a monomorphised
  callee — the specialization machinery already exists, the array-method lowering does not.
- `> **Unfinished.**` — closure conversion **declines silently**. `capturedOf` has four
  `return null` paths (`closure-conversion.ts`:141, 147, 160, 169-171) and none of them
  writes a sentence; the user sees whatever `analyzeAotLegality` says about the surviving
  `LoadContextSlot`. This is the pattern chapter 56 § the-cascade names as the worst thing
  about the diagnostics. Cost: a `DeclineReason` returned alongside `null` and threaded to
  the skipped-function list — mechanical, four sites, but it must not become a *refusal*,
  since the closure may still be compiled another way.
- `> **Unfinished.**` — `specializeFunctionArguments` abandons a whole function when *any*
  one call site hands it something it cannot resolve
  (`function-argument-specialization.ts`:204). A program with nine monomorphisable sites and
  one dynamic one gets zero clones. Cost: specializing the resolvable sites and leaving a
  generic copy for the rest, which needs the generic copy to be compilable — it is not,
  because a callable parameter is exactly what the backends refuse. So this is honestly
  blocked, not merely unfinished.
- `> **Unenforced.**` — `nameFor` (`function-argument-specialization.ts`:72-74) builds
  `owner$callee$callee…` by string join, with no collision check. Two different combinations
  that produce the same string would silently share one clone, because `clones` is keyed by
  that string. `uniquify-graph-names` (aot.ts:689) runs *before* specialization, not after.
  Cost: a `Map` from the handoff tuple to a name, rather than a name derived from it.
- `> **Unfinished.**` — `joinedNames` in `passes/generators.ts` (89-93) is a two-case
  special: identical names join, `int`/`float` widen to `float`, everything else refuses.
  Meanwhile `src/optimizing/types/lattice.ts` has a real `joinTypes` and `class-table.ts`
  has `joinedTypeName` over declared names. A generator yielding two record shapes that
  `joinedLiteralShape` could merge is refused. Cost: replacing the two cases with
  `joinedTypeName(classes, [...])`, plus a decision about what a `null`-admitting yield
  means for the `yielded` field's scalar.
- `> **Unenforced.**` — the code-pointer contract. `CORO_RESUME_TYPE` is the string
  `"(tera_frame) -> int"`, and `<fn>$resume`'s `declaredSignature` is built independently as
  `{ params: [frame.name], returns: DECLARED_INT }` (`coroutines.ts`:933,
  `generators.ts`:216). They agree by inspection. `checkCallThrough` compares the *call
  site* against the field's declared type, and nothing compares the field's declared type
  against the resume function actually stored there. Cost: `coroutineFrameShape` could take
  the resume signature and assert, roughly five lines.

## Verify it yourself

```bash
node dist/cli.js docs/example/stats-closure.tera
node dist/cli.js compile docs/example/stats-closure.tera --emit source --target c -o /tmp/closure-c
sed -n '1223,1230p' /tmp/closure-c/stats-closure.c
printf 'fn apply(f: (float) -> float, x: float) -> float:\n  return f(x)\n\nfn double(x: float) -> float:\n  return x * 2.0\n\nfn scaled(v: float) -> float:\n  return apply(double, v)\n\nprint(scaled(15.7).to_fixed(2))\n' > /tmp/mono.tera
node dist/cli.js /tmp/mono.tera
node dist/cli.js compile /tmp/mono.tera --emit source --target c -o /tmp/mono-c && grep -n 'apply_double' /tmp/mono-c/mono.h
node dist/cli.js docs/example/stats-async.tera
node dist/cli.js compile docs/example/stats-async.tera --emit source --target c -o /tmp/async-c
grep -n 'load\|_resume\|(\*)(unsigned char \*)' /tmp/async-c/stats-async.h /tmp/async-c/stats-async.c
npx vitest run --project unit tests/optimizing/metadata/closure-conversion.test.ts tests/optimizing/metadata/module-captures.test.ts tests/optimizing/passes/function-argument-specialization.test.ts tests/optimizing/passes/coroutines.test.ts tests/optimizing/passes/generators.test.ts
```

## Tests that pin this

- `tests/optimizing/metadata/module-captures.test.ts` > `"turns the entry's own context slot into a bare global"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"drops a write of undefined rather than spelling it as a global store"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"answers nothing when no unit carries the entry's name"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"lowers the imported module's own top-level variable too"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"keys the imported variable by its module so it cannot collide with the entry's"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"names an entry-level capture as the bare global it lowered to"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"names a capture of an imported module's variable by that module"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"leaves a capture of something that is not a module scope alone"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"carries the declared type of the entry's own slot onto the global store"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"carries it onto a store from a function that captured the variable"`
- `tests/optimizing/metadata/module-captures.test.ts` > `"leaves the store bare when the variable was written with no type"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"takes what it captured as its own first parameter"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"leaves no context slot for a backend to refuse"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"hands the captured value over without building a frame for it"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"takes one frame carrying every value it captured"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"names one field of that frame for every slot the closure reads"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"builds the frame in the maker and stores every captured value into it"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"reads each captured value back off the frame inside the closure"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"carries the values in the order the slots were captured, not merged into one"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"gives the maker its own frame type as what it answers"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"keeps a frame with three captures just as wide"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"boxes a lone capture into a frame instead of handing over its value"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"writes the capture back into that frame"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"stores the initial value where the maker stored it, not into the allocation"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"reads the maker's own view of the capture back off the frame"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"leaves an unwritten lone capture unboxed"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"finds the captured value when the maker's slot is not the upvalue index"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"types the frame off the real store, not the empty declaration before it"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"hands over a maker-local capture nothing writes without a frame"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"leaves a closure whose captured value it cannot name"`
- `tests/optimizing/metadata/closure-conversion.test.ts` > `"leaves everything alone when the module carries no class table"`
- `tests/optimizing/passes/function-argument-specialization.test.ts` > `"clones the taker once for the function it was handed"`
- `tests/optimizing/passes/function-argument-specialization.test.ts` > `"calls the handed function by name inside the clone"`
- `tests/optimizing/passes/function-argument-specialization.test.ts` > `"drops the parameter the function arrived in, since the name says it all"`
- `tests/optimizing/passes/function-argument-specialization.test.ts` > `"clones the taker for the closure the caller built"`
- `tests/optimizing/passes/function-argument-specialization.test.ts` > `"calls the closure body by name inside the clone"`
- `tests/optimizing/passes/function-argument-specialization.test.ts` > `"keeps the parameter, because the frame it carries is still needed"`
- `tests/optimizing/passes/function-argument-specialization.test.ts` > `"retypes that parameter as the frame the closure body reads"`
- `tests/optimizing/passes/function-argument-specialization.test.ts` > `"hands the frame over as the first argument of the closure body"`
- `tests/optimizing/passes/coroutines.test.ts` > `"hands the collector a frame whose references are all set before the next allocation"`
- `tests/optimizing/passes/coroutines.test.ts` > `"gives a frame slot to the values that outlive a suspend and to nothing else"`
- `tests/optimizing/passes/coroutines.test.ts` > `"leaves a value consumed before the suspend out of the frame"`
- `tests/optimizing/passes/coroutines.test.ts` > `"re-points the queue link at every frame it enqueues"`
- `tests/optimizing/passes/coroutines.test.ts` > `"copies a string result into the promise instead of pointing at the buffer"`
- `tests/optimizing/passes/coroutines.test.ts` > `"copies a thrown value into the promise and marks it rejected"`
- `tests/optimizing/passes/coroutines.test.ts` > `"carries the raised error itself when the module declares what it throws"`
- `tests/optimizing/passes/coroutines.test.ts` > `"carries no error value when the module declares nothing it throws"`
- `tests/optimizing/passes/coroutines.test.ts` > `"reports a rejection by the text the raised error names itself with"`
- `tests/optimizing/passes/coroutines.test.ts` > `"resumes at one label per suspend and keeps the entry state"`
- `tests/optimizing/passes/coroutines.test.ts` > `"stops instead of reading the value of a promise that is still pending"`
- `tests/optimizing/passes/coroutines.test.ts` > `"leaves the lowered graph in SSA form"`
- `tests/optimizing/passes/coroutines.test.ts` > `"copies the array into the block that only reads an element of it"`
- `tests/optimizing/passes/coroutines.test.ts` > `"copies it into a block that only asks how long it is"`
- `tests/optimizing/passes/coroutines.test.ts` > `"leaves an array a later block writes into where it was built"`
- `tests/optimizing/passes/coroutines.test.ts` > `"leaves an array handed to a call where it was built, since the call may keep it"`
- `tests/optimizing/passes/coroutines.test.ts` > `"gives the array a frame slot rather than refusing to split"`
- `tests/optimizing/passes/coroutines.test.ts` > `"names that slot by the shape the array has, not by a number"`
- `tests/optimizing/passes/coroutines.test.ts` > `"names a slot holding an array of text the same way"`
- `tests/optimizing/metadata/coroutines.test.ts` > `"gives every frame the same header so the queue can walk any of them"`
- `tests/optimizing/metadata/coroutines.test.ts` > `"traces the queue link and the promise a frame is holding"`
- `tests/optimizing/metadata/coroutines.test.ts` > `"traces the parked waiter and the rejected link but not a scalar result"`
- `tests/optimizing/metadata/coroutines.test.ts` > `"keeps a rejection the collector can still reach on the unreported list"`
- `tests/optimizing/metadata/coroutines.test.ts` > `"gives a string result storage of its own that the collector never follows"`
- `tests/optimizing/metadata/coroutines.test.ts` > `"reaches a parked frame through the promise it is waiting on"`
- `tests/optimizing/metadata/coroutines.test.ts` > `"lays every synthetic shape out after the object header"`
- `tests/optimizing/metadata/coroutines.test.ts` > `"gives each synthetic shape a distinct id the class table can emit"`
- `tests/optimizing/passes/generators.test.ts` > `"names a generator yielding whole numbers"`
- `tests/optimizing/passes/generators.test.ts` > `"widens a generator yielding whole and fractional numbers to the wider one"`
- `tests/optimizing/passes/generators.test.ts` > `"names a generator yielding text"`
- `tests/optimizing/passes/generators.test.ts` > `"names a generator that yields whole arrays by the shape those arrays have"`
- `tests/optimizing/passes/generators.test.ts` > `"names a generator that yields nothing at all"`
- `tests/optimizing/passes/generators.test.ts` > `"refuses one that yields both a number and text"`
- `tests/optimizing/passes/generators.test.ts` > `"refuses one that yields both an array and a number"`
- `tests/optimizing/passes/generators.test.ts` > `"names both types it could not join in the reason it gives"`
- `tests/optimizing/passes/generators.test.ts` > `"refuses one that yields arrays holding different things"`
- `tests/optimizing/passes/generators.test.ts` > `"widens a sum of a whole and a fractional number"`
- `tests/optimizing/passes/generators.test.ts` > `"refuses a sum the compiler cannot read as a number"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"calls the callback it was handed"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"keeps two callbacks apart at two call sites"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"shares one copy when the same callback is handed over twice"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"takes a named function as a value"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"gives an untyped callback the types of the parameter it fills"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"declines a callback the compiler cannot pin down"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"refuses a callback used at two different written types"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"answers a different function from each branch"`
- `tests/e2e/optimizing/aot/higher-order.test.ts` > `"keeps answering the closure a call built"`
- `tests/e2e/optimizing/aot/closures.test.ts` > `"calls a closure the maker returned"`
- `tests/e2e/optimizing/aot/closures.test.ts` > `"keeps two closures from one maker apart"`
- `tests/e2e/optimizing/aot/closures.test.ts` > `"captures a float the same way"`
- `tests/e2e/optimizing/aot/closures.test.ts` > `"calls a closure inside the function that made it"`
- `tests/e2e/optimizing/aot/parameter-specialization.test.ts` > `"leaves a function that is also handed to another function alone"`
- `buildDrain`'s indirect call — **[unpinned]**. No unit test asserts that
  `tera_drain` calls through `CORO_ROUTINE_FIELD`; it is covered only by the async e2e
  suites agreeing with the interpreter.
