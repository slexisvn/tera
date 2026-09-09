# Appendix D — Inventory: dead, broken, unfinished, measured worse, never runs

> **Status:** current for the written chapters — 01–03, 08–50 — as of 2026-09-08. This
> appendix is assembled by hand from the honesty callouts every chapter raises. It must never
> contain an item no chapter raised, and no chapter may raise an item that is missing here.
> Chapters 04–07 and 51–83 are still outlines; their markers arrive here as they are written,
> and the § Carried-from-the-subsystem-survey list below is what is owed from them.

This is the book's best credential. A book that only describes what works is describing
something other than the software.

## The five markers

| Marker | Means |
| --- | --- |
| `> **Dead.**` | Present in the tree, unreachable |
| `> **Never runs.**` | Reachable, but nothing calls it |
| `> **Broken.**` | Present, and produces a wrong answer |
| `> **Measured worse.**` | Complete, correct, tested, and switched off because the numbers said so |
| `> **Unfinished.**` | Present, incomplete |

A sixth, `> **Unenforced.**`, marks an invariant the book states that nothing in the code
checks. Those belong here too — an unenforced invariant is a bug that has not happened yet.

Each entry must name a file and a symbol, and say what finishing it would cost.

## Confirmed while building this scaffold

These were verified directly and are already anchored to chapters.

> **Unfinished.** riscv64 cannot encode instructions. Its machine-code target throws
> `UnsupportedInstructionError` for every opcode —
> `src/optimizing/backends/riscv64/mc/target.ts:24` — so riscv64 reaches a binary only
> through the C backend. Cost to finish: a full RV64 encoder. Raised by [Ch 72].

> **Unfinished.** There is no Mach-O container. `CONTAINERS.macho` is `null` in
> `src/optimizing/backends/x64/backend.ts:57`, so macOS is not a target even though x64 is.
> Cost to finish: a Mach-O object and executable writer beside the existing ELF and PE
> ones. Raised by [Ch 70], [Ch 72].

> **Unfinished.** The same source, the same architecture, two different answers about
> timers. `x64Target` only claims the `timers` capability when its `PlatformIo` supplies
> both `now` and `wait` — `src/optimizing/backends/x64/target.ts:81-83`. `sysvIo`
> (`src/optimizing/backends/x64/runtime.ts:490`) supplies `write` and `exit` and neither of
> those two, so **`x64-linux` has no timers while `x64-windows` does**: `await sleep(1)`
> compiles on Windows and is refused on Linux from identical source. Cost to finish: two
> syscalls (`clock_gettime`, `nanosleep`) in `sysvIo`. Raised by [Ch 72].

> **Never runs.** `isMachineTarget` (`src/optimizing/target/model.ts:57`) is exported and
> unit-tested, and called from nowhere in `src/`. Cost to remove: delete it and its test, or
> find the caller it was written for. Raised by [Ch 72].

> **Unenforced.** The `generational-heap` capability is declared by two `capabilitySet(...)`
> calls and read by no pass, analysis or emitter. Its correspondence to
> `tera_write_barrier` is held only by one e2e test, so a backend could claim the capability
> without emitting a barrier and nothing in the compiler would object. Raised by [Ch 62],
> [Ch 72].

> **Broken.** `TAKES_ONE_ELEMENT` and `ADDS_ONE_ELEMENT` (`src/core/indexing.ts:61-62`)
> hold `pop`/`shift` and `push`/`unshift` and nothing else, so the length-bounds analysis
> does not model `splice` — which `data/tera-language-spec.ts:6650` declares on the same
> array surface and `src/optimizing/passes/array-methods.ts` fully lowers (`spliceOrigin`
> `:1239`, `spliceEnd` `:1247`). A function guarded by
> `if q.length > 0:` that calls `q.splice(0, 1)` and then `q.shift()` keeps the guard's
> count, so the checker strips the `undefined` that the `shift()` will actually return.
> Measured 2026-09-07 on a five-line `drain([5])`: the interpreter prints `NaN`, the native
> binary prints `0`, and `tera check` accepts the file in silence and exits 0. Cost to fix:
> a `provenCount`-style transfer rule for `splice` — net length change is
> `items.length - count` — plus a decision to prove nothing when either argument is not a
> literal. Raised by [Ch 1], [Ch 13].

> **Unenforced.** Nothing checks that `TAKES_ONE_ELEMENT ∪ ADDS_ONE_ELEMENT`
> (`src/core/indexing.ts:61-62`) is the complete set of length-changing array members. The
> transfer function's soundness rests entirely on that closure. The two sets are imported by
> three files — `src/frontend/checker/length-bounds.ts:2`,
> `src/optimizing/passes/array-shapes.ts:67` and
> `src/optimizing/passes/class-member-lowering.ts:69` — and by no test;
> `tests/core/indexing.test.ts` imports only `normalizeIndex`, `provenCount` and
> `resolveSlice`. There is no `satisfies` constraint tying either set to the array surface in
> `data/tera-language-spec.ts`. Cost to enforce: derive both sets from that surface, or add
> the constraint that fails to compile when a length-changing member is declared and not
> classified. The `splice` item above is what the gap costs once; it will cost the same again
> for the next member anyone adds. Raised by [Ch 1], [Ch 13].

> **Broken.** `--trace-feedback` labels every line `Slot #0`.
> `src/feedback/vector/index.ts:189` passes a hardcoded `0` as the `slotId` argument of
> `Tracer.feedbackRecord` (`src/core/tracing/index.ts:222`), so no site, bytecode offset,
> function name or map reaches the trace. Every `[FB]` line the flag emits — 27 of them for
> `stats.tera`, 41 for `stats-poly.tera`, measured 2026-09-07 — carries the same slot label,
> which makes the one claim the flag exists to support, *the same site went polymorphic*,
> unobservable from its own output. Cost to fix: thread the real slot index through that one
> call site. Raised by [Ch 3], [Ch 24], [Ch 33].

> **Never runs.** `Tracer.feedbackTransition` (`src/core/tracing/index.ts:227-229`) is a
> complete second feedback-trace formatter with zero callers anywhere in `src/`, `tests/` or
> `tools/`. The one transition that is traced goes through `feedbackRecord` instead, with a
> pre-formatted `from → to` string in its `details` argument. Cost to remove: delete three
> lines. Cost to finish: call it from `src/feedback/vector/index.ts:189` in place of the
> `feedbackRecord` call, which is also where the `Slot #0` defect above is fixed. Raised by
> [Ch 3], [Ch 33].

## Harvested from the written chapters

Everything below was raised as a marker by a written chapter and copied here by hand, per
[Conventions § 6]. The grouping follows the pipeline, the same order the parts do. Where more
than one chapter raises the same item it appears once, with every raiser named; the
deduplications are noted in place. The fifteen most consequential were re-run against this
tree on 2026-09-08 before being written down, and every one of them still held.

### The live four-tier divergence

> **Broken.** The Smi canonicalisation gap. `ROP_ADD`'s `areBothNumber` branch is an
> unconditional `mkDouble(this.toNumberValue(left) + this.toNumberValue(right))`
> (`src/bytecode/register/interpreter/index.ts:1508-1509`) and never canonicalises an integral
> sum back to a Smi, so a value's tag depends on which operation produced it. `JSArray.indexOf`
> (`src/objects/heap/js-array.ts:269-281`) then asks `strictEqual`, which compares tag codes
> first and misses; the compiled tiers have no tag at all, because `lowerSearch` replaces the
> call with an inline scan whose per-element test is `sameElement`
> (`src/optimizing/passes/array-methods.ts:159-171`), a numeric IR comparison. Verified on this
> tree, 2026-09-08, on the six-line probe `fn probe() -> int:` / `one = 0.5 + 0.5` /
> `xs = [one]` / `return xs.index_of(1)`, one run per fresh process:
>
> ```
> node dist/cli.js --no-opt probe.tera                        -> -1   exit 0
> node dist/cli.js --baseline-threshold 1 --no-opt probe.tera -> -1   exit 0
> node dist/cli.js --opt-threshold 1 probe.tera               ->  0   exit 0
> node dist/cli.js compile probe.tera -o probe.exe; ./probe.exe ->  0  exit 0
> ```
>
> Two tiers answer `-1` and two answer `0` from one source file. The third line really is the
> optimizing tier: `--opt-threshold 1 --trace-opt` prints
> `[JIT] Compiling "probe": Wasm module compiled: 590 bytes, 1 blocks` followed by
> `Wasm installed in 2.80ms`, and the installed code is what answers `0`. One measurement
> detail matters for anyone re-running this: `--always-opt` does **not** reproduce it, and
> prints `-1`. `buildTiering` (`src/cli/main.ts:54-58`) maps `optMode === "always"` to
> `jitThreshold = 3`, `probe` is called once, and `--trace-opt` under that flag prints nothing
> at all — no compilation happens. Use an explicit `--opt-threshold 1`.
>
> This is the book's only live four-tier divergence, and it is what [Ch 82] lost when the
> `int[]`-comparison entry closed. Cost to fix: a decision, not a line. Either `ROP_ADD`'s
> numeric branch calls `mkNumber` instead of `mkDouble` — restoring the invariant at the price
> of a `Number.isInteger` and two comparisons on every non-Smi addition the interpreter
> performs — or `JSArray.indexOf` stops using `strictEqual` and uses `compareValues("==")`,
> which makes `index_of` agree with `==` and with the compiled tiers but changes what "the
> same element" means for every other array member built on it. No test catches it: all 90
> lines in `tests/` mentioning `index_of` search for a literal, and a literal reaches the
> constant pool, where `wrapConstant` canonicalises it. Raised by [Ch 22]; wanted by
> [Ch 80], [Ch 82] and [Ch 83].

### The shell and the fourteen forms — Ch 1–3

> **Never runs.** `Engine.diagnostics` (`src/api/engine.ts:713`) in the default `warn` mode.
> The checker fills it at `:1200` and nothing in `src/` reads it again except the two
> strict-mode throws at `:1205-1206` and `:1426-1427`. `src/cli/main.ts:134` loops over
> diagnostics from a *different* object, produced by a fresh `checkModuleGraph` inside
> `runCheck`. Its only reader is
> [t: tests/e2e/language/types.test.ts > "supports off, warn, and strict modes"]. Cost to
> finish: one loop in `runProgram`, plus a decision about whether a warning changes the exit
> code. Raised by [Ch 1].

> **Unenforced.** Nothing checks that `TERA_KEYWORD_GROUPS` (`data/tera-language-spec.ts:280-343`)
> and `KEYWORDS` (`src/frontend/lexer/index.ts:37-81`) describe the same language; the
> `satisfies` constraint on the spec table constrains only the five group names. Two consumers
> read the spec list and neither reads the lexer's — `src/cli/repl/language.ts:52` for tab
> completion and `tools/editor/src/language-data.ts:14` for the editor grammar — so the
> disagreement is user-visible in both directions. Cost to enforce: one derived table and a
> decision about which list is the authority. Raised by [Ch 2].

> **Unfinished.** `TERA_PRIMITIVE_TYPES` (`data/tera-language-spec.ts:345-381`) names 36
> types, five of which — `Tensor`, `DataFrame`, `Trainer`, `Dataset`, `MLModel` — are not
> implemented in this repository at all. A program may annotate a parameter `Tensor` today and
> no tier in this tree will ever produce one. Cost to finish: the sibling repositories, not a
> change here. Raised by [Ch 2].

> **Unenforced.** The checker does not verify that a method name exists on the pseudo-type it
> resolves against. `s.toUpperCase()` on an `s: string` passes `check` and `--typecheck strict`
> with exit 0 and fails at run time with `undefined is not a function`, a message naming a
> downstream symptom. Only the native compiler catches it. Cost to enforce: a diagnostic on a
> member access that resolves to nothing, plus a decision about the builtin shapes where an
> absent member is tolerated on purpose. Raised by [Ch 2]; [Ch 12] raises the class-shaped
> half of the same gap below.

> **Broken.** `--print-ast` does not render class methods as trees. `ClassDeclaration.methods`
> holds plain records with no `type` field, so `isNode()` (`src/frontend/ast-text.ts:3-10`)
> rejects each one and `render` falls through to `formatScalar` (`:16-21`), which is
> `JSON.stringify`. `--print-ast docs/example/stats.tera` prints the whole of `mean` and the
> whole of `label` as two single lines of JSON, 1,820 and 910 characters. Cost to fix: a `type`
> field on the method record, or a special case for `methods` in `render`
> (`src/frontend/ast-text.ts:33-69`). Raised by [Ch 3].

> **Broken.** `RegisterCompiledFunction.disassemble` (`src/bytecode/register/ops/bytecode.ts:599-657`)
> prints every operand it does not special-case with an `r` prefix, so `--print-bytecode`
> renders jump targets, argument counts and feedback-slot indices as register numbers —
> `Jump r4` for a jump to instruction 4, `Add r2 r6` where `r6` is feedback slot 6 in a
> function that declares five registers. It special-cases three groups and nothing else.
> Nothing pins the current output: the two tests that call it assert only that opcode and local
> names appear. Cost to fix: an operand-role table beside `ROPCODE_NAMES` and one lookup in the
> loop — the same table [Ch 33] asks for twice. Raised by [Ch 3], [Ch 21], [Ch 33].

> **Unenforced.** Two of the five opcodes in the baseline's second decline list are covered by
> no test. [t: tests/optimizing/baseline/compiler.test.ts > "rejects functions containing
> spread/rest/defineAccessor"] loops over three of them
> (`tests/optimizing/baseline/compiler.test.ts:89-97`); nothing asserts that
> `ROP_SPREAD_ARRAY` or `ROP_ASSERT_CLASS_CONTRACTS` makes the baseline decline. Cost to
> enforce: two entries in that loop. Raised by [Ch 3].

> **Unfinished.** `--print-ir` is wired to `EngineOptions.onOptimize`
> (`src/cli/main.ts:92-95`), which fires only when a function reaches the optimizing tier.
> `stats.tera` at the default `jitThreshold: 50` never does, so the flag is accepted, nothing
> is printed and nothing says so. `--print-bytecode` with a `--filter` matching no function has
> the same trap. Cost to finish: one counter in `buildEngineOptions` and one line at exit.
> Raised by [Ch 3].

> **Unfinished.** The wasm JIT cannot compile `Series.mean()`, the method this book follows.
> The refusal is `unsupported("property access on this receiver")`
> (`src/optimizing/backends/wasm/codegen.ts:476-477`), reached when `READS_A_RECEIVER.has(node.type)`
> and `holdsTheReceiver(node.inputs[0])`; the sibling refusal `"handing back this receiver"` is
> at `:479-480`. It is structural, so no threshold changes it. Cost to finish: a representation
> for a receiver in the wasm object layout — the same work [Ch 53] measures as marshalling
> cost. Raised by [Ch 3].

> **Unfinished.** Four of the fourteen forms have no CLI flag: the token stream, the semantic
> AST, the generated baseline JavaScript and MachineIR. The producing symbol exists in every
> case — `tokenize`, `lowerToSemanticProgram`, `BaselineCompiler.generateBody`,
> `printMachineFunction` — so each costs one entry in the flag table in `src/cli/spec.ts` and
> one sink. [Ch 73] describes this CLI as a shell that will show you every stage; on this axis
> it is four flags short. Raised by [Ch 3].

### The checker and the binder — Ch 8–14, 16

> **Unenforced.** `Scope.boundary` (`src/frontend/checker/binder.ts:25`) and
> `lookupWithinBoundary` (`:341-350`) have no test that names them; the sixteen `boundary` hits
> in `tests/` are all about something else. The rule that keeps the checker and the runtime
> agreeing about a bare assignment is pinned only indirectly. Cost to enforce: one test file
> that, per shape, both compiles and checks the program and asserts the two agree about which
> binding a bare `x =` wrote. Raised by [Ch 8].

> **Broken.** `lookupWithinBoundary` (`src/frontend/checker/binder.ts:341-350`) stops at the
> first `boundary` scope; `scopeMethods._declareImplicitLocals`
> (`src/bytecode/register/compiler/scope.ts:380-389`) skips any name `this.scope.resolve(name)`
> finds, and `resolve` has no boundary. For a declared module-level binding the two disagree:
> `x: int = 1` followed by `fn g(): x = "text"` runs, prints `text` twice, and passes
> `--typecheck strict` with exit 0. Cost to fix: one rule with one owner — the checker learns
> the compiler's `resolve` rule (modelling script-var hoisting in the binder), or the compiler
> learns the boundary rule (a language change). Raised by [Ch 8].

> **Broken.** `astToSemanticProgram` (`src/frontend/checker/semantic-lowering.ts:87-90`) has no
> `NodeType.LabeledStatement` case, so `toSemanticNodes` falls to `default: return []` and a
> labeled statement's entire body disappears from the `SemanticProgram`. Re-verified
> 2026-09-08: `outer: for r of [1, 2]:` / `n: int = "text"` / `print(n)` draws no diagnostic
> from `check` and exits 0, while the same three lines without the label report
> `error: Type 'string' is not assignable to 'int'` and exit 1. Because the AOT gate is "is the
> diagnostics array empty", `compile` then writes an executable for the labeled version. Cost
> to fix: one case forwarding to `toSemanticNodes(node.body)`, plus a decision about what a
> labeled jump means to `alwaysExits`. Raised by [Ch 8].

> **Unfinished.** `ModelNode` (`src/frontend/checker/semantic-ast.ts:67-74`) and the `Model`
> branch of `bindNode` (`binder.ts:204-220`) exist for `model` declarations and no file in
> `docs/example/` declares one, so the running example never reaches any of it. The surface
> exists because models are how a tera program hands work to `mlfw`; per [Conventions § 19]
> its internals are out of scope. Cost to finish: the sibling repository. Raised by [Ch 8].

> **Unfinished.** `cleanType` (`src/frontend/checker/type-system.ts:150-175`) normalizes
> `Array<T>` with a negated character class that cannot cross a `>`, so `Array<Array<int>>`
> needs two passes to reach `int[][]` and `cleanType` is not idempotent. The engine survives
> because `resolveType` (`:354`) and `latticeFromDeclaredType`
> (`src/optimizing/types/declared.ts:102`) each re-clean; what does not get the second pass is
> the string the checker stored and prints. Cost to finish: a depth walk like the
> `splitTopLevel` the rest of the file uses. Raised by [Ch 9].

> **Unenforced.** `splitTopLevel` (`src/core/type-text.ts:1-24`) increments `depth` on `<` with
> no matching guarantee, and nothing anywhere checks that a `TypeName` is balanced — no
> validator, no `satisfies` constraint, no assertion. A malformed annotation is split somewhere
> plausible and the wrong split reaches `parseFunctionParam`. Cost to enforce: a `balanced(type)`
> predicate over the same loop, called once from `cleanType`, and a diagnostic. Raised by
> [Ch 9].

> **Broken.** `substituteType` (`src/frontend/checker/type-system.ts:335-341`) substitutes by
> word-boundary regex over the whole type string, and `unifyTypeParams`'s fallback
> (`src/frontend/checker/infer.ts:375-377`) binds a type parameter on mere textual occurrence
> — `new RegExp("\\b" + typeParam + "\\b").test(param)`, which matches a *field name*. A
> generic function's behaviour therefore depends on the name of its type parameter, and a type
> parameter `T` collides with a field `T`. Cost to fix: parse the annotation instead of
> matching it, which is [Ch 9]'s "types are text" decision reopened. Raised by [Ch 9],
> [Ch 11].

> **Unenforced.** Array element assignability (`src/frontend/checker/type-system.ts:850`) is
> covariant, so `int[]` is accepted where `float[]` is expected even though arrays are mutable.
> Cost to enforce: a read-only array spelling the language does not have; making it sound
> without one would refuse `values.map` chains the test corpus expects to pass. Raised by
> [Ch 10].

> **Unfinished.** `genericArgsAssignable` (`src/frontend/checker/type-system.ts:981-982`)
> returns `true` when either argument list is empty and otherwise compares only
> `Math.min(actual, expected)` positions, so a bare `Promise` is assignable to `Promise<int>`
> and back. Cost to finish: deciding what a missing type argument means — `unknown` refuses
> existing programs, `any` is what happens today by omission. Raised by [Ch 10].

> **Unfinished.** `nominalAssignable` clears `currentArgs = []` on every step up the lineage
> (`type-system.ts:1011`), so a parent's type arguments are never substituted through an
> `extends` and the comparison falls into the empty-list case above. Cost to finish: threading
> a substitution map through the walk, which needs the parent clause to record its arguments —
> and `binder.ts:244` stores the parent as a bare name. Raised by [Ch 10].

> **Unenforced.** `compatible`'s memo key is built from `resolveType(actualRaw, env)`, and
> `resolveType` returns the *unresolved* name on an alias cycle
> (`src/frontend/checker/type-system.ts:353-355`). Two distinct cyclic aliases bottoming out on
> the same name share a memo key inside one call, and the assumption written for one is read by
> the other. Cost to enforce: keying the memo on resolution identity, which means giving
> aliases identities — and [Ch 9] is the decision not to. Raised by [Ch 10].

> **Unenforced.** `constructorVariance` caches per owner name in a module-level
> `VARIANCE_CACHE` (`src/frontend/checker/type-system.ts:891`), writes a `"co"` seed before
> recursing (`:912`), and never invalidates or re-runs; nothing asserts the result is a fixpoint
> of `inferParamVariance`. It cannot go stale today because `PSEUDO_TYPE_PARAMS` and
> `METHOD_SPECS` are built once at module load. Cost to enforce: iterate to convergence and
> assert the second pass agrees — a few lines over a few dozen entries. Raised by [Ch 10].

> **Broken.** `inferExpression`'s `ConditionalExpression` case
> (`src/frontend/checker/infer.ts:115-116`) passes `null` where `expected` belongs. A lambda
> written into a declared function-typed slot gets its context; the same lambda inside a ternary
> arm does not, and is typed `(any) -> unknown`. Cost to fix: forward `expected` the way the
> case already forwards `expectedType`. Raised by [Ch 11].

> **Dead.** `inferArrow`'s block-body branch (`src/frontend/checker/infer.ts:459-460`) cannot be
> reached from tera source: `parseArrowFunction` (`src/frontend/parser/index.ts:2139-2158`) ends
> with `parseExpression`, and the only `ArrowFunctionExpression` carrying a `BlockStatement` is
> the list-comprehension desugaring at `:2256-2262`, which `arrayComprehensionType`
> (`infer.ts:400-401`) intercepts first. Cost to remove: two lines, plus deciding whether a
> block-bodied lambda is wanted. Raised by [Ch 11].

> **Unenforced.** `adoptContextualSignature` mutates a shared AST node and nothing asserts it
> runs at most once per node, or that a second context cannot be weaker than the first. The
> only guard is `isUnwrittenType` on the existing entry, so a first stamp blocks a second
> without anything establishing that the first to arrive is the best available. Cost to
> enforce: provenance on `_paramInfo` entries, or an idempotence test. Raised by [Ch 11].

> **Unfinished.** `arrowSignature` (`src/frontend/checker/infer.ts:539-553`) gives every
> parameter of a directly-called arrow the type `"any"` and infers the return from the body in
> the outer scope, so an IIFE is unchecked end to end. Cost to finish: a real signature for the
> immediately-invoked shape. Raised by [Ch 11].

> **Unfinished.** `recordThisPush` (`src/frontend/checker/type-checker.ts:448`) compares the
> member name against the constant `PUSH_MEMBER` (`:1398`), the string `"push"`. `unshift`,
> `concat`, a subscript store and every collection method also put an element into an array
> field and contribute no element type — odd next to `src/core/indexing.ts:62`, where
> `ADDS_ONE_ELEMENT` already names both `push` and `unshift`. Cost to finish: a set membership
> test, plus a decision about what element type an indexed store or a `concat` contributes.
> Raised by [Ch 12].

> **Unfinished.** `collectThisFields` (`type-checker.ts:378-391`) and `collectThisPushes`
> (`:435-442`) recurse into `Block` and `For` and nothing else, so a `this.x = ...` inside a
> nested function, a lambda or a labeled statement never reaches the shape. Cost to finish:
> deciding whether an assignment inside a closure that may run later, never, or many times
> establishes a field type at all — the question [Ch 13] answers *no* to for array lengths.
> Raised by [Ch 12].

> **Unenforced.** A static member is absent from the instance shape and the checker does not
> report reading one through an instance: `memberType` (`src/frontend/checker/infer.ts:633-643`)
> answers `null`, `declaredMemberType` turns that into `"unknown"`, and an `unknown` is reported
> only where something demands a type. Re-verified 2026-09-08: a class declaring
> `public static make() -> int` and a call `c.make()` on an instance passes `check` with exit 0
> and fails at run time with `undefined is not a function`, exit 1. Cost to enforce: a
> diagnostic on a member access resolving to nothing on a class-derived shape, plus a decision
> about the builtin shapes where absence is tolerated. Raised by [Ch 12].

> **Unfinished.** `Binding.open` (`src/frontend/checker/type-system.ts:31`) is set in
> `recordThisAssignment` (`type-checker.ts:412`) and cleared nowhere in `src/`; `fillOpenField`
> (`:1012`) refines the type and leaves the flag, so `assignableType` keeps answering
> `OPEN_FIELD_TYPE` for reads and writes alike. Cost to finish: deciding when a field stops
> being open, which is a definite-assignment question the single-pass checker has no
> control-flow graph for. The half-fix — clear `open` in `fillOpenField` and accept `T | null` —
> would make `head.next.value` require a null guard. Raised by [Ch 12].

> **Unfinished.** `classSurfacesOf` iterates `bound.program.body`, so a class declared inside a
> function never becomes a surface, and `classSurfaceOf` reads the constructor signature from
> `bound.root.signatures` rather than the enclosing scope. A `class Inner` inside `fn make()`
> runs in the interpreter, passes `check` with exit 0, and fails to compile with
> `cannot emit: unsupported opcode GenericSetProp` alongside
> `call to Inner passes 0 of 1 arguments` — a message naming a downstream symptom. Cost to
> finish: a recursive walk, plus a decision about a nested class's identity when the enclosing
> function is compiled more than once. Raised by [Ch 12].

> **Unfinished.** `narrowScope` (`src/frontend/checker/infer.ts:484`) tests
> `test.type === NodeType.BinaryExpression` and stops, so `if a != null and b != null:` narrows
> neither operand. The recursion it needs already exists twelve lines into a neighbouring file
> — `KEPT_WHEN` (`src/frontend/checker/length-bounds.ts:28-33`) and `countedSubjects`
> (`:98-108`). Cost to finish: lifting that recursion into `narrowScope`, plus a decision about
> what an `||` arm may assume. Raised by [Ch 13].

> **Unfinished.** `literalCount` (`src/frontend/checker/length-bounds.ts:79-82`) requires a
> `Literal` node of kind `number`, so a guard written against a variable proves nothing even
> when the variable is obviously constant; the middle-end twin `boundOf`
> (`src/optimizing/passes/array-methods.ts:665-666`) demands an `IR_CONSTANT` for the same
> reason. Cost to finish: a constant-folding pass over the semantic tree, which the single-pass
> checker does not have. Raised by [Ch 13].

> **Unenforced.** `provenTakes` is computed once over `program.body` and stored on
> `BoundProgram` as a `ReadonlySet<ASTNode>` keyed on object identity. A node that is mutated
> keeps its proof; a node that is *replaced* loses it silently, and the engine does run
> user-supplied AST passes (`runCompilerPasses("ast", …)`, `src/api/engine.ts:1209`). No test
> covers a rewrite between binding and inference. Cost to enforce: a stable node identifier —
> what [Ch 44] does for the IR for the same reason — or a re-run after any tree edit. Raised
> by [Ch 13].

> **Broken.** `Bounds` keys `counts` on name text (`subjectName`) and has no aliasing story.
> A function guarded by `if q.length >= 2:` that binds `alias = q`, calls `alias.shift()`, then
> takes twice from `q` is accepted in silence with exit 0, because `takes` recorded `alias`
> (`length-bounds.ts:222`) and nothing connects the two names; the interpreter prints `NaN` and
> the compiled binary prints `0`. Cost to fix: a may-alias analysis the single-pass checker has
> no framework for, or the blunt version — forget every count whenever any array-typed name is
> assigned from another, a dozen lines that would refuse programs that are fine today. Raised
> by [Ch 13].

> **Unfinished.** Beyond `splice`, `concat`, an assignment to `length`, a subscript store past
> the end and every collection method in [Ch 60] change a length and are invisible to `Bounds`
> (`src/frontend/checker/length-bounds.ts`). Only the take-shaped ones are unsound; a missing
> refund only loses proofs. Cost to finish: one transfer rule per member, which is the same
> table the `> **Unenforced.**` closure item above asks for. Raised by [Ch 13].

> **Unfinished.** `EffectAnalyzer` never reads the parser's `async` flag. A `Unit` is constructed
> with `async: false` (`src/frontend/effects/index.ts:133`, again at `:218` in `unitFor`) and the
> only thing that ever changes it is `raise`, called from the `isAsyncOrigin` test in `walk`
> (`:196`) and from `propagate` (`:327`); `FunctionNode.async` (`:11`) is *written* at `:335` in
> `mark` and never read as an input. So `async fn load()` followed by an unawaited `load()` inside
> a plain `fn` gets no `implicitAwait`, no `ROP_AWAIT`, and a promise where a value was wanted —
> `--print-bytecode --filter total` on that shape emits five instructions and no `Await`. It has
> not bitten only because the checker catches the same case independently
> (`Type 'Promise<float[]>' is not indexable`), so it bites wherever the checker is silent. Cost
> to finish: one line in `walk` (`inner.async = node.async === true`), plus a decision about what
> then happens to an explicit `await` on such a call, which would become a second `ROP_AWAIT` on
> one value. **[unpinned]** — no test in `tests/frontend/effects.test.ts` analyzes a declared
> `async fn` at all. Raised by [Ch 14].

> **Unfinished.** `closuresOf` (`src/frontend/effects/index.ts:203-213`) merges `byName`
> (declarations) with `flow` (values) by **bare name**, with no scope of any kind, and `tracked`,
> `flow` and `opaque` are single analyzer-wide maps. Two different functions with a parameter named
> `f` are one entry, and one async function flowing into either makes every `f()` call in the
> program await. Measured on this tree, 2026-09-07: a program where `apply_a(loader)` and
> `apply_b(plain)` both take a parameter named `f` compiles `apply_b`'s call site to `Call`
> followed by `Await` and `--trace-opt` emits no `[JIT] Compiling "apply_b"` line at all; delete
> the two unrelated lines and the same function is baseline-compiled and installed as 267 bytes of
> wasm. The cost of the imprecision is three tiers, not a wasted opcode, because `ROP_AWAIT` is in
> `INTERPRETER_ONLY_OPS` and `requiresInterpreterOnly` gates baseline, JIT and OSR alike. Cost to
> finish: key the analysis by scope identity rather than by name — but the scopes that exist are
> built over the `SemanticProgram` and this pass walks the raw AST, so it is a change of input
> tree, not a reordering. **[unpinned]** — no test covers a name collision across two functions.
> Raised by [Ch 14].

> **Unfinished.** `resolveCallee` answers `NOT_A_CLOSURE` for **every** `MemberExpression`
> (`src/frontend/effects/index.ts:264`), so `obj.method()` is never resolved to a `Unit` and
> async-ness of a method call is recovered only through `isAsyncNamespaceCall` and the
> `domainType` receiver test — that is, only for the builtin domain surface. A user class with an
> `async` method is invisible to this pass in both directions. Cost to finish: member resolution
> needs a receiver type, which is the checker's job and which this pass does not have access to.
> Raised by [Ch 14].

> **Unenforced.** `analyzeEffects` mutates its argument and returns it
> (`src/frontend/effects/index.ts:344-347`) and nothing marks the tree as analyzed;
> `src/api/engine.ts` calls it at `:1210` and `:1253` and each runs the whole two-phase fixpoint
> from scratch. Because `mark` only ever *sets* flags, a second run over an already-marked tree
> cannot clear a flag a changed program no longer justifies — it can only add. No test analyzes the
> same AST twice. Cost to enforce: an analyzed marker on the tree, or a `mark` that clears.
> Raised by [Ch 14].

> **Unenforced.** The relationship between `TERA_ASYNC_DOMAIN_TYPES` and the sibling packages is
> checked for two names only. [t: tests/e2e/language/effects.test.ts > "keeps the declared async
> domain types in sync with the native classes"] asserts that `DataFrame` and `Trainer` are in the
> set and really do have async methods, and that `mlfw`'s `Linear` and `DataLoader` are in neither
> category. Nothing enumerates the sibling surface, so a new async class in `query_engine` or
> `mlfw` is silently not a seed — the analysis will not know to await it and nothing will fail.
> Cost to enforce: derive the set from the sibling surfaces, which crosses a repository boundary
> ([Conventions § 19]). Raised by [Ch 14].

> **Unenforced.** The invariant "the AOT road always runs strict" is held by two identical
> lines at `src/api/engine.ts:1187` and `:1388`, and the refusal is decided by array length
> rather than by severity; `TypeChecker.strict` is a public settable field. A third AOT entry
> point already exists that does not repeat the pair — `Engine.compileAotFunctions` (`:948`)
> takes already-compiled functions and never runs the checker; three tests use it and the CLI
> cannot reach it. Cost to enforce: one private helper owning mode selection and the throw,
> called by all three. Raised by [Ch 16].

> **Unenforced.** `engine.ts:1205-1207` and `:1426-1428` are the same three lines written
> twice, and the code around them differs: the module-graph door runs
> `refuseRepeatedClassNames` and `buildClassTable` (`:1424-1425`) before the throw, the
> single-source door builds its class table at `:1201`. Building a class table from a program
> the gate is about to reject is pinned by no test. Cost to enforce: the same shared helper.
> Raised by [Ch 16].

> **Unfinished.** `isUnknownish` (`src/frontend/checker/type-checker.ts:1058-1070`) suppresses
> 32 distinct checks, so a single `any` in a union, an array element or a tuple slot disables
> checking for every expression that type reaches. Cost to finish: distinguishing "the user
> wrote `any`" from "the checker could not work it out", which needs a second sentinel threaded
> through `TypeName` — and `TypeName` is a string ([Ch 9]). Raised by [Ch 16].

> **Unfinished.** The checker walks `program.body` once in source order
> (`type-checker.ts:57-61`), so a call to a function declared later whose return type is
> inferred sees nothing and answers `any`; swap the two declarations and the error appears.
> Cost to finish: a declaration pre-pass seeding every top-level signature, which then needs a
> story for mutually inferred returns — a fixpoint. Raised by [Ch 16].

> **Unenforced.** Excess properties in an object literal are never reported: `objectAssignable`
> and `checkObjectExpression` check that the *required* fields are present, not that no others
> are. That is the correct rule for a language whose classes are shapes ([Ch 12]) and the wrong
> one for catching a typo'd field name. Cost to enforce: an excess-property check with an
> opt-out for the structural cases. Raised by [Ch 16].

> **Unfinished.** A `FunctionExpression` with no expected type infers as the bare string
> `"Function"` (`src/frontend/checker/infer.ts`), which carries no parameters and no return.
> Cost to finish: inferring a real signature from the body, the same machinery `arrowSignature`
> above is short of. Raised by [Ch 16].

### Modules — Ch 15

> **Broken.** The parent edge puts a package and its submodules in one component; it does not
> put the package *first* inside it. That is decided by `component.sort(by discovery index)`
> (`src/frontend/modules/graph.ts:211`), and the discovery index comes from a DFS whose starting
> successors are the entry file's imports, in source order. Re-verified 2026-09-08 on three
> files — `pkg/__init__.tera` holding `base = 10` then `from .inner import doubled`,
> `pkg/inner.tera` holding `from pkg import base` then `doubled = base * 2`: an entry of
> `import pkg` / `print(pkg.doubled)` prints `20` and exits 0, while an entry of
> `from pkg.inner import doubled` / `print(doubled)` fails at run time with
> `cannot access 'base' from module 'pkg.inner' before module 'pkg' finished initializing`,
> exit 1. `check` accepts both and exits 0 in each case. Cost to fix: sort each component by
> spec depth before discovery index — about one line, plus a decision about a component holding
> two unrelated packages. **[unpinned]** — the two tests that pin the orderings both use an
> entry naming the package first. Raised by [Ch 15].

> **Broken.** `importedSurface`'s `claim` closure (`src/frontend/modules/interface.ts:247-251`)
> is a `Set` of local names: the first import to bind a name wins, later ones are dropped with
> no diagnostic. The runtime has no such rule — the last binding written into the module's cells
> wins. Re-verified 2026-09-08: with `a.tera` defining `fn f(n: int) -> int` and `b.tera`
> defining `fn f(s: string) -> string`, an entry of `from a import f` / `from b import f` /
> `print(f("hello"))` **runs and prints `hello!`**, while `check` on the same file reports
> `Type 'string' is not assignable to parameter 'n: int'` and exits 1 — a correct program
> refused, with a refusal describing a function it does not call. Cost to fix: one diagnostic in
> `ModuleChecker.checkImports`, plus deciding whether the rule is first-wins (the checker) or
> last-wins (the runtime); the two halves must agree before either can be reported.
> **[unpinned]** — the differential test covers the *aliased* spelling, which avoids the
> collision. Raised by [Ch 15].

> **Unfinished.** The namespace local is typed `any` (`interface.ts:256`), so member access on
> it is unconstrained: qualified names are typed, but a member that does not exist is not an
> error at all — `shapes.no_such_fn(1)` produces no diagnostic and exits 0. Cost to finish:
> publishing the module as an `ObjectShape` in `env.interfaces` instead of a value plus a set of
> dotted names, which changes how dotted-name lookups resolve for every import in the tree.
> Raised by [Ch 15].

> **Unfinished.** `qualifiedSurface` (`interface.ts:227-232`) re-publishes only `builtins` and
> `values`, so an `interface`, a `class` or a type alias reached through a namespace import —
> `shapes.Point` used as a *type* — is not in the importing module's surface at all. Only the
> `from X import Point` spelling carries a shape across. Cost to finish: publishing types
> through the namespace too. Raised by [Ch 15].

> **Unfinished.** `adoptAliases` (`src/frontend/modules/interface.ts`) makes aliases effectively
> global and unqualified. Two modules that both define `type Id = int` agree by accident; two
> that disagree put the name in `disputed`, delete it for *every* module, and never re-adopt it,
> with no diagnostic. Cost to finish: per-module alias environments, which means `resolveType`
> must know which module it resolves for — a parameter threaded through most of the checker.
> Raised by [Ch 15].

> **Unfinished.** `startModules` abandons the entire IR-level initializer rewrite if any one
> module can throw while loading — all-or-nothing per program, not per module, and since the
> refusal is recorded against the entry function the whole compile fails. Cost to finish:
> emitting the call sequence for the modules that can be started and falling back to the
> link-time table for the rest, which requires the two mechanisms to agree on ordering; today
> they are alternatives, not a mixture. Raised by [Ch 15].

### Bytecode — Ch 17–20

> **Dead.** `ROP_TEST_FEEDBACK` (`src/bytecode/register/ops/bytecode.ts:76`) has a name in
> `ROPCODE_NAMES` (`:254`), an `ACCUMULATOR_ONLY` entry in `REGISTER_EFFECTS`
> (`src/bytecode/register/ops/register-effects.ts:181`) and a `case` in the baseline compiler
> that returns the empty string (`src/optimizing/baseline/compiler.ts:384-385`). Nothing emits
> it — a tree-wide grep returns those four lines and nothing under
> `src/bytecode/register/compiler/`. The interpreter has no case, so one would fall to
> `Unknown register opcode 0x55 (TestFeedback)`. Cost to remove: four lines across three files.
> Cost to finish: decide what it was for and give it a producer. Raised by [Ch 17], [Ch 21].

> **Unfinished.** `RegisterEffects.writes` is populated for exactly two opcodes — `ROP_STAR`
> via `LOADS_FIRST` and `ROP_MOV` via `MOVES_FIRST_TO_SECOND`. Every other value-producing
> opcode writes the accumulator and the table has no `writesAccumulator` field, so
> `register-liveness.ts` cannot ask it about accumulator liveness and does not try. This is a
> stated limit, not a bug: the table describes the register file and the accumulator is
> deliberately outside it. Cost to finish: one boolean field and ninety entries to audit.
> Raised by [Ch 17].

> **Unenforced.** Nothing checks that the interpreter's hand-written operand reads agree with
> `REGISTER_EFFECTS`. `forEachRegisterRead` says `ROP_CALL` reads
> `operands[1] … operands[1] + operands[2] - 1`; `src/bytecode/register/interpreter/index.ts`
> re-derives the same window by hand, and changing one is not a type error in the other. The 26
> tests in `tests/bytecode/register/ops/register-effects.test.ts` pin the table against itself.
> Cost to enforce: a differential test running each opcode through both, or moving the
> interpreter onto the table — the real fix, and much larger. Raised by [Ch 17].

> **Never runs.** `ROP_MOV` (`0x04`, `Mov`). Four files handle it —
> `src/bytecode/register/interpreter/index.ts:1430`,
> `src/optimizing/baseline/compiler.ts:198-199`, `src/optimizing/builder/ir-builder.ts:649` and
> `src/optimizing/builder/inline.ts:406` — and nothing under
> `src/bytecode/register/compiler/` emits it. The inliner's branch is doubly unreachable: it
> consumes `Mov` while splicing a callee, and no callee can contain one. Its
> `MOVES_FIRST_TO_SECOND` effect is nonetheless pinned by
> [t: tests/bytecode/register/ops/register-effects.test.ts > "separates the source and
> destination of a move"], which is the only place register-to-register move semantics are
> written down. Cost to finish: nothing, if [Ch 18]'s `Ldar r; Star r'` pair is always used
> instead — but then say so and delete the four consumers. Raised by [Ch 17].

> **Broken.** `compileUpdateExpression` on a computed member target — `a[f()]++` — compiles the
> key expression **twice** and stores the wrong value
> (`src/bytecode/register/compiler/expressions.ts`). Cost to fix: evaluate the key once into a
> register and reuse it for the load and the store, which is what the non-computed path already
> does. Raised by [Ch 18].

> **Unfinished.** `compileUnaryExpression`'s unary-plus case emits `ROP_NEG` twice
> (`src/bytecode/register/compiler/expressions.ts:408-412`) and allocates two feedback slots to
> do it. Cost to finish: a `ROP_TO_NUMBER`, or accept the double negation and stop allocating
> the second slot. Raised by [Ch 18].

> **Unenforced.** Nothing checks that the operand a compiler method appends as a feedback slot
> sits in the position `register-effects.ts` expects to ignore. The producer
> (`src/bytecode/register/compiler/expressions.ts`) and the description
> (`src/bytecode/register/ops/register-effects.ts`) agree by inspection and by nothing else.
> Cost to enforce: a test that compiles a corpus and asserts `feedbackSlotCount` equals the
> number of distinct trailing operands the table skips. Raised by [Ch 18]; [Ch 33] raises the
> consuming half.

> **Unfinished.** The interpreter *types* a branch slot and never *writes* one.
> `FeedbackSlot.recordBranch` (`src/feedback/vector/index.ts:259-267`) has exactly one caller in
> `src/`, `BaselineRuntime.branch` (`src/optimizing/baseline/runtime.ts:774-779`); the
> interpreter's `ROP_JUMP_IF_FALSE` and `ROP_JUMP_IF_TRUE` cases
> (`src/bytecode/register/interpreter/index.ts:1786-1798`, `:1800-1812`) do not touch the
> vector. A function reaching the JIT without running in baseline has `getBranchBias()`
> answering `"unknown"` for every branch and `hotSuccessorOf` returning `null`. Cost to finish:
> one call in each of the two interpreter cases. Raised by [Ch 19]; [Ch 33] takes it up in full.

> **Unfinished.** `break` and `continue` at script scope emit nothing at all. `_breakJumps` and
> `_continueJumps` are initialised to `null` (`src/bytecode/register/compiler/index.ts:67-68`)
> and `enterLoop`/`exitLoop` restore `null` when the outermost loop exits, so the `else if`
> guard is false and the statement falls through silently:
> `node dist/cli.js -e 'print(1)⏎break⏎print(2)'` compiles to eleven instructions with no
> `Jump`, prints `1` then `2`, exits 0. Cost to fix: one `throw` in each of two `else` branches.
> **[unpinned]**. Raised by [Ch 19].

> **Unfinished.** The no-finalizer branch of `compileTryStatement`'s `handler === undefined`
> case — a `try` with neither `catch` nor `finally` — patches the handler target to the
> instruction after the block (`src/bytecode/register/compiler/statements.ts:632-633`), so the
> exception is swallowed; the finalizer branch emits an explicit `ROP_THROW` (`:590`) for the
> same shape. The parser refuses the shape first (`Missing catch or finally after try`,
> `src/frontend/parser/index.ts:1837`), so the branch is reachable only by handing the compiler
> an AST directly. Cost to fix: copy line 590. **[unpinned]**. Raised by [Ch 19].

> **Dead.** `compileTryStatement` computes `const hasFinally = !!finalizer` and
> `const hasCatch = !!handler` (`src/bytecode/register/compiler/statements.ts:564-565`) and
> never reads either; the function branches on `finalizer` and `handler` directly, and a
> repository-wide grep for both names returns only those two lines. Cost to remove: two lines.
> Raised by [Ch 19], [Ch 27].

> **Unenforced.** Nothing checks that every emitted jump was patched. `patchJump`
> (`src/bytecode/register/ops/bytecode.ts:595-597`) is an array store with no bookkeeping,
> `emit` (`:569-582`) returns an index nobody is obliged to use, and `compile()`
> (`src/bytecode/register/compiler/index.ts:143-175`) returns the function without inspecting
> the instruction list. This is the enforcement gap that made the labelled-`continue` bug a
> silent hang instead of a compile error — see § Closed. Cost to enforce: a set of unpatched
> jump indices drained at `compile()`. Raised by [Ch 19].

> **Unenforced.** `UpvalueDescriptor` (`src/bytecode/register/ops/bytecode.ts:182-188`) declares
> all five fields optional while `captureUpvalue`
> (`src/bytecode/register/compiler/helpers.ts:216-232`) always writes exactly four and never
> `index` or `isLocal`. Nothing checks the shape at construction; the interpreter re-validates
> at every `ROP_MAKE_CLOSURE` instead, throwing `VMReferenceError` four ways
> (`interpreter/index.ts:2124, 2127, 2133, 2137`) for states the compiler cannot produce. Cost
> to enforce: make the four written fields required and delete the other two; the throws then
> become unreachable and can go too. Raised by [Ch 20].

> **Broken.** `compileDoWhileStatement` (`src/bytecode/register/compiler/statements.ts:642-652`)
> never calls `_bodyMayCapture` and never emits `ROP_CLOSE_UPVALUES`, and does not even read an
> `iterationScopeBase`, so every closure created in a `do:` / `while (…)` body shares one
> `UpvalueCell` per slot with every other iteration. Re-verified 2026-09-08 on the sixteen-line
> closure-in-a-loop probe from [Ch 20]: the `while` form prints `0`, `1`, `2` and the
> byte-identical `do` form prints `2`, `2`, `2`, and
> `--print-bytecode --filter make` on the `do` form finds zero `CloseUpvalues`. `while`, `for`,
> `for-in` and `for-of` are all correct. Cost to fix: four lines copied verbatim from
> `compileWhileStatement` (`:386`, `:396-399`). **[unpinned]** — no test covers a closure created
> in a `do-while` body. Raised by [Ch 20].

> **Unfinished.** `compileForInStatement`
> (`src/bytecode/register/compiler/functions.ts:1313-1316`) and `compileForOfStatement`
> (`:1396-1399`) close upvalues over `varSlot` only, where `compileWhileStatement` and
> `compileForStatement` close everything at or above `iterationScopeBase`. A binding declared
> inside a `for-of` body and captured by a closure is not closed per iteration. Both also skip
> the instruction entirely when `node.kind === "var"`, which is correct for `var` and
> undetectable from the bytecode afterwards. Cost to fix: the same four lines, replacing
> `varSlot` with a base read before the body. **[unpinned]**. Raised by [Ch 20].

> **Unenforced.** Nothing checks that a slot in `uninitializedLocalSlots` is written before it
> is read on every path — that is what the `TDZ_UNINITIALIZED` sentinel exists to discover at
> run time. The downstream consequence is the one worth naming: the sentinel is not a
> `TaggedValue`, so any tier reading registers without going through `RegisterFrame.getReg` sees
> an object it has no case for. Cost to enforce: definite-assignment analysis, or a uniform
> reader. Raised by [Ch 20]; [Ch 36] and [Ch 37] are where the second reader costs.

> **Never runs.** `LocalBindingKind` includes `"class"`
> (`src/bytecode/register/ops/bytecode.ts:166`) and `setLocalBindingKind` gives it the same TDZ
> registration as `let` and `const`, but no call site in `src/` passes `"class"`: a class
> binding at function scope is created by `addLocal` + `scope.define`
> (`src/bytecode/register/compiler/functions.ts:977-982`), which records `"temp"` and never
> enters `uninitializedLocalSlots`. So a class name has no temporal dead zone. Cost to remove:
> three lines. Cost to use it: one call site, plus a decision about the synthesised
> `_superClass$<Name>` slots. Raised by [Ch 20].

> **Unenforced.** Nothing checks that `getConstructorStub`'s closure and the constructor's own
> bytecode produce the same object on the interpreter road. `Engine.verifyClassShape`
> (`src/api/engine.ts:1168-1178`) checks field *names* against the AOT class table and only when
> compiling ahead of time; the five `analyzeSimpleConstructor` unit tests pin the recogniser,
> not the agreement. Cost to enforce: one differential test that constructs through the stub and
> through the bytecode and compares own properties. Raised by [Ch 20].

### The dispatch loop and the value representation — Ch 21–22

> **Unenforced.** The agreement between `RegisterFrame.directRegisters`
> (`src/bytecode/register/interpreter/frame.ts:82-85`) and `BaselineCompiler`'s `hasClosures`
> (`src/optimizing/baseline/compiler.ts:138-143`) is asserted nowhere: `directRegisters`
> requires `!hasUpvalues && !hasTDZ`, the baseline requires only the absence of three closure
> opcodes. Cost to enforce: one line — route the baseline's decision through the getter, or add
> `uninitializedLocalSlots.size === 0` to `hasClosures` and rename it. Raised by [Ch 21].

> **Never runs.** `RegisterFrame.directRegisters` has no callers: a tree-wide grep over `src/`,
> `tests/`, `tools/` and `data/` returns exactly one hit, its own declaration. It documents a
> contract a second file depends on and that nothing consults. Cost to finish: delete it, or
> make `BaselineCompiler` ask it. Raised by [Ch 21].

> **Dead.** `CALL_NATIVE = 3` (`src/bytecode/register/interpreter/index.ts:180`) is exported,
> never assigned by `updateCallMode`, never compared anywhere in `src/` or `tests/`, and never
> imported. There is no path by which `callMode` can hold it — the native compiler produces a
> standalone binary, not a callee the interpreter can enter. Cost to remove: one line. Raised
> by [Ch 21], [Ch 35].

> **Unenforced.** There is no stack-depth guard on the call path. `interpretCall`
> (`src/bytecode/register/interpreter/index.ts:461-476`) recurses in the host language, so guest
> recursion depth is bounded by the Node process's stack and surfaces as a host `RangeError`
> carrying no tera context. Cost to enforce: a counter on `RegisterInterpreter` beside
> `activeFrames.length`, tested in `interpretCall` — one comparison per call, and the message
> could then name a function. **[unpinned]**. Raised by [Ch 21].

> **Unenforced.** The opcode switch in `runFrame` has no exhaustiveness check, which is how the
> `ROP_TEST_FEEDBACK` gap above went unnoticed. Cost to enforce: a
> `satisfies Record<Opcode, Handler>` dispatch table, or a `default` branch whose parameter is
> typed `never` — the eighty-nine-case switch would have to become a table of functions first.
> Raised by [Ch 21].

> **Unenforced.** `CODE_TO_TAG` and `TAG_TO_CODE` (`src/core/value/index.ts:240-256`,
> `:258-269`) are two independent hand-written tables over the same code set and nothing ties
> either to the `CODE_*` constants; `TAG_TO_CODE`'s five deliberate omissions make an accidental
> omission indistinguishable from an intentional one. Add a `CODE_*` constant and forget
> `CODE_TO_TAG` and `getTag` answers `TAG_UNDEFINED`, because it is
> `CODE_TO_TAG[codeOf(v)] || TAG_UNDEFINED` (`:662-664`). Cost to enforce: derive one table from
> the other, or assert `CODE_TO_TAG.length === CODE_MAX + 1` at module load. Raised by [Ch 22].

> **Dead.** `CODE_MAX` (`src/core/value/index.ts:63`) is exported and referenced by nothing in
> `src/`, `tests/`, `tools/` or `data/` — a tree-wide grep returns one hit, its own definition.
> It is the obvious bound for both tables above and for [Ch 25]'s `MEMBER_LOOKUPS` array, and
> neither uses it. Cost to finish: one assertion per table. Cost to remove: one line. Raised by
> [Ch 22].

> **Unenforced.** `mkSmi` (`src/core/value/index.ts:602-604`) has no precondition check:
> `(n | 0) * TAG_SHIFT_MULT` truncates a fraction, wraps past int32 and turns `NaN` into `0`,
> silently. Every caller is expected to have proved its argument in range and nothing verifies
> that any did. Cost to enforce: a `SMI_MIN`/`SMI_MAX` assertion behind a debug flag, at the cost
> of a comparison on every `mkSmi` call. Raised by [Ch 22].

> **Unenforced.** Nothing on the read path checks that a heap slot is still live. `getPayload`
> answers `undefined` for a swept id and cannot distinguish that from a genuine `undefined`. The
> one validating function, `isTaggedValue` (`src/core/value/index.ts:472-485`), is called on no
> hot path. This is a deliberate trade — checking would cost a `Map.get` on every property read
> — and its price is the entire "prints the wrong number" family of bugs. Raised by [Ch 22].

> **Unenforced.** The identity invariant — that the same payload always yields the same tagged
> value — is upheld by `objectHeapIds` alone and checked by nothing. Nothing in `tests/`
> constructs a `ValueHeap` directly: `sweepHeapPayloads` (`:514-530`), `pinHeapSlot` (`:509-512`),
> `freeHeapObjectSlot` (`:492-507`), `enableExternalLookup` (`:368-379`) and `withValueHeap`
> (`:584-592`) have no unit test and run only end to end. Cost to enforce: one unit test tagging
> the same `JSObject` twice and asserting `===`, plus a `ValueHeap` unit file for the five
> untested methods. **[unpinned]**. Raised by [Ch 22].

### Objects, property access and the member table — Ch 23–25

> **Dead.** `HiddenClass.tryDeprecate` (`src/objects/maps/hidden-class.ts:458-468`), and with it
> `deprecationCount` and `MAX_DEPRECATIONS_BEFORE_FREEZE = 5` (`:21`). No caller in `src/`,
> `tools/` or `tests/`. The three symbols describe a "five deprecations, then freeze" policy the
> engine does not run — `checkStability` deprecates directly at
> `MAX_TRANSITIONS_BEFORE_UNSTABLE * 2`. Cost to finish: decide which of the two policies is
> wanted and delete the other. Raised by [Ch 23].

> **Dead.** `HiddenClass.markUnstable` (`src/objects/maps/hidden-class.ts:370-373`) has no
> caller; `checkStability` sets `isStable = false` inline, so the `this.version++` never happens
> on that path — correct, but correct by accident of the dead function not being called.
> `getStatistics` (`:896-914`) and `getTransitionMetadataPath` (`:738-752`) are dead in the same
> way: both compute a view of the tree nothing asks for. Cost to remove: three methods. Raised
> by [Ch 23].

> **Dead.** `class DescriptorArray` (`src/objects/maps/hidden-class.ts:198-247`) is a complete
> versioned, cloneable, iterable descriptor collection with no consumer in `src/` at all; the
> real storage is the plain `_descMap` above it. It has its own `describe` block in
> `tests/objects/maps/hidden-class.test.ts:39`, so it is maintained without being used. Cost to
> finish: route `_descMap` through it, which would give the `descriptorVersion` field a real
> owner. Cost to remove: the class and its tests. Raised by [Ch 23].

> **Unenforced.** The inline-slot bound is compared in eleven places and one of them breaks the
> pattern: `JSObject.lookupPrototypeChain` (`src/objects/heap/js-object.ts:180`) tests
> `desc.offset < current.slots.length` rather than against the constant, which is equivalent only
> while `slots` is never longer than ten and while an overflow entry is never host-`undefined` —
> a condition `migrateInstance:268` can violate. The constant is also declared a second time in
> `src/objects/heap/js-array.ts:38`. Cost to enforce: one exported predicate and eleven call-site
> edits. Raised by [Ch 23].

> **Never runs.** `JSObject.freeze()`, `seal()` and `preventExtensions()`
> (`src/objects/heap/js-object.ts:547-569`) have no caller in `src/`; the tera builtins set
> booleans on the payload instead (`src/runtime/builtins/index.ts:813-822`, `:831-840`,
> `:850-857`). `HiddenClass.transitionToPreventExtensions`, `transitionToSealed`,
> `transitionToFrozen`, `integrityTransitions`, the `INTEGRITY_*` levels and the `integrityLevel`
> guard at the top of `transition()` are exercised only from tests. Cost to finish: three lines
> — have the builtins call the `JSObject` methods — plus deciding what `Object.isExtensible`
> (`:859-865`) should read. Raised by [Ch 23].

> **Broken.** `delete o.x` succeeds on a frozen object, and reports success either way.
> `handleDeleteProp` (`src/bytecode/register/interpreter/handlers.ts:689-709`) routes to
> `runtimeDeleteProperty`, which consults `desc.configurable` — still `true`, because no
> integrity transition ever ran — and then discards the boolean it returns and answers
> `mkBool(true)` unconditionally. It never checks `_frozen` or `_sealed` either. Re-verified
> 2026-09-08: `o = {x: 1}` / `Object.freeze(o)` / `print(delete o.x)` / `print(o.x)` prints
> `true` then `undefined`, exit 0. Cost to fix: one `return` line for the reported boolean, and a
> decision about which of the two frozen representations is the truth. **[unpinned]** — no test
> covers freeze-then-delete. Raised by [Ch 23], [Ch 24].

> **Dead.** `HiddenClass.dump` (`src/objects/maps/hidden-class.ts:847-894`),
> `collectTransitionTree` (`:773-778`) and `_buildTreeLines` (`:780-821`) render the transition
> tree as indented text and have no caller anywhere in `src/`, `tools/` or `tests/`. Nothing in
> the CLI or the tracer can print a transition tree, which is the one diagnostic [Ch 23] most
> wants and cannot show. Cost to finish: a `--print-maps` flag and one call site. Raised by
> [Ch 23].

> **Unenforced.** `JSArray.getProperty("length")` returns a raw host `number`, not a
> `TaggedValue` — the declared return type `TaggedValue | number | undefined`
> (`src/objects/heap/js-array.ts:442`) says so. Both current callers intercept `"length"` first,
> so the untagged value never escapes; that is coincidence, not construction, and a third caller
> would ship a bare `5` where `getTag(5)` answers `"double"`. Cost to fix: one `mkNumber` and a
> narrowed return type. Raised by [Ch 23].

> **Broken.** `HiddenClassRegistry.getInitialMap` (`src/objects/maps/hidden-class.ts:92-99`)
> stores its pseudo-transition under the key `` `@@${instanceType}` `` in `root.transitions` —
> the same table ordinary property names transition through. A plain object that gains a property
> literally named `@@JS_MAP`, after any `Map` has been constructed, transitions to the `Map`
> instance's initial map: the assigned value is silently dropped and the object then claims
> `instanceType === "JS_MAP"`, so [Ch 24]'s `size` branch dereferences a missing `_mapData` and
> the process exits 1 with a raw host message. Cost to fix: a separate `Map` for instance-type
> edges, or a key character the lexer cannot produce. **[unpinned]**. Raised by [Ch 23].

> **Unfinished.** Accessor properties are outside the feedback and inline-cache system entirely:
> `handleLdaProp` (`src/bytecode/register/interpreter/handlers.ts:205-227`) returns from both
> accessor branches before `ic.lookup`, `recordPropertyFeedback` (`:128`, `:138`) returns early
> on `kind === "accessor"`, and there is no accessor handler among the five property-handler
> kinds in `src/feedback/ic/index.ts:42-47`. A getter can therefore never be inlined or
> speculated on by [Ch 49]. Cost to finish: a handler that caches *which getter* rather than
> which offset, plus a dependency on the accessor's map. Raised by [Ch 24].

> **Dead.** `src/bytecode/register/interpreter/handlers.ts:38-39` imports
> `INSTANCE_TYPE_NUMBER_WRAPPER` and `INSTANCE_TYPE_BOOLEAN_WRAPPER`; neither appears anywhere
> else in the file, whose only `instanceType` comparisons are `INSTANCE_TYPE_MAP` (`:231`),
> `INSTANCE_TYPE_SET` (`:232`) and `INSTANCE_TYPE_STRING_WRAPPER` (`:237`). Both wrappers get
> their members from their prototypes by the ordinary route, so nothing is broken; the imports
> are the residue of a symmetry never built. Cost to remove: two lines. Raised by [Ch 24].

> **Unenforced.** Symbol-keyed properties bypass the hidden class completely — no transition, no
> appearance in `getOwnPropertyNames`, no descriptor, no offset, no map version, and therefore
> never inline-cacheable. Nothing in the source states that invariant; it is visible only as the
> absence of a `symbolProperties` field from `HiddenClass` and its presence on `JSObject` and
> `JSArray`. **[unpinned]**. Raised by [Ch 24].

> **Unenforced.** `handleLdaProp` and `runtimeGetProperty` are two independent implementations of
> one ordering and nothing checks that they stay in step — they already differ over symbol keys,
> the invariant checks, the `_index` hook, the nullish-receiver answer, the string-wrapper fast
> path, the feedback records and the inline cache, and a single access can traverse both. The only
> thing keeping them agreeing is `tests/e2e/optimizing/member-access.test.ts`'s cross-tier
> differential. Cost to enforce: one implementation, or a differential test per shape. Raised by
> [Ch 24].

> **Unfinished.** Because `makeFunctionMethod` runs on every access, `f.call` allocates a
> `RuntimeFunctionPayload` and a `ValueHeap` slot each time it is read, and `f.call === f.call`
> is false. Cost to finish: memoise the three on the payload beside `properties` — one lazy
> field. **[unpinned]**. Raised by [Ch 24].

> **Unenforced.** `InterpreterLike` (`src/bytecode/register/interpreter/handlers.ts:77-101`) is a
> hand-written structural copy of the twelve interpreter members these handlers use. It is not
> derived from `RegisterInterpreter` and there is no `satisfies` clause linking them, so the two
> can drift until a call fails at run time. [Ch 21] names this as the price of lifting the ten
> opcodes out of the dispatch switch. Cost to enforce: one `satisfies` clause. Raised by [Ch 24].

> **Unenforced.** Nothing checks that the four holes in `MEMBER_LOOKUPS` plus `CODE_SYMBOL` are
> exactly the kinds whose callers resolve them: `lookupTable` fills the gaps with `undefined` and
> `memberLookupValue` reads `undefined` as "decline", so a new tag code silently inherits the
> decline path. Cost to enforce: an exhaustiveness constraint over the code space at
> `src/runtime/member-lookup.ts:139-150` — a `satisfies`-style assertion that filled codes plus a
> hand-written `RESOLVED_BY_CALLER` set cover `0..CODE_MAX`. Raised by [Ch 25].

> **Unenforced.** The three-answer contract of `memberLookupValue` is a convention, not a type:
> the declared return is `TaggedValue | null` and `mkUndefined()` is an ordinary `TaggedValue`,
> so a table entry returning `mkUndefined()` where it should return `null` type-checks. Only
> `tests/runtime/member-lookup.test.ts` distinguishes the cases. Cost to enforce: a branded
> return — `{ kind: "declined" } | { kind: "value"; value: TaggedValue }` — and an unwrap at three
> call sites. Raised by [Ch 25].

> **Unenforced.** `asGeneratorMemberInterpreter` and `asPromiseMemberInterpreter` decide "is this
> an interpreter" by probing for a `runFrame` function and a `suspendedFrames` `Map`; any object
> with those two members passes, and the test file relies on it — the generator fixture at
> `tests/runtime/member-lookup.test.ts:72-75` is built from exactly those two members. Cost to
> enforce: a nominal brand on the interpreter, and a change to every synthetic interpreter in
> `tests/`. Raised by [Ch 25].

> **Unfinished.** `src/optimizing/baseline/runtime.ts:463-473` duplicates `stringMember`'s
> own-member arithmetic instead of calling `memberLookupValue`. Cost to finish: routing the
> keyed-string path through the table, which requires reconciling two index policies first —
> `elementIndex` uses `Number(propName)` filtered by `Number.isInteger`, the baseline's fast path
> (`:459`) short-circuits on `isSmi(index)` before it builds a string key, and the two are
> untested against each other outside the integers that fit in a Smi. Raised by [Ch 25].

> **Unenforced.** Three implementations of "a string's own members" exist —
> `src/runtime/member-lookup.ts:88-97`, `src/optimizing/baseline/runtime.ts:463-473` and
> `src/bytecode/register/interpreter/handlers.ts:235-248` — and nothing derives any from the
> others or asserts they agree. The third is structurally hard to remove: the table is indexed by
> tag code and a string wrapper's tag code is `CODE_OBJECT`. Cost to enforce: a differential test
> over a receiver corpus. Raised by [Ch 25].

### Indexing, exotics, exceptions and the host boundary — Ch 26–30

> **Unfinished.** `JSArray.setIndex` (`src/objects/heap/js-array.ts:115-118`) returns silently
> when an index is still negative after wrapping — a dropped write with no diagnostic, where
> `indexValue`'s index branch (`src/runtime/indexing.ts:29-32`) would have raised
> `Index -99 is out of bounds for array of length 3`. Cost to finish: a decision about which
> policy a keyed *store* follows, then either a throw here or a range check at the two
> `ROP_STA_INDEX` call sites. **[unpinned]**. Raised by [Ch 26].

> **Unenforced.** `setFunctionMember` (`src/objects/exotic/function-members.ts:140-157`) calls
> `assertFunctionMemberAccess` only when `resolveFunctionSlot` found an **accessor** slot; for a
> data slot — every static field — it falls through to `fn.properties[propName] = value` with no
> check, so a `private static` or `protected static` field can be overwritten by any code that
> can name the class. The read path (`:118-120`) is guarded and the write path is not. Cost to
> enforce: move the assert above the `slot?.kind === "accessor"` test, plus a decision about
> `enforceAccess = false`. Nothing in `tests/` writes to a restricted static. Raised by [Ch 26].

> **Unenforced.** Class visibility is decided by string comparison of `ownerNameOf`
> (`src/runtime/class-access.ts:175-177`), so two classes with the same `classOwnerName` — in
> different modules, both anonymous, or one shadowing the other — are the same owner for
> `private` and the same waypoint for `protected`. Nothing checks owner-name uniqueness: it is a
> plain optional string on the payload, the module graph does not qualify it, and no constraint
> or test asserts two classes cannot collide. Cost to enforce: a stable per-declaration identity
> threaded through `classOwnerName`, `currentClassOwnerName` and both visibility tables. Raised by
> [Ch 26].

> **Unfinished.** `src/objects/exotic/proxy-ops.ts` dispatches nine traps and implements four
> invariant checks across three of them — two for `get` (`:414`, `:421`), one for `has` (`:599`),
> one for `deleteProperty` (`:661`). The other six dispatch with no verification, and
> `getPrototypeOf` has no trap dispatch at all. Each missing check is the shape of the four that
> exist, so the cost is mechanical: read the target's own descriptor, compare, throw a verbatim
> message. The four that exist are unpinned. **[unpinned]**. Raised by [Ch 26].

> **Unenforced.** `src/gc/roots.ts:197-203` seeds `_primitiveValue`, `_mapData` and `_setData` by
> name, and the `PayloadLike` type it reads them through (`:62-64`) names exactly those three;
> `CollectionObject` (`src/objects/heap/factory.ts:26-31`) has a fourth, `_weakMapData`. Nothing
> derives this list from `factory.ts` and nothing fails when they drift — a new exotic with a new
> side field is invisible to the collector until someone remembers a branch. Cost to enforce: a
> `satisfies` constraint tying `PayloadLike`'s collection fields to `CollectionObject`'s. Raised
> by [Ch 26], [Ch 32].

> **Broken.** `EphemeronHashTable` (`src/objects/heap/js-collections.ts:249-357`) implements no
> ephemeron algorithm. Its `_keys` and `_vals` are plain arrays, and `markReachableHeapIds`
> (`src/gc/roots.ts:109-226`) never walks `_weakMapData`, so **neither** half of the ephemeron
> rule holds: a value is not kept alive by a live key, and an entry is never reclaimed when its
> key dies, so a long-lived `WeakMap` grows monotonically. The name is [Conventions § 4]'s
> canonical case. Cost to fix: a marking fixpoint hooked into [Ch 31]'s mark phase plus
> registration of every live table with the collector so entries can be cleared on sweep. There is
> no test — `tests/runtime/intrinsics/collection-methods.test.ts` exercises `WEAKMAP_METHODS` for
> four cases and none of them collects anything. **[unpinned]**. Raised by [Ch 26]; carried into
> this appendix from the subsystem survey, where it was attributed to [Ch 31].

> **Unenforced.** `_heapIds` is an `Int32Array` (`src/objects/heap/js-collections.ts:251`) while
> `nextHeapPayloadId` is an unbounded JavaScript number, so a heap id past 2^31 is truncated and
> can be stored as a negative — including as `EPH_DELETED = -1` or `EPH_EMPTY = 0` (`:246-247`),
> the two sentinels. Nothing checks the bound; it needs upwards of two billion allocations in one
> process to reach. Cost to enforce: a `Float64Array` for `_heapIds`, or a range assertion in
> `set`. Raised by [Ch 26].

> **Unenforced.** The error reshaping at `src/bytecode/register/interpreter/index.ts:2480-2502`
> assumes every engine-internal message begins with `SomethingError: `. A message that does not
> match keeps the bare `"Error"` name and the whole text, silently; worse, a *tera* string that
> happens to match is re-split, so `throw Error("RangeError: index")` from tera source arrives in
> the `catch` clause with `name === "RangeError"`. No test covers a mismatching or a falsely
> matching message. Cost to enforce: carry the name in a field on a wrapper type instead of inside
> the text, which means touching every producer. Raised by [Ch 27].

> **Broken.** `break` and `continue` do not run enclosing `finally` blocks and do not pop the
> handlers they jump out of. `compileBreakStatement`
> (`src/bytecode/register/compiler/statements.ts:551-559`) and `compileContinueStatement`
> (`:654-666`) emit a bare `ROP_JUMP`; only `compileReturnStatement` (`:461-471`) reads
> `_finallyBlocks`. Re-verified 2026-09-08: a `while` loop whose body is
> `try: break` / `finally: print(99)` prints nothing before returning — the finalizer never runs,
> exit 0. Cost to fix: hoist the finalizer-inlining loop out of `compileReturnStatement` into a
> shared helper and call it from all three, plus a way for break/continue to know how many
> `TryEnd`s to emit for regions they exit that have no `finally`. Raised by [Ch 27].

> **Unenforced.** The `throw` branch pops the top handler without checking that its `catchPC`
> belongs to a region containing the suspension point, so a generator suspended outside any `try`
> but still carrying a handler from a region an unbalanced `break` left behind resumes at a catch
> target it never entered. Cost to enforce: store `endPC` alongside `catchPC` — the field already
> exists in `ExceptionHandlerRecord` and is never written — and range-check before popping.
> **[unpinned]**: no test throws into a suspended generator at all. Raised by [Ch 27].

> **Unfinished.** `requiresInterpreterOnly` (`src/bytecode/register/interpreter/helpers.ts:82-89`)
> rescans the entire instruction array at each of its five call sites, on every tiering decision,
> for the life of the process, although the array is immutable after bytecode compilation. This is
> not measured ([Conventions § 9]). Cost to finish: one nullable boolean field on
> `RegisterCompiledFunction`. Raised by [Ch 27].

> **Unenforced.** `INTERPRETER_ONLY_OPS` (`src/bytecode/register/interpreter/helpers.ts:67-80`) is
> a hand-maintained `Set` literal and nothing keeps it in step with what the baseline and the JIT
> can emit; `tests/bytecode/register/interpreter/helpers.test.ts` samples it rather than deriving
> it. The duplication is already visible: `src/optimizing/baseline/compiler.ts:61-69` re-checks
> three opcodes the predicate has already excluded, and `:70-79` lists five more the baseline
> declines that are not in the set at all. Cost to enforce: derive both lists from one table of
> per-opcode tier support — a per-opcode capability record the tree does not have. Raised by
> [Ch 27].

> **Unenforced.** No test asserts that a function containing one of the twelve interpreter-only
> opcodes fails to *reach* baseline, the JIT or OSR; the set is tested at the predicate, never at
> the gate. **[unpinned]** — the closest observable is `--trace-opt`, which prints a full
> compilation trace for a plain numeric loop and nothing at all when the identical body is wrapped
> in a `try`. Cost to enforce: one e2e assertion per gate. Raised by [Ch 27].

> **Unenforced.** The two-spelling rule is a regex, not a policy: `spellings`
> (`src/utils/naming.ts:12-15`) yields a camel alias only when the registry key is already
> camelCase, so `Array.isArray` has two names and `Number.is_integer`
> (`src/runtime/builtins/index.ts:369`) has one. Nothing asserts a convention across the
> registry's namespaces or warns when a new snake-cased key loses its alias. Cost to enforce: a
> `satisfies` constraint over the namespace literals, or a test walking `builtins`. Raised by
> [Ch 28].

> **Unfinished.** A namespace is a function value that cannot be called: `builtinValue`
> (`src/runtime/builtins/index.ts:169-177`) ends with `mkFunction({ name, properties })` — a
> payload with `properties` and no `call` and no `construct` — so `typeof(Math)`, `typeof(JSON)`
> and `typeof(console)` all answer `"function"` where JavaScript answers `"object"`, and `Math(1)`
> fails with `Cannot call function: Math`. Cost to finish: give namespaces a hidden class, a
> prototype and a `CODE_OBJECT` tag, which takes them out of the payload path `functionValue` and
> `spellOut` share with real callables. Nothing pins either behaviour. **[unpinned]**. Raised by
> [Ch 28].

> **Broken.** `tests/runtime/intrinsics/collection-methods.test.ts:249-253` is titled
> `"get returns undefined for missing key"` and its body asserts `toBe(mkNull())`. The assertion
> is right and the title is wrong; in a codebase with 26 comment lines in 120,822, where
> [Conventions § 8] makes a test title the design document, a title contradicting its own
> assertion is actively misleading. Cost to fix: a rename, one line. Raised by [Ch 28].

> **Unenforced.** Nothing checks that `BUILTIN_METHOD_DECLARATIONS` and the runtime method tables
> agree on *results*. [t: tests/optimizing/metadata/builtin-methods.test.ts > "backs every
> declared method with a runtime implementation"] proves an implementation exists; no test feeds
> the same receiver to both and compares. The shape of the fix already exists —
> `tests/e2e/language/intrinsic-arguments.test.ts` runs seventeen intrinsic expressions through
> the interpreter and through the host's own method and demands equality. Cost to enforce: the
> same harness pointed at a compiled binary over a receiver-sample list; a test file, not a design
> change. Raised by [Ch 28].

> **Unenforced.** `pure` is a hand-written boolean on twenty rows and nothing verifies it — no
> analysis reads the JavaScript, and the interpreter's payload carries no effect information to
> compare against. A row marked `pure: true` whose implementation mutates its receiver would let
> GVN collapse two calls into one and DCE delete a call whose only purpose was the mutation, with
> no diagnostic. Cost to enforce: effect annotations on the runtime payloads — the extension
> surface [Ch 29] already gives third parties and the engine's own builtins do not use. Raised by
> [Ch 28].

> **Unenforced.** `taggedToNative` (`src/runtime/domain/host.ts:148-150`) returns the raw
> `TaggedValue` — a JavaScript number — when a function value crosses out and `hostAsync` is not
> bound, so host code that asked for a callable receives an integer with no diagnostic. Every CLI
> path binds it, and the two call sites passing `bindHost = false` never marshal a function
> outward, so the branch is unreachable today and nothing says so. Cost to enforce: a one-line
> `throw` that documents the precondition. Raised by [Ch 28].

> **Dead.** The `modelBridge &&` conjunct at `src/runtime/domain/host.ts:160`.
> `src/runtime/domain/model-builtins.ts:263` calls `bindModelBridge(modelBridge)` at module
> evaluation time and that module is imported transitively by `src/runtime/builtins/index.ts:64`,
> so in any process that has a builtin registry the variable is non-null before the first line of
> user code and the guard's false branch cannot be taken. Cost to remove: one identifier. Raised
> by [Ch 28].

> **Unfinished.** A compiler-extension pass's `order` is three values with no tie-break and no
> relation to the host pipeline: `orderRank` (`src/api/extensions.ts:195-199`) maps
> early/normal/late to 0/1/2 and a stable sort keeps insertion order within a rank. Cost to
> finish: naming the built-in passes in the public type — thirty-four middle-end steps on the JIT
> road — which is why it has not been done. Raised by [Ch 29].

> **Unenforced.** Nothing validates a pass's `phase` against the phases anyone drives.
> `TeraCompilerPhase` (`src/api/extensions.ts:7`) has four members and `runCompilerPasses` filters
> with `pass.phase !== phase`, so a misspelled phase — or a valid one nobody drives on the road
> being taken — silently never runs. Cost to enforce: one check in `mergeCompilerExtensions`,
> which already inspects every pass at construction time. Raised by [Ch 29].

> **Unfinished.** Duplicated pass runner: `Engine.runCompilerPasses`
> (`src/api/engine.ts:923-939`) and `Optimizer.runCompilerPasses`
> (`src/optimizing/optimizer.ts:78-93`) have the same body over different fields, and nothing
> keeps the two in step. Cost to finish: one shared helper taking
> `Required<TeraCompilerExtension>`. Raised by [Ch 29].

> **Unenforced.** `installRuntimeIntrinsics` checks only `lowering: "runtime"`, so an intrinsic
> declared `lowering: "global"` — or with `lowering` omitted, the default — is never checked
> against the builtin registry: the call compiles as an ordinary global load and fails at run time
> if the name does not resolve. [t: tests/e2e/api/engine-plugins.test.ts > "rejects runtime
> intrinsic lowering without a runtime handler"] pins the case that *is* checked, and says so in
> its title. Cost to enforce: the same check for the other lowerings. Raised by [Ch 29].

> **Unenforced.** `effects: ["pure"]` is taken on trust: `intrinsicCallMetadata` sets
> `props.readonly` from the declaration alone, and nothing observes the payload's `call` to check
> it. A plug-in that declares a printing function pure gets its output deleted at tier 2 while
> tiers 0 and 1 still print — a tier divergence the plug-in author causes and the engine cannot
> detect. Cost to enforce: there is no cheap version; a debug mode running declared-pure
> intrinsics twice would catch impurity visible in the return value and miss the interesting case.
> Raised by [Ch 29].

> **Never runs.** `TeraCompilerExtension.guards`, `.deopts` and `.effects`
> (`src/api/extensions.ts:71-73`) are carried into `TeraOptimizerPassContext` at
> `src/api/engine.ts:928-930` and `src/optimizing/optimizer.ts:83-85` and read nowhere else in
> `src/`. The engine's own passes never consult a plug-in's `TeraGuardSpec` or
> `TeraEffectMetadata`; only an extension pass can, and only about metadata it supplied itself.
> [t: tests/e2e/api/engine-plugins.test.ts > "exposes guard and deopt metadata to IR optimizer
> passes"] pins visibility, not effect. Cost to finish: a consumer in the engine's own passes.
> Cost to remove: three fields and two carry sites. Raised by [Ch 29].

> **Dead.** `JSPromise.asyncFunctionName` and `JSPromise.resumePc`
> (`src/runtime/async/promise.ts:70-71`, initialised at `:78-79`) are never written or read
> anywhere in `src/` or `tests/` — a grep returns exactly those four lines. They are a fossil of a
> design in which the promise remembered where to resume; what shipped is `AsyncSuspend` carrying
> the `RegisterFrame` itself. Cost to remove: two lines. Raised by [Ch 30].

> **Broken.** `PromiseResolveThenableMicrotask.run`'s `catch`
> (`src/runtime/microtasks/microtask.ts:166-168`) does
> `this.promiseToResolve.reject(mkUndefined())` — it discards the thrown value, so a thenable
> whose `then` throws rejects the adopting promise with `undefined` instead of the reason; the
> same loss happens at `:163` when `then` turns out not to be callable. Cost to fix:
> `errorToTaggedValue(asThrownValue(e))`, which the async path already uses at
> `src/runtime/async/helpers.ts:200`. **[unpinned]** — no test covers a throwing `then`. Raised by
> [Ch 30].

> **Unenforced.** `drain`'s ten-thousand-task budget throws a bare
> `new Error("Microtask queue limit exceeded")` (`src/runtime/microtasks/microtask.ts:342-344`)
> with no promise, no function name and no bytecode offset — the same context-free failure as the
> host `RangeError` in [Ch 21]. The behaviour is pinned; nothing pins the message being useful.
> Cost to enforce: thread the running `Microtask`'s `type` and `label` into the throw, which
> `runOne` already has in hand. Raised by [Ch 30].

> **Never runs.** `MicrotaskPolicy.EXPLICIT` and `MicrotaskPolicy.SCOPED`
> (`src/runtime/microtasks/microtask.ts:11-15`) are reachable only through
> `EngineOptions.microtaskPolicy` or `Engine.setMicrotaskPolicy` (`src/api/engine.ts:1574-1576`);
> no CLI flag sets either and the only construction sites are in
> `tests/runtime/microtasks/microtask-queue.test.ts`. So `performCheckpoint`'s two early returns
> (`:358-359`) and `MicrotasksScope.exit`'s `SCOPED` branch (`:470-472`) never run outside tests.
> The feature works; nothing in the shipped product asks for it. Cost to finish: a flag. Raised by
> [Ch 30].

> **Unenforced.** `Microtask.run` (`src/runtime/microtasks/microtask.ts:78-80`) throws
> `"Microtask.run() is abstract"` at run time; the base is a concrete class, so
> `new Microtask("x")` passes `enqueue`'s `instanceof` check at `:274` and fails only when the
> queue reaches it, at which point the throw escapes `drain`. Cost to enforce: one keyword —
> `abstract`. Raised by [Ch 30].

> **Unfinished.** `blockUntil`'s fallback is a busy loop: if `new SharedArrayBuffer(4)` throws at
> module load, or `Atomics.wait` throws once, `if (!blocking) continue` spins on `monotonicNow()`
> until the deadline. There is no diagnostic, no counter and no way to observe which mode is in
> effect, so a deployment where the buffer cannot be allocated burns a core per `sleep` and looks
> identical from outside. Cost to finish: a one-line trace on the transition and a field on
> `getStats()`. Raised by [Ch 30].

> **Never runs.** `MicrotaskQueue.setRejectionHandler` and the `this.rejectionHandler` branches
> (`src/runtime/microtasks/microtask.ts:438-440`, `:390-392`, `:413-415`). Nothing in `src/`
> installs a handler; the only two callers are tests. The production reporting path is
> `unhandledRejectionReporter`, a different field with a different signature and a different firing
> point — per-event versus per-flush. Cost to finish: route the engine's reporter through it. Cost
> to remove: two branches and the setter. Raised by [Ch 30].

### The collectors and what a root is — Ch 31–32

> **Dead.** `GCHeader.forwarding` (`src/gc/gc.ts:32`) is declared, initialised to `null` at
> `:139`, and never read or assigned anywhere in `src/` or `tests/`. It is a fossil of Cheney's
> algorithm, which this scavenger does not implement and does not need. Cost to remove: one field
> and one initialiser. Raised by [Ch 31].

> **Dead.** `GCHeader.marked` is written exactly once in the whole tree —
> `obj.gcHeader.marked = false` at `src/gc/old-generation.ts:102` — and never set to `true` and
> never read. Liveness during a major collection lives in the caller's `markSet`, not on the
> object. Cost to remove: one field and two lines. Raised by [Ch 31].

> **Dead.** `PRETENURE_SIZE_THRESHOLD = 512` (`src/gc/gc.ts:22`) has no use; `allocate`'s
> `pretenure` argument is a caller-supplied boolean and no size is ever consulted to derive it.
> Cost to remove: one line. Cost to implement the intent: a size estimate per payload kind, which
> does not exist. Raised by [Ch 31].

> **Unenforced.** Nothing requires a heap payload to be created through
> `src/objects/heap/factory.ts`. `new JSArray(...)` is reachable from anywhere and produces an
> array with no `gcHeader`, invisible to the scavenger and silently defeating the store barrier;
> the four sites in `src/objects/heap/js-array.ts` are safe only because of what happens to their
> return values, and no test pins that. Cost to enforce: make the constructors private to
> `factory.ts`, or assert a header at the points that consume an array. Raised by [Ch 31].

> **Broken.** `GenerationalGC.allocate` increments its two counters inconsistently across its
> three exits: the normal path (`src/gc/gc.ts:167-168`) increments both `stats.totalAllocated` and
> `_allocationsSinceGC`, the pretenure path (`:147-151`) increments only the first, and the
> young-generation-overflow path (`:157-160`) increments neither. `--stats` therefore
> under-reports allocations exactly when the heap is under pressure, and `needsCollection()` —
> which reads `_allocationsSinceGC` — under-counts in the same conditions. Cost to fix: two lines.
> No test pins the counters on any of the three paths. **[unpinned]**. Raised by [Ch 31].

> **Dead.** `GenerationalGC.checkSafepoint` (`src/gc/gc.ts:176-183`) has no caller in `src/` or
> `tests/` — a tree-wide grep returns exactly one line, its definition. It is the only reader of
> `needsCollection()` and the only driver of `incrementalMarkingStep()`, so with it dead the
> allocation budget, the adaptive pause tuning and tri-colour incremental marking
> (`src/gc/incremental-marker.ts`) are all unreachable in a normal run. Cost to fix: one call from
> `RegisterInterpreter.onBackEdge`, beside the `_maybeSweepHeapPayloads` call already there — and
> then a measurement, because nothing in this tree has ever run with it enabled. Raised by
> [Ch 31]; this is the "incremental marking is never stepped" item the subsystem survey carried.

> **Never runs.** `GenerationalGC.minorGC` and `majorGC` are reachable only through
> `collectGarbage` (`src/gc/gc.ts:336-343`), whose callers are `Engine.collectGarbage`
> (`src/api/engine.ts:1959`) and the two CLI natives — `gc()` behind `--expose-gc` and
> `%CollectGarbage` behind `--allow-natives-syntax` (`src/cli/natives.ts:106-118`, `:80-86`) —
> plus the retry inside `allocate` when a semispace fills. A tera program that neither calls
> `gc()` nor allocates 524,288 managed objects never scavenges. Cost to fix: the `checkSafepoint`
> call above. Raised by [Ch 31].

> **Never runs.** `OldGeneration.markSweep` (`src/gc/old-generation.ts:136-139`) is a one-line
> adapter over `markCompact` with no caller anywhere; `OldGeneration.compact` (`:141-162`) and
> `growthRate` (`:164-167`) have callers only in `tests/gc/old-generation.test.ts`, and
> `RememberedSet.remove` (`src/gc/remembered-set.ts:14-16`) and `filterDead` (`:32-36`) only in
> `tests/gc/remembered-set.test.ts`. The defragmentation pass `compact` implements is never
> triggered by the collector, which evacuates instead. Cost to remove: five methods and the tests
> that exercise them [t: tests/gc/old-generation.test.ts > "defragments when fragmentation exceeds
> 30%"]. Raised by [Ch 31].

> **Broken.** `collectLiveHeapIds` (`src/gc/roots.ts:285-334`) — the walker `majorGC` and
> `finishIncrementalMajorGC` hand to `sweepHeapPayloads` (`src/gc/gc.ts:321-322`, `:404-405`) —
> follows only `payload.source` (`trackValue`, `:292-299`). It never walks an object's `slots`, an
> array's `elements`, `overflowProperties`, `properties`, `closure.cells` or
> `compiled.constants`, all of which `markReachableHeapIds` does walk; it also takes no
> `microtaskQueue` parameter (`:285-289`), so a pending microtask's values are not live during a
> major collection either. A major collection therefore frees the handle of any payload reachable
> only through a field and the program reads a dangling slot. Re-verified 2026-09-08:
> `node dist/cli.js --expose-gc` on `o = {s: "hi", n: 1.5}` / `gc(1)` / `print(o.n)` prints
> `undefined`, exit 0, no diagnostic. Cost to fix: call
> `markReachableHeapIds(this.interpreter, this.globalCells, this.microtaskQueue, this.valueHeap)`
> at both sites — the deeper walker already exists and is what the back-edge sweep uses. No test
> covers a major collection's handle sweep. **[unpinned]**. Raised by [Ch 31], [Ch 32].

> **Unenforced.** `heapPayloadLiveBytesEstimate` (`src/core/value/index.ts:552-554`) returns
> `this.heapPayloads.length - this.heapFreeList.length` — a slot **count** — and is compared
> against a constant named `MIN_HEAP_SWEEP_BYTES`. Both names say bytes; both values are entries.
> The behaviour is coherent and only the names are wrong, but nothing checks the units and a
> future estimator returning real bytes would silently change the interval by a large factor. Cost
> to enforce: rename two symbols. Raised by [Ch 31].

> **Unfinished.** The handle sweep has two poll sites and no third: nothing in
> `src/optimizing/backends/wasm/` calls `_maybeSweepHeapPayloads`, so a loop running entirely
> inside JIT-compiled wasm performs no handle sweep of its own and depends on eventually returning
> to a tier that does. Cost to finish: a poll in the wasm back-edge path, plus a decision about
> what the wasm frame must export first. **[unpinned]**. Raised by [Ch 31].

> **Unfinished.** Once `startIncrementalMajorGC` (`src/gc/gc.ts:345-367`) has run, three things
> become permanent for the life of the process: `_incrementalMajorGCActive` stays `true` because
> only `finishIncrementalMajorGC` clears it (`:418`) and that is reachable only from
> `incrementalMarkingStep`; `isIncrementalMarkingActive()` therefore returns `true` forever,
> adding a branch and a call to every `storeBarrier` (`src/gc/write-barrier.ts:41-43`); and
> `incrementalMarker.worklist` holds a strong reference to every old-generation object and every
> object that was in from-space at the trigger (`:361-366`) with nothing left to drain it.
> `majorGC` does not clear the flag either. Cost to finish: one `checkSafepoint` call from the
> back edge, plus a decision about whether `majorGC` should abandon an in-flight cycle
> [t: tests/gc/gc.test.ts > "full lifecycle: start → steps → finish sweeps old gen"] — which is the
> only place the cycle has ever completed. Raised by [Ch 31].

> **Dead.** The `gc` entry in `CATEGORY_STYLES` (`src/core/tracing/index.ts:28`) is never matched:
> all six GC trace sites pass the string `"GC"` and `--trace-gc` registers the category `"GC"`
> (`src/cli/spec.ts:119`), so `formatMessage` (`src/core/tracing/index.ts:104-114`) always falls
> through to its default branch. The output is identical only because that branch upper-cases the
> category and the default colour happens to match. Cost to fix: one lower-cased string. Raised by
> [Ch 31].

> **Unenforced.** `visitFrameRoots` (`src/gc/roots.ts:73-93`) does not visit
> `RegisterFrame.thisValue` or `RegisterFrame.originalArgs`. It has not bitten for two incidental
> reasons — a receiver is normally also live in a caller's register, and arguments are copied into
> the frame's own registers — but the copy is bounded by the declared arity
> (`src/bytecode/register/interpreter/frame.ts:77-79`), so an argument passed beyond the declared
> parameter count lives *only* in `originalArgs` and is invisible to every walker in the file.
> Cost to enforce: two lines in `visitFrameRoots`, plus a decision about whether pinning
> `originalArgs` for the frame's whole lifetime is acceptable. Raised by [Ch 32].

> **Unenforced.** `registerExternalRootProvider` writes into a module-global `Set` with no
> deregistration and no engine scoping: two `Engine`s in one process share the provider set, a
> provider whose backend was torn down keeps being called, and a provider that throws takes the
> collection down. There is exactly one provider in the tree
> (`src/optimizing/backends/wasm/codegen.ts:177-181`), registered at module load, and no test
> exercises the external-root path. Cost to enforce: a returned unregister function and a
> `WeakRef` or engine-scoped registry. **[unpinned]**. Raised by [Ch 32].

> **Unenforced.** No walker follows an `AccessorPair`. Cost to enforce: two `if` branches in
> `visitFrameRoots`'s transitive step and two in `JSObject.visitReferences`, plus a decision about
> whether `AccessorPair` should carry a `gcHeader` of its own so the generational collector can
> see it too. Raised by [Ch 32].

> **Unenforced.** `PayloadLike` (`src/gc/roots.ts:62-64`) does not name
> `RuntimeFunctionPayload.accessors` or `.staticBase`, so a function-level accessor and a static
> member inherited through a class's `staticBase` chain are outside every walk. Cost to enforce:
> two entries in the worklist loop; the deeper cost is that `PayloadLike` is a hand-maintained
> subset of a payload type it is never checked against — the same shape as the
> `_mapData`/`_setData` item above. Raised by [Ch 32].

> **Unenforced.** The microtask root walk matches four field names, two of which exist nowhere: a
> queued `PromiseResolveThenableMicrotask` contributes no roots, a queued `CallbackMicrotask`
> contributes none, and every `PromiseReactionMicrotask.reaction` closure — which captures the
> frame it will resume — is matched by nothing. Cost to enforce: a `visitRoots(visit)` method on
> `Microtask` that each subclass overrides — four small methods, and the compiler then complains
> when a fifth subclass is added — or a walker derived from the class list. Raised by [Ch 32].

> **Never runs.** `RegisterFrame.closeUpvalues` and `closeUpvaluesFrom`
> (`src/bytecode/register/interpreter/frame.ts:124-129`, `:131-140`) have callers only in the
> interpreter. The baseline compiler builds its own `UpvalueCell` map
> (`src/optimizing/baseline/compiler.ts:152`, populated at `:382`) and never closes anything in
> it, so a closure created by baseline-compiled code holds an *open* cell for the life of the
> value. It is safe today because an open cell is a view onto `r` and `enter` exported `r` — but
> the two tiers do not agree on upvalue lifetime, nothing reconciles them, and a baseline frame
> that returns while a closure it made is still live keeps that frame's whole register array
> alive. Cost to finish: close the baseline's cells, or state the difference. **[unpinned]**.
> Raised by [Ch 32].

> **Unenforced.** The order inside `_maybeSweepHeapPayloads`
> (`src/bytecode/register/interpreter/index.ts:1343-1356`) is load-bearing: dropping before
> marking would delete frames whose owners the mark is about to prove live. Nothing states the
> ordering, nothing checks it, and it is three adjacent statements in a method with no comment.
> Cost to enforce: an assertion, or a named helper whose signature makes the order impossible to
> get wrong. Raised by [Ch 32].

> **Unenforced.** A fuzzer-derived reproduction for seed 5534 — "object live only in an untracked
> JS location across a GC" — sits entirely commented out at
> `tests/e2e/optimizing/gc-roots.test.ts:124-177`, together with its single case,
> `"agrees across every tier (no use-after-free of a swept payload slot)"`. The bug it reproduced
> is fixed; the test that would notice a regression does not run. Cost to restore: uncommenting
> it, and accepting the 300,000 ms timeout it was written with. **[unpinned]**. Raised by [Ch 32].

### Feedback, inline caches and tiering — Ch 33–35

> **Unfinished.** `FEEDBACK_ALLOCATION` is exported as a kind and
> `FeedbackSlot.recordAllocationSite` (`src/feedback/vector/index.ts:420-423`) accumulates hidden
> class ids into `allocationSiteHCs`, but `initFeedbackVector` never types a slot with it, no
> opcode carries one, and `FeedbackNexus` exposes no allocation hint; its only caller anywhere is
> `tests/feedback/vector.test.ts:332-334`. A complete recorder with no producer and no consumer.
> Cost to finish: a slot on the allocation opcodes, a case in the walk and a hint method on the
> nexus — after deciding what the optimizer would do with it. Raised by [Ch 33].

> **Dead.** Feedback on named and spread calls. `ROP_CALL_NAMED`
> (`src/bytecode/register/interpreter/index.ts:1872-1891`) and `ROP_CALL_METHOD_NAMED`
> (`:1893-1913`) each read `const fbSlotIdx = operands[6];` and never use it; `ROP_CALL_SPREAD`
> (`:1915-1936`) does use it, but `initFeedbackVector` has no case for the opcode so the slot is
> always `null`; `ROP_CALL_SPREAD_NAMED` and `ROP_CALL_METHOD_SPREAD_NAMED` do not read the
> operand at all although the compiler emits one
> (`src/bytecode/register/compiler/expressions.ts:569-578`, `:606-614`). Observable: `add(1, 2)`
> records a call target and `add(1, b=2)` records nothing. Cost to fix: five `case` labels in the
> walk, each naming the right operand index, plus the two `recordCallFeedback` calls the named
> handlers never make. Raised by [Ch 33].

> **Unenforced.** Nothing checks that the operand position `initFeedbackVector` reads for an
> opcode is the position the bytecode compiler emitted, that every opcode consuming a slot at run
> time was given one, or that every slot `allocFeedbackSlot` handed out is typed by something.
> `ROP_LDA_INDEX` from `compileForInStatement` is the counter-example in one direction and the
> four call opcodes above are the counter-examples in the other. Cost to enforce: the per-opcode
> operand-kind table — the same one that would fix `disassemble` — plus an assertion that the set
> of typed slots equals `0..feedbackSlotCount-1`. **[unpinned]**. Raised by [Ch 33]; [Ch 18]
> raises the producing half.

> **Dead.** `getBinaryOperands` (`src/bytecode/register/interpreter/helpers.ts:91-103`) guards
> binary-op recording with `if (fv && !fv.saturated)`. `saturated` is an optional field on the
> *structural* type `FeedbackVectorLike` declared in the same file at `:39`; the real
> `FeedbackVector` class has no such property and nothing assigns one, so the guard is always
> true. Cost to resolve: delete the field, or define a saturation rule — the vector already has
> `getSlotsNeedingRefresh` and `isSettled` looking for a consumer. Raised by [Ch 33].

> **Unfinished.** `FeedbackVector.getSlotsNeedingRefresh` (`src/feedback/vector/index.ts:943-956`),
> `getPolymorphicProfile` (`:924-935`) and `isSettled` (`:937-941`) have no caller in `src/` and
> are exercised only by `tests/feedback/vector.test.ts`. `getPolymorphicProfile` reads
> `slot.mapCounts`, an optional field at `:124` that no recorder ever writes, so its
> `mapDistribution` is always empty. Cost to finish: decide whether a profile-refresh policy is
> wanted, and if so write into `mapCounts` from `recordPropertyAccess`. Raised by [Ch 33].

> **Dead.** `MissingPropertyHandler.execute` (`src/feedback/ic/index.ts:311-313`) returns
> `undefined` and has no caller in `src/`: all three of `PropertyLoadIC.lookup`'s paths test
> `handler.type === "MissingProperty"` and return `{ hit: false, value: undefined }` *instead of*
> calling it (`:611-612`, `:628-629`, `:643-644`), and `_miss` sets `value = undefined` directly
> (`:721-724`). More consequentially, `hit: false` means every caller redoes the work:
> `handleLdaProp` runs `getProperty` and then `lookupPrototypeChain`
> (`src/bytecode/register/interpreter/handlers.ts:267-277`), the very lookup the handler exists to
> avoid. The negative cache is correct, keeps the site out of megamorphic, and shortens nothing.
> Cost to fix: a third result state — `{ cached: true, present: false }` — and a matching branch in
> the four call sites that consume a `LoadLookupResult`. Raised by [Ch 34].

> **Never runs.** `InlineCacheManager.registerHiddenClassUsage`
> (`src/feedback/ic/index.ts:1448-1455`) is the only writer of `hiddenClassToICs` and has no
> caller in `src/` or `tools/` — only `tests/feedback/ic.test.ts:557-564`. Consequently
> `invalidateForHiddenClass` always returns 0 and `invalidateDeprecatedMaps` always iterates
> nothing. Cost to finish: a call from every `getOrCreate` hit site — the four interpreter handlers
> and `BaselineRuntime`'s five — plus a policy for removing entries when a site is invalidated, or
> the index grows for the life of the process. Raised by [Ch 34].

> **Never runs.** `Engine.runAgingCycle` (`src/api/engine.ts:1948-1957`), the only caller of
> `icManager.invalidateDeprecatedMaps`, has no caller in `src/`, `tests/` or `tools/`. Code aging
> is present and unscheduled. Cost to finish: a trigger — a timer, an allocation threshold or a
> tiering-policy hook — and a decision about what "idle" means in a process that may run for eight
> milliseconds. Raised by [Ch 34].

> **Never runs.** `InlineCacheManager.collectStats` (`src/feedback/ic/index.ts:1502-1539`),
> `reportPolymorphism` (`:1541-1562`) and `getJitCandidates` (`:1564-1576`), and
> `PropertyLoadIC.getSortedHandlers` (`:764-767`), `getDominantHandler` (`:769-782`) and
> `getPolymorphicProfile` (`:784-796`), have no caller in `src/`. `--stats` reports the tracer's
> `ic_transitions` and `ic_hits` counters and not one of these; `DOMINANT_HANDLER_RATIO = 0.8`
> (`:24`) exists solely for `getDominantHandler`, whose consumer was never written. Cost to
> finish: a `--stats` section calling `collectStats` — perhaps twenty lines and a decision about
> what a reader would do with the numbers. Raised by [Ch 34].

> **Never runs.** `PropertySiteInlineCache.isSettled` (`src/feedback/ic/index.ts:442-447`) and
> `SETTLED_CALL_THRESHOLD = 100` (`:25`) have no reader anywhere; `MONOMORPHIC_JIT_THRESHOLD = 100`
> (`:23`) sets `jitCandidate`, read only by `getStats`, read only by `collectStats`, which nothing
> calls — so the flag the hundred-hit counter exists to raise is observable only from a test. Cost
> to finish: a tiering-policy hook that treats a settled call site or a hundred-hit monomorphic
> load site as evidence, which is a policy decision ([Ch 35]) rather than a change to this file.
> Cost to remove: four lines and two constants. Raised by [Ch 34].

> **Unfinished.** `LoadElementHandler` and `StoreElementHandler`
> (`src/feedback/ic/index.ts:555-581`) carry an `elementsKind` that neither `execute` reads. Cost
> to finish: one handler class per kind or a kind-indexed dispatch, plus a measurement to justify
> it — and there is no benchmark harness in this tree ([Conventions § 9]), so the honest statement
> is that the specialization is absent and its value is unknown. Raised by [Ch 34].

> **Broken.** The `--trace-ic` line for an element access reports a map that is not a map.
> `ElementSiteInlineCache._addEntry` (`src/feedback/ic/index.ts:402-423`) and
> `ElementLoadIC.lookup` (`:1048-1087`) pass `kindTraceId(elementsKind)` — a hash of the *kind
> name* — into `tracer.icEvent`/`icHit`'s `mapId` parameter, which formats it as `map=HC${mapId}`.
> `stats.tera` prints `[IC] Site #7653696: HIT monomorphic-element-load (map=HC2930259320)`, and
> `2930259320` is `kindTraceId("PACKED_DOUBLE")`. This is [Ch 33]'s `Slot #0` from the other
> direction: a parameter typed `number` that two kinds of identifier are squeezed into. Cost to
> fix: a separate tracer method for element events, or a label parameter. Raised by [Ch 34].

> **Broken.** `ElementLoadIC._miss` (`src/feedback/ic/index.ts:1090-1096`) increments `missCount`
> and returns `{ hit: true, value }`, while the megamorphic arm of `lookup` increments `missCount`
> and then calls `tracer.icHit` (`:1076-1079`). The element caches' own `hitCount`/`missCount` and
> the `ic_hits` counter `--stats` prints therefore disagree about the same event, in opposite
> directions. Nothing reads `hitCount` except `getStats`, which nothing calls, so the damage is
> confined to the trace. Cost to fix: one line each, once someone decides whether a miss that still
> answers correctly is a hit. Raised by [Ch 34].

> **Unenforced.** Nothing checks that a site key is used with only one kind of access: `getICKey`
> is a string concatenation and `handleLdaIndex` deliberately substitutes slot `0` when a
> `ROP_LDA_INDEX` was emitted without a feedback slot, so a `for ... in` element load and an
> unrelated property load can land on the same `InlineCache` bundle. They use different sub-caches
> inside it, so it is harmless today and nothing makes it stay harmless. Cost to enforce: give the
> bundle the kind it was created for and assert on mismatch, which needs the per-opcode operand
> table [Ch 33] also asked for. **[unpinned]**. Raised by [Ch 34].

> **Never runs.** `CALL_BASELINE` and `CALL_INTERPRETED`
> (`src/bytecode/register/interpreter/index.ts`) are written by `updateCallMode` and never read:
> `callFunction` tests only `CALL_OPTIMIZED`, `CALL_GENERATOR` and `CALL_ASYNC` (`:587`, `:601`,
> `:610`) and otherwise falls through to `tryTierUp` and a bare `if (compiled.baselineCode)`
> (`:631`), which asks the field directly rather than the cached mode. Cost to finish: replace
> `:631` with a `CALL_BASELINE` comparison, which is also the only thing that would make [Ch 36]'s
> `callMode` handover mean anything at run time. Raised by [Ch 35].

> **Unenforced.** Three independent statements of "should this function be optimized?" exist —
> `AdaptiveTieringPolicy.shouldOptimize` (`src/runtime/tiering/adaptive.ts:112-155`), the fallback
> in `execute` and the fallback in `tryTierUp` — and they already disagree: the adaptive one adds a
> feedback-stability gate the fallbacks lack, and the two fallbacks disagree with each other about
> `loopBudgetTriggered`. No test asserts that a program tiers up at the same point through both
> doors. Cost to enforce: give the frozen policy the two methods and delete both fallbacks — larger
> than it looks, because the frozen object is also what `tests/helpers/tiers.ts` hands the engine.
> Raised by [Ch 35].

> **Unenforced.** Two relationships between the interpreter's and the baseline's loop accounting
> are stated nowhere. The baseline's budget charge (`loopSpan * BACK_EDGES_PER_SAFEPOINT`,
> `src/optimizing/baseline/runtime.ts:427`) is meant to reproduce the interpreter's per-back-edge
> charge and does so only when a baseline invocation actually crosses 1,024 back edges; below that
> it charges nothing while the interpreter charges every edge. And the sweep rate is set by two
> unrelated literals sixty-four apart — `BACK_EDGES_PER_SAFEPOINT` (1024,
> `src/runtime/tiering/defaults.ts:1`) and the interpreter's `0xffff` mask
> (`src/bytecode/register/interpreter/index.ts:1364`) — with no constant, comment or test relating
> them. Cost to enforce: one named constant for the sweep period used on both sides, and a test
> running one loop through both tiers and comparing where each sets `loopBudgetExhausted`.
> **[unpinned]**. Raised by [Ch 35].

> **Dead.** The `loopOsrThreshold` arm of `RegisterInterpreter.onBackEdge`
> (`src/bytecode/register/interpreter/index.ts:1371-1373`) —
> `policy ? loopCounter === policy.loopOsrThreshold : false` — is evaluated only when
> `compiledFn.feedbackVector` is falsy, and it never is: every path that can produce a
> `RegisterFrame` calls `initFeedbackVector` first (`:958`, `:474`, `:603`, `:613`, `:1185`,
> `:1116`, `:1270`, and `handlers.ts:538`, `:549`). The threshold is settable from `--always-opt`,
> `--no-opt` and the test helper, and through this path it changes nothing. Cost to remove: the
> ternary's middle arm and the field. Cost to connect: [Ch 37]'s item below, because the policy
> method that would use it never runs either. **[unpinned]**. Raised by [Ch 35], [Ch 37].

> **Never runs.** `AdaptiveTieringPolicy.shouldOSR` (`src/runtime/tiering/adaptive.ts:172-187`) is
> a complete OSR admission policy — cooldown, compile-failure count, `hasOSRReadyFeedback`, the
> `loopOsrThreshold` comparison and a graded `getOSRUrgency` — with a declared slot on the
> interpreter's policy interface (`src/bytecode/register/interpreter/index.ts:198`) so that it
> could be called, and no caller in `src/`. `onBackEdge` decides OSR from the loop budget alone;
> `getOSRUrgency` (`:163-170`), `hasOSRReadyFeedback` (`:217-222`) and `hasOptimizedOSREntry`
> (`:224-226`) exist only to serve it. So `loopOsrThreshold: 30` — the number `docs/README.md:66`
> describes as "loop iterations before entering a running loop" — governs only the dead fallback
> above and a method nothing invokes. Cost to connect: one call in `onBackEdge`. Cost to delete:
> 25 lines and two tests. Raised by [Ch 35], [Ch 37].

> **Never runs.** `AdaptiveTieringPolicy.shouldBaselineCompile`
> (`src/runtime/tiering/adaptive.ts:157-161`) has no caller in `src/`; both `execute`
> (`src/bytecode/register/interpreter/index.ts:1009-1015`) and `tryTierUp` (`:511-517`) inline the
> `invocationCount >= baselineThreshold` comparison and add conditions the method does not have
> (`requiresInterpreterOnly`, `!optimizedCode`). Cost to connect: one call, after reconciling the
> extra conditions. Raised by [Ch 35].

> **Never runs.** `AdaptiveTieringPolicy.getProfileStats`
> (`src/runtime/tiering/adaptive.ts:189-206`) computes thirteen fields including
> `feedbackSettled`, `feedbackStable`, `osrFeedbackReady` and `osrEntryReady` — precisely the
> diagnostic a reader wants when a function refuses to tier up — and has no caller in `src/`.
> `--stats`'s `"tracerStats"` block reports `jit_compilations` and `jit_osr` and nothing about why
> a compilation did not happen. Cost to surface: one branch in the `--stats` printer, conditional
> on the policy being adaptive. Raised by [Ch 35].

### The baseline compiler and OSR — Ch 36–37

> **Unenforced.** The register-compatibility invariant is stated nowhere and checked nowhere:
> `RegisterFrame`'s constructor (`src/bytecode/register/interpreter/frame.ts:51-80`) and
> `BaselineCompiler.generateBody`'s prologue (`src/optimizing/baseline/compiler.ts:145-151`) agree
> by inspection — two expressions over two register counts, in two languages, with no shared
> constant, no assertion and no test comparing them. Cost to enforce: derive both layouts from one
> function, or assert in `$.enter` that every element of `r` is a number. **[unpinned]**. Raised by
> [Ch 36].

> **Broken.** The baseline prologue has no TDZ fill. The interpreter seeds `TDZ_UNINITIALIZED`
> into every slot named by `uninitializedLocalSlots`
> (`src/bytecode/register/interpreter/frame.ts:63-67`); `generateBody`'s prologue
> (`src/optimizing/baseline/compiler.ts:148`) fills every slot with `$.u`, so a baseline-compiled
> function that reads such a slot answers `undefined` where the interpreter throws. tera spells
> neither `let` nor `const`, which is what makes this look unreachable — but `_declareLocal`
> defaults to `"let"` (`src/bytecode/register/compiler/scope.ts:139`) and `setLocalBindingKind`
> adds every `"let"`, `"const"` and `"class"` slot to the set
> (`src/bytecode/register/ops/bytecode.ts:554-558`), so an ordinary **type-annotated** declaration
> lands there; two of the 22 `.tera` files under `docs/example/` and `examples/` baseline-compile a
> function with a non-empty set. Re-verified 2026-09-08 on an eight-line probe reading such a slot
> on a branch above its declaration: `--no-opt` prints `Cannot access 'y' before initialization`
> and exits 1, while `--baseline-threshold 1 --opt-threshold 1000000 --no-osr` prints `undefined`
> and exits 0. Cost to fix: emit a TDZ fill for `compiledFn.uninitializedLocalSlots`, or add those
> slots to `compile`'s refusal scan. **[unpinned]**. Raised by [Ch 36], and depended on as a
> precondition by [Ch 37].

> **Dead.** `BaselineCompiler.emitOp` has working cases for `ROP_REST_ARGS`
> (`src/optimizing/baseline/compiler.ts:432-433`), `ROP_SPREAD_ARRAY` (`:435-436`) and
> `ROP_CALL_SPREAD` (`:444-445`), emitting `$.restArgs`, `$.spreadArray` and `$.callSpread` — and
> `compile`'s second opcode scan (`:70-80`) refuses any function containing one of the three before
> `generateBody` runs, so none of the cases can execute and the three `BaselineRuntime` methods
> behind them (`src/optimizing/baseline/runtime.ts:1039`, `:1047`, `:1076`) are unreachable. A
> decision recorded twice in opposite directions. Cost to resolve: delete three `case` arms and
> three runtime methods, or delete three names from the refusal list and find out whether the
> emitters are correct. Raised by [Ch 36].

> **Unfinished.** `BaselineRuntime.gp`'s cache hit filters a slot with
> `typeof slotValue === "number" ? slotValue : undefined` and then answers `$.u`
> (`src/optimizing/baseline/runtime.ts:293-295`, and the same shape at `:297-299`). A slot holding
> something that is not a number means the cache's assumption about the object's layout is broken,
> and the correct response is to fall through and re-look it up; instead the method substitutes a
> value the program can observe. Cost to fix: replace the two `return`s with a fall-through to the
> `icManager` lookup eight lines below. **[unpinned]**. Raised by [Ch 36].

> **Dead.** `BaselineCode._call3` is created in `compile`
> (`src/optimizing/baseline/compiler.ts:116-124`) and returned by `fastBaselineCall`'s `case 3:`
> arm (`src/optimizing/baseline/runtime.ts:951-952`), but `fastBaselineCall`'s only callers are
> `invokeCall0`, `invokeCall1` and `invokeCall2` (`:835`, `:843`, `:851`); a three-argument
> `ROP_CALL` is emitted as the generic array path (`compiler.ts:292-297`). The only thing that
> mentions `_call3` outside its declaration is
> [t: tests/optimizing/baseline/compiler.test.ts > "creates fast-call variants (_call0, _call1,
> _call2, _call3)"], which asserts it exists. Cost to close: an `invokeCall3` in the runtime and one
> more branch in `emitOp`'s `ROP_CALL` case. Raised by [Ch 36].

> **Unenforced.** Nothing checks that every `var` `generateBody` declares appears in
> `ROOTED_LOCALS`: the prologue emits `var acc,${SCRATCH_LOCALS.join(",")},sp=0`
> (`src/optimizing/baseline/compiler.ts:146`) and the closure emits `ROOTED_LOCALS` (`:155`) — two
> expressions over two constants, related by a spread and by nothing a compiler or a test can see.
> A sixth scratch temporary added to the prologue and forgotten here is an unrooted slot, which is
> exactly the use-after-free the four `gc-roots` tests exist to catch and would catch only by luck.
> `sp` is deliberately excluded and must stay excluded. Cost to enforce: emit the prologue from
> `ROOTED_LOCALS` instead of from `SCRATCH_LOCALS`. Raised by [Ch 36].

> **Unfinished.** `repairFrameStateDominance` (`src/optimizing/passes/osr.ts:276-306`) returns the
> number of substitutions it made and `src/optimizing/optimizer.ts:192` discards it, so the engine
> knows exactly how much resume precision it just gave up, on every compilation, and reports it to
> nobody — not to `--stats`, not to `--trace-turbo`, not to `validateOptimizedGraph` seven lines
> later. The pass runs on **every** compilation, OSR or not. The same silence is a soundness gap
> from the other side: it *silently repairs* exactly the condition — a frame-state value with no
> dominating definition — that the validator downstream exists to report, so that symptom cannot
> surface from the optimizer today. Cost to surface: one `tracer` call on a non-zero count. Raised
> by [Ch 37] and [Ch 40].

> **Unenforced.** Nothing checks that the two `RegisterReader`s agree. `BaselineRuntime.backEdge`'s
> reader cannot produce `TDZ_UNINITIALIZED` — but only because the baseline prologue never writes
> the sentinel, which is the `> **Broken.**` item above and not a check: one tier's bug is the
> other tier's precondition, and neither file says so. The upvalue difference is not covered at
> all: `compile` accepts `ROP_MAKE_CLOSURE`, `ROP_LDA_UPVALUE` and `ROP_STA_UPVALUE`
> (`src/optimizing/baseline/compiler.ts:138-143`, `:188`, `:194`) and `INTERPRETER_ONLY_OPS` does
> not list them, so a baseline frame can hold a captured slot whose live value is in `_ouv` rather
> than in `r`. Cost to enforce: route the baseline reader through a shared helper, or assert in
> `enterOsr` that every element of `args` is a number. **[unpinned]**. Raised by [Ch 37].

> **Broken.** On-stack replacement over a function that has an **open upvalue on a local** answers
> `undefined`. Re-verified 2026-09-08 on the twelve-line probe — an `outer(n)` declaring
> `total = 0`, an inner `bump()` doing `total = total + 1`, called in a `while` loop, returning
> `total` — at `n = 300000`: plain `node dist/cli.js upv.tera` prints `undefined` and
> `--no-osr` prints `300000`. At `n = 100`, below the loop budget, every configuration prints
> `100`, so the trigger is the replacement and not the closure. The entry read is correct — the
> interpreter passes `frame.getReg`, which redirects a captured slot through its open cell — and
> nothing after it is upvalue-aware: `openLoopHeader` builds the candidate slot list from live
> *local slots* (`src/optimizing/builder/cfg-state.ts:99-101`) and neither `applyOsrTransform` nor
> `enterOsr` mentions `openUpvalues`. Not localized further than that. Cost to fix: at minimum,
> refuse the transform when any candidate slot can be captured — one condition in
> `applyOsrTransform`, and one more loop that never tiers up. **[unpinned]**. Raised by [Ch 37].

> **Broken.** `--no-opt` does not stop on-stack replacement, and therefore does not stop the
> program from running in optimized WebAssembly. `buildTiering` (`src/cli/main.ts:49-63`) sets both
> `jitThreshold` and `loopOsrThreshold` to `Number.MAX_SAFE_INTEGER` for `optMode === "none"`, but
> `onBackEdge` (`src/bytecode/register/interpreter/index.ts:1367-1373`) reads `loopOsrThreshold`
> only when `compiledFn.feedbackVector` is falsy, and the vector is installed at `:958` before any
> back edge executes. Re-verified 2026-09-08 on a hot numeric loop:
> `node dist/cli.js --no-opt --stats hotloop.tera` reports `"jit_compilations": 9` and
> `"jit_osr": 1`; adding `--no-osr` removes both. The flag's own summary is
> `never tier up to the optimizing compiler` (`src/cli/spec.ts:199`). Cost to fix: one line — have
> `enterOsr` treat `loopOsrThreshold === Number.MAX_SAFE_INTEGER` as `osrEnabled === false`, or
> make `onBackEdge` consult the policy before the budget. Raised by [Ch 37].

> **Unfinished.** `FeedbackVector.osrUrgency` (`src/feedback/vector/index.ts:787`, `:798`,
> `:809-811`) is only ever incremented and only ever read as `feedback.osrUrgency === 0`
> (`src/runtime/tiering/osr.ts:30`) — a boolean wearing a counter's clothes. Nothing decays it,
> nothing compares it to a threshold, and `AdaptiveTieringPolicy.getOSRUrgency`, which does compute
> a graded urgency, is a different function on a different object that never runs. Cost to finish:
> pick one of the two. Raised by [Ch 37].

> **Unenforced.** `enterOsr` calls `engine.compileOsr(compiledFn, target)` whenever
> `osrCache.get(target)` is `undefined` (`src/runtime/tiering/osr.ts:47-50`) and never writes to
> `osrCache` itself, so a `compileOsr` implementation that forgot to cache its `null` would
> recompile the loop on every budget exhaustion for the life of the program. The contract
> *"compileOsr must cache its answer, including failures"* is stated nowhere; the current
> implementation honours it on all four exits (`src/api/engine.ts:1714-1717`, `:1719-1722`, the
> `catch` at `:1740-1752`, and `:1754`). Cost to enforce: write the negative result in `enterOsr`,
> or state the contract in a type. **[unpinned]**. Raised by [Ch 37].

### SSA, the graph and frame states — Ch 38–40

> **Never runs.** `getDefaultIRNodeIdAllocator` (`src/optimizing/ir/index.ts:57-59`) is exported
> and has zero call sites in `src/`, `tests/` or `tools/`; its sibling
> `getCurrentIRNodeIdAllocator` (`:53-55`) is live, read by the text parser
> (`src/optimizing/ir/text.ts:363`) and by `reserveNodeIds`
> (`src/optimizing/ir/graph-edit.ts:94`). Handing out the *default* allocator rather than the
> *active* one would be a bug in any scoped context, which is presumably why it is never used. Cost
> to remove: three lines. Raised by [Ch 38].

> **Dead.** `CFGBlock.instructions` (`src/optimizing/ir/index.ts:205`, assigned
> `this.instructions = this.nodes` at `:216`). Nothing in `src/` or `tests/` reads it — the
> `block.instructions` reads elsewhere are on MachineIR blocks, a different type with a field of
> the same name. It is a hazard rather than mere waste: `retainNodes`
> (`src/optimizing/ir/graph-edit.ts:56-62`) and `removePhis`
> (`src/optimizing/ir/cfg-edit.ts:161-174`) *reassign* `block.nodes`, at which point the alias
> silently keeps pointing at the pre-deletion array. Cost to remove: two lines. Raised by [Ch 38].

> **Unenforced.** Nothing checks that a `props` key a pass writes is a key any consumer reads, or
> that the value's type matches what the consumer expects: `OPERATIONS` constrains the opcode set
> exhaustively and constrains `props` not at all. A pass writing `node.props.elementKind` where
> every reader looks for `elementsKind` compiles, runs, passes the graph validator and silently
> loses the information — `metadataNumber` answers `null` and the consumer takes its conservative
> branch. Cost to enforce: a per-opcode key schema in the operation table and an audit of all
> eighty-nine keys and their read sites. Raised by [Ch 38].

> **Dead.** `CFGInstruction.rep` (`src/optimizing/ir/index.ts:132`). Every consumer that decides
> something reads `props._rep` instead — representation selection writes it
> (`src/optimizing/passes/repr-selection.ts:627`), the wasm backend reads it
> (`src/optimizing/backends/wasm/graph-support.ts:307`), the graph validator reads it twice
> (`:67`, `:85`), and even `CFGInstruction.toString` reads `props._rep` rather than its own field
> (`index.ts:177`). The five remaining hits either write the field from `props._rep` or copy it
> into another copy of itself. Cost to remove: one field declaration and five assignment sites.
> **[unpinned]** — no test asserts that it is unread. Raised by [Ch 38].

> **Unenforced.** Nothing prevents a pass from assigning `node.inputs[j]` or reassigning
> `node.inputs` directly, which bypasses both the type guard in `addInput`
> (`src/optimizing/ir/index.ts:153-156`) and the use-list bookkeeping in `replaceInput`.
> `src/optimizing/passes/allocation-sinking.ts:204-209` does the first and remembers to push the
> use by hand; `:165` does the second on a node whose use list is about to be discarded. Both are
> right, and nothing at the write site would say so if they were not — the mistake surfaces only
> when a validator next runs, which by default is once, at the end of `Optimizer.build`. Cost to
> enforce: make `inputs` private behind `addInput`/`replaceInput`, and audit the direct writers.
> Raised by [Ch 38].

> **Unfinished.** `parseIR` (`src/optimizing/ir/text.ts:314-423`) reads exactly one function: it
> locates the end of the body with `body.lastIndexOf("}")` (`:336`), so a multi-function dump
> swallows every intermediate `}` as an instruction line and fails with
> `IRTextError: malformed instruction "}"`, while slicing out one `fn … }` parses and round-trips
> byte-identically. A truncated one-function dump fails differently, with
> `IRTextError: unterminated property list`, because a graph attribute happens to end in `}`. Cost
> to finish: a top-level loop over `fn` blocks and a return type change from `CFGFunction` to a
> list of them. Raised by [Ch 38].

> **Unenforced.** `CFGFunction.osrCandidates` records `phiIds` at build time
> (`src/optimizing/builder/ir-builder.ts:405-409`) and no pass updates it when a phi is folded, so
> the record is stale the moment the first `trivial-phi-elimination-early` runs.
> `applyOsrTransform` (`src/optimizing/passes/osr.ts:167-169`) copes by giving up — it declines OSR
> for that loop rather than repairing the record, and `Optimizer.build` then sets
> `graph.bailout = "no osr entry at ${osrOffset}"` (`src/optimizing/optimizer.ts:182`). This is
> live-safe in the shipped order because the OSR transform runs before `runMiddleEnd`; what it
> costs is that a printed post-optimization graph cannot be used as an OSR fixture. Cost to
> enforce: have `eliminateTrivialPhis` rewrite `osrCandidates` alongside the fold — it already
> knows the mapping, in `folds`. Raised by [Ch 39].

> **Unfinished.** `bailOut` (`src/optimizing/builder/ir-builder.ts:132-144`) has two written
> explanations for twelve call sites in `compileInstruction`; the other ten produce
> `unhandled opcode <name> (0x<hex>) at bc:<n>`, which names a bytecode offset the reader has no
> way to map back to a line of their own program. Cost to finish: one sentence per opcode added to
> `UNSUPPORTED_REASONS` — the mechanism is already there and already reached. Raised by [Ch 39].

> **Unenforced.** `graph.bailout ??= reason` keeps the first bail-out and discards every later one,
> so a function hitting two unsupported opcodes reports only the earlier and nothing records that a
> second existed; a user who fixes the reported one is then told about the next, one round trip at a
> time. Compare [Ch 56]'s AOT decline cascade, where both messages are shown. Cost to enforce: turn
> `bailout: string | null` into a list and decide which one the tracer reports. Raised by [Ch 39].

> **Dead.** The *stamping* half of `nodeIdStamper` (`src/optimizing/ir/graph-edit.ts:99-105`).
> Since the ambient allocator became the single counter, a freshly constructed node already holds a
> fresh id and `node.id = allocator.next()` assigns it a second one for no reason; only the
> `reserveNodeIds` call inside it is load-bearing. Cost to remove: an audit of forty-seven call
> sites, which is why it is still there. Raised by [Ch 39].

> **Unfinished.** `--print-ir` shows *that* a node carries a frame state and never *what* it holds.
> `FrameState.toString` (`src/deopt/frame-state.ts:178-198`) and `toCompact` (`:169-176`) render
> the locals, the stack, the caller and the inline marker exactly as a reader would want, and
> `formatIRValue` (`:210-226`) already knows how to print a node as `v27` — and neither is
> reachable from any command: `toCompact` is called only from `FrameStateBuilder.dump`
> (`:284-290`), which nothing in `src/` calls, and `toString` has no caller at all. Cost to finish:
> one branch in `src/optimizing/ir/text.ts` and a flag in `src/cli/spec.ts`. Raised by [Ch 40].

> **Unenforced.** `graph._frameStateIndex` has no staleness marker, no generation counter and no
> assertion: `frameStateReferences` cannot distinguish a fresh index from one four removals out of
> date and answers from whatever is in the field. The only defences are the `maintain` hook and the
> discipline inside `removeDeadChain`, and the only way to discover that a pass got it wrong is a
> refusal much further downstream, in a message that names something else. Cost to enforce: a
> version counter on `CFGFunction` bumped by `remove`, compared on every index query. Raised by
> [Ch 40].

> **Unenforced.** `sunkAllocationIds` (`src/optimizing/ir/frame-state-values.ts:27-35`) walks the
> caller chain with a bare `for (let state = frameState; state; state = state.callerFrameState)` at
> `:31` and carries no `seen` set, so on the cycle its sibling visitors survive it spins forever.
> Its two callers are the validator (`src/optimizing/ir/graph-validator.ts:497`, inside the
> `seen`-guarded `validateFrameStateValues`) and `repairFrameStateDominance`
> (`src/optimizing/passes/osr.ts:289`, just before the `seen`-guarded `visitFrameStateValues`) — so
> the guard the tests pin protects the walk *after* the unguarded one has already returned. Cost to
> enforce: the three lines its sibling at `:56-66` already has — a local `Set`, a `has`, an `add`.
> Raised by [Ch 40].

> **Never runs.** `FrameState.getInlineChain` (`src/deopt/frame-state.ts:133-141`),
> `getInlineDepth` (`:143-151`) and `getLocalsArray` (`:124-131`) have zero call sites in `src/`;
> every consumer — the deoptimizer, the frame materializer, escape analysis, the wasm codegen, the
> validator — writes its own `for (let s = fs; s; s = s.callerFrameState)` loop instead. They have
> tests [t: tests/deopt/frame-state.test.ts > "getInlineChain returns chain from inner to outer"].
> Cost to delete: 27 lines and one `describe` block. Cost to adopt: six loop rewrites. Raised by
> [Ch 40].

> **Never runs.** `FrameStateBuilder` (`src/deopt/frame-state.ts:228-291`) is a
> `capture`/`getState`/`count`/`dump` façade over `FrameState`, with nine tests and zero call sites
> in `src/`; the builder path uses the free functions in `src/optimizing/builder/frame-state.ts` and
> pushes into a plain array that `src/optimizing/optimizer.ts` owns as `this.frameStates`. Cost to
> delete: 64 lines and one `describe` block. Raised by [Ch 40].

> **Never runs.** `FrameState.matches` (`src/deopt/frame-state.ts:153-167`) has eight tests and no
> callers — every `.matches(` in `src/` belongs to `src/feedback/ic/index.ts`. It is also
> incomplete if anyone did adopt it: it compares `compiledFunction`, `bytecodeOffset`, locals and
> stack, but not `thisValue`, `callerFrameState` or `sunkAllocations`, so two frames differing only
> in the receiver or in the inline chain compare equal. Cost to adopt: three more comparisons
> first. Raised by [Ch 40].

> **Unenforced.** Frame states survive `build()`'s validation and then go through the entire
> module-level AOT pipeline in `src/optimizing/drivers/aot.ts` — `closure-conversion`,
> `promise-surface`, `argument-specialization`, `adopt-inferred-types`, and `inlineModuleCalls`,
> which calls `runMiddleEnd` a second time on any graph it rewrote (`aot.ts:657`) — and **nothing
> validates them again**, although every one of those passes can orphan a frame-state value. The
> damage is invisible for two independent reasons: `frame-state-elision` deletes the evidence
> during legalization, and the native target could not have deoptimized anyway. It is still a graph
> invariant broken silently, and the same passes run on graphs whose frame states matter when the
> module pipeline is used for anything speculative. Cost to enforce: call `validateOptimizedGraph`
> (or at minimum `validateFrameStateValueDominanceWith`) after each module stage, threading the
> per-unit `frameStates` array — the units already carry it as `unit.frameStates`. Raised by
> [Ch 40].

### The middle end: the pass manager, the analyses and the transforms — Ch 41–50

> **Unenforced.** Nothing checks that a pass's declared `preserves` is true of what it did.
> `preservesControlFlow` is an assertion by the author, restated in twenty-seven `step(...)`
> calls in `src/optimizing/pipeline.ts`, and a pass that quietly splits a block while claiming
> to preserve dominance will be believed by every pass after it. `--verify` does not close it:
> `verifyAfterPass` (`src/optimizing/infra/pass-manager.ts`) runs `validateGraphInvariants`,
> which checks SSA structure — that uses dominate their definitions, that phi inputs are
> parallel to predecessors — not that a cached analysis still describes the graph. Cost to
> enforce: a debug mode that recomputes each preserved analysis after every pass and compares
> it to the cached one, which is affordable only under a flag. Raised by [Ch 41].

> **Unenforced.** Nothing checks that `outcome.changed` matches reality. There is no
> before/after graph hash, no mutation counter on `CFGFunction` and no assertion;
> `PassManager.run` (`src/optimizing/infra/pass-manager.ts`) takes the pass's word for it, and
> everything downstream of a pass — analysis invalidation, the `maintain` hook, per-pass
> verification — is gated on that boolean, so a pass that mutated and under-reported leaves a
> stale analysis cache and a stale frame-state index behind it. A cheap partial check exists
> and is unused: the tracer already records `nodesBefore` and `nodesAfter`, so a pass reporting
> `unchanged` while the node count moved could be caught for free whenever tracing is on — it
> would not catch a pass that rewires inputs without changing the count, which is the common
> case. Cost to enforce: a structural fingerprint of the graph computed twice per pass under
> `verifyEachPass`. Raised by [Ch 41], [Ch 43] — [Ch 43] meets it as SCCP's `rewrites` count
> being collapsed to a boolean by `step()`'s `changed()` adapter (`pipeline.ts:75-79`).

> **Dead.** The `boolean` arm of `changed()` (`src/optimizing/pipeline.ts:77`) has no producer.
> `changed()` is called from exactly one place — the `step()` adapter — and every function
> `step()` is given returns `number` or `{sunkCount}`; the legalization pipeline does not use
> `step()` at all and builds `{ changed: ... }` itself. Cost to remove: one line and one
> narrowing of `PassResult`. Keeping it costs nothing and admits a pass that wants to report a
> rewrite it did not count. Raised by [Ch 41].

> **Never runs.** `CompilerOptions.optBisect` (`src/optimizing/options.ts:36`, read by the gate
> at `src/optimizing/infra/pass-manager.ts:73`) has no CLI flag. Re-verified 2026-09-08: there
> is no `--opt-bisect-limit` in `src/cli/spec.ts` — `grep -n bisect src/cli/spec.ts` returns
> nothing — and `grep -rn optBisect src/` finds it only in `options.ts` and the gate. The only
> drivers are the library API and `tools/visualizer/src/workers/bisect.ts`. Cost to finish: one
> option in the CLI spec, threaded into `aotCompilerOptions`. [Ch 77] is the chapter that uses
> it. Raised by [Ch 41].

> **Never runs.** `PassTraceRecord.elapsedMs` (`src/optimizing/infra/pass-trace.ts:14`) is
> measured on every traced pass (`infra/pass-manager.ts:101`, stored at `:115`) and pinned by
> [t: tests/optimizing/infra/pass-manager.test.ts > "times each pass it traces"], and
> `formatPassTrace` (`pass-trace.ts:50-60`) never renders it — re-verified 2026-09-08: its
> `facts` array holds the outcome, the node delta and the invalidation list, and no timing. So
> `--print-after-all` prints no timings. The only consumers in the tree are the visualizer's
> `CostView.tsx` and `StageViewer.tsx` through `tools/visualizer/src/services/pass-cost.ts`.
> Cost to finish: one interpolation in `formatPassTrace`, plus a decision about whether
> wall-clock noise belongs in output people diff. Raised by [Ch 41].

> **Never runs.** `CompilerOptions.moduleTracer` (`src/optimizing/options.ts:34`) has no CLI
> flag, so every remark a module-level stage records is unreachable from the command line.
> Re-verified 2026-09-08: `src/optimizing/drivers/aot.ts:674` only *reads* it, nothing in
> `src/` assigns it, and `consoleModuleTracer` (`src/optimizing/drivers/module-trace.ts:26`) is
> exported from `src/index.ts` and called nowhere. The only setter in the tree is
> `tools/visualizer/src/workers/compiler-worker.ts:741`. The consequence [Ch 50] measures: the
> inliner writes seven carefully-worded explanations through `remarks.applied` / `.missed` /
> `.analysis` (`src/optimizing/passes/inlining.ts:311, 329, 336, 343, 351, 363, 366`) including
> the cost arithmetic, and `RemarkRecorder.record` (`src/optimizing/infra/pass-remarks.ts:63-75`)
> returns immediately when `this.scope === null` — a scope is opened only by `PassManager.run`
> under tracing, by the text driver, and by the AOT driver's `stage` helper when
> `opts.moduleTracer !== null` (`drivers/aot.ts:676-679`). So the inliner's explanations exist
> for the compiler visualizer and nothing else. Cost to finish: one flag in `src/cli/spec.ts`
> and the console sink that already exists. Raised by [Ch 41], [Ch 50].

> **Never runs.** `computeReversePostorder` (`src/optimizing/analyses/dominance-core.ts:33-35`)
> is exported and has no caller anywhere — re-verified 2026-09-08, a tree-wide grep over
> `src/`, `tests/` and `tools/` returns exactly one hit, its own definition. `DominatorTree`
> computes the same thing inline by reversing the postorder its constructor already has,
> `Object.freeze([...postorder].reverse())` (`analyses/dominance.ts:23`). Cost to remove: three
> lines, or route `dominance.ts:23` through it. Raised by [Ch 42].

> **Unenforced.** `DominatorTree.frontierOf` (`src/optimizing/analyses/dominance.ts`) has
> exactly one consumer in the tree, `src/optimizing/passes/global-promotion.ts:87`, and no test
> — there is no `frontierOf` case in `tests/optimizing/analyses/dominance.test.ts`. SSA
> construction here does not use dominance frontiers at all ([Ch 39 § one-walk-no-dominators]),
> so the classic Cytron placement algorithm is present without being present for the reason it
> was invented, and its correctness rests on one pass's observed behaviour. Cost to enforce: a
> unit test over the diamond fixture, about ten lines. Raised by [Ch 42].

> **Unenforced.** `TypeInference` (`src/optimizing/analyses/type-inference.ts:25-28`) exposes
> `typeOf` and `isSpeculative` and nothing else: there is no `wasReached(node)` and no
> `isBottomBecauseUnreachable`, so `TypeKind.Never` means both "this value can never exist" and
> "the solver has not visited this node". A pass that folded a branch on the first reading would
> be relying on the second, no pass currently does, and no test would catch one that started.
> Cost to enforce: a `reached` set on the solver — already half-present as `queued` — exposed as
> a third method. Raised by [Ch 42].

> **Never runs.** `productLattice` and `mapLattice` (`src/optimizing/infra/lattice.ts:7`, `:18`)
> have no caller anywhere in `src/` or `tools/`; re-verified 2026-09-08, their only references
> are in `tests/optimizing/infra/lattice.test.ts`. They are correct, tested combinators that
> nothing composes. Cost to finish: a consumer. Cost to remove: the two functions and their
> tests. Raised by [Ch 42].

> **Never runs.** `walkDominatorTree` and `ScopedVisitor` (`src/optimizing/infra/dom-walk.ts:1`,
> `:6`) have no caller outside `tests/optimizing/infra/dom-walk.test.ts`; re-verified
> 2026-09-08. Three passes hand-roll exactly this walk instead — `Narrower.walk`
> (`passes/type-narrowing.ts:276-290`, recursive, with an undo trail), `walkDom`
> (`passes/escape-analysis.ts:314-325`, recursive, forking two `Map`s per child) and `walkBlock`
> (`passes/checks.ts:90-123`, recursive, forking one `Map` per child). Cost to finish: reworking
> three passes onto one iterative walker, which would also remove the stack-depth risk in all
> three — a function with a dominator chain thousands deep would overflow today. Raised by
> [Ch 42].

> **Unfinished.** `solveMonotone` (`src/optimizing/infra/dataflow.ts:25`) has exactly one consumer
> and it is not a middle-end pass: `src/optimizing/machine/verifier.ts:176` uses it for
> machine-IR liveness. Every memory pass in [Ch 45] uses a separate driver,
> `runSnapshotDataflow` (`src/optimizing/infra/snapshot-dataflow.ts:16`), imported by
> `dead-stores.ts`, `intrinsic-cse.ts` and `load-elimination.ts`. Two dataflow frameworks in one
> directory, no shared abstraction, and the general one is used by the verifier rather than by
> any pass. Cost to finish: expressing the snapshot passes as `MonotoneProblem`s, which requires
> `solveMonotone` to expose the per-node state the snapshot driver keeps to itself. Raised by
> [Ch 42].

> **Unenforced.** `UnionFind.find` (`src/optimizing/infra/union-find.ts:11-18`) is recursive and
> has no unit test of its own; it is exercised only through `analyses/aot-legality.ts:481` and
> `passes/string-boxing.ts:175`, both of which build small forests, so the recursion depth has
> never been a problem and nothing would notice if it became one. Cost to enforce: a test file,
> and an iterative `find`. Raised by [Ch 42].

> **Unfinished.** `SccpSolver.evaluate`'s guard case (`src/optimizing/passes/sccp.ts:229-236`) is
> the only case that does not test its input for bottom — every other case either calls
> `anyBottom` or checks the input cell inline as `IR_NOT` does at `:219`. An input the solver has
> not reached yet is `bottom`, fails the `kind !== "constant"` test, and drives the cell straight
> to `top`, irreversibly, since `update` joins and top is absorbing. A `CheckSmi` whose operand is
> a loop phi that later resolves to a constant therefore never forwards, although every other
> opcode in the file recovers from exactly that ordering. Cost to finish: one line,
> `if (this.anyBottom(node)) return cells.bottom;`, in front of the existing test. Raised by
> [Ch 43].

> **Unfinished.** SCCP's fold tables stop short of the opcodes beside them.
> `src/optimizing/ir/operations.ts:110-115` declares `IR_INT32_USHR`, `IR_INT32_OR`,
> `IR_INT32_XOR`, `IR_INT32_NOT` and `IR_FLOAT64_POW`; none appears in `ARITHMETIC`
> (`src/optimizing/passes/sccp.ts:17`), and `OR`, `XOR` and `NOT` are absent from `FOLDABLE`
> (`:282`) even though `SHL`, `SHR` and `AND` are there. All five are foldable in principle. Cost
> to finish: five table rows, plus one decision about `IR_INT32_USHR`, whose result class is
> `RESULT_TAGGED_NUMBER` rather than `RESULT_INT32` (`operations.ts:902`) precisely because an
> unsigned shift can exceed the signed range — folding it needs an answer to what the constant's
> representation is ([Ch 48 § repr-selection]). Raised by [Ch 43].

> **Unfinished.** `IR_GENERIC_ADD` folds only when *both* operands are string constants
> (`src/optimizing/passes/sccp.ts:242-249`). A string plus a numeric constant, which the
> interpreter concatenates without complaint, is left alone. This is deliberate rather than
> forgotten — the coercion rules live in `src/optimizing/passes/string-coercion.ts`, a
> legalization pass at ordinal 33 that knows what a target can represent — but it reads as an
> oversight from inside `sccp.ts`. Cost to finish: a number-to-text spelling inside `sccp.ts`
> that agrees character for character with what `string-coercion.ts` emits per target, plus a
> decision about which of the two owns that rule; the decision, not the code, is the expensive
> half. [t: tests/optimizing/passes/sccp.test.ts > "folds GenericAdd of two string constants"]
> pins the case that does work. Raised by [Ch 43].

> **Unfinished.** `sparseConditionalConstantPropagation` (`src/optimizing/passes/sccp.ts`)
> cannot fold a branch in the same run that folds its condition. `takenSuccessor` asks
> `this.cellOf(terminator.inputs[0])`, and by then a condition that was itself `FOLDABLE` — an
> `Int32Compare`, say — has been replaced by a freshly stamped `Constant` whose id is larger than
> every id the solver recorded; `cellOf` falls through to `?? cells.bottom` and the `Branch`
> survives. It is folded on the *next* run, `sccp-after-escape` at ordinal 13, so the gap is
> closed today only because the pipeline happens to schedule SCCP twice for an unrelated reason.
> Cost to finish: one line seeding the folded node's cell, `this.valueOf.set(folded.id, cell)`,
> at the point of replacement — or reading `takenSuccessor` off the pre-rewrite condition.
> **[unpinned]**: no test covers it; the chapter's probe shows `#9 sccp` leaving
> `v4 = Branch v12` and `#13 sccp-after-escape` turning the same node into
> `v4 = Jump [targetBlock=2]`. Raised by [Ch 43].

> **Unfinished.** `isCongruenceCandidate` requires `node.inputs.length > 0`
> (`src/optimizing/passes/gvn.ts:70`), so a zero-operand effect-free node is never numbered and
> never forwarded. Today that excludes nothing that matters — `IR_CONSTANT` is handled separately
> and `IR_PARAMETER` is in `IDENTITY_VALUED` — but any future nullary pure opcode is silently
> outside GVN, with no diagnostic and no test that would notice. Cost to finish: delete the
> clause and confirm the two existing exclusions still fire, which they do, since both are tested
> earlier in the same function. Raised by [Ch 44].

> **Unfinished.** GVN does no phi congruence. `IR_PHI` is in `IDENTITY_VALUED`
> (`src/optimizing/passes/gvn.ts:16`), so two phis in the same block merging the same values
> along the same edges receive different value numbers and neither is forwarded onto the other.
> Loop headers in this engine routinely carry many phis, one per live bytecode register —
> `_FixedDigits.format` records nineteen in each of its six OSR candidates — so duplicates are
> plausible. Cost to finish: give a phi a key built from its block and its inputs' value numbers,
> which is safe only once you decide what a phi whose inputs are not yet numbered does — the same
> optimistic-versus-pessimistic question [Ch 43] answers for SCCP, and GVN's single
> reverse-postorder sweep is not set up to answer it. Raised by [Ch 44].

> **Unenforced.** `originOf` (`src/optimizing/passes/gvn.ts:343-345`) silently returns the block
> itself for any block not in its map, so a future edit that creates a block without recording an
> origin gets *wrong dominance answers* rather than an error — `dominates` on an unnumbered block
> is `false`, which reads as "not dominated" and could admit a forwarding that is not legal.
> Nothing checks that every block created during the run is in the map. The map also only fixes
> the *asking* side: `LeaderTable.reaching` passes `this.originOf(block)` as the descendant but
> uses `node.block` raw as the ancestor (`gvn.ts:193`), so a leader `materialize` defined inside a
> split block is never found by a later query. That direction fails conservatively, costing a
> missed reuse rather than a wrong one, which is presumably why it has never been noticed. Cost
> to enforce: record the graph's block count on entry and assert that every block beyond it has
> an origin, or route block creation through one helper. Raised by [Ch 44].

> **Unfinished.** GVN-PRE runs once, at ordinal 16, and nothing re-runs it
> (`src/optimizing/passes/gvn.ts`, registered in `src/optimizing/pipeline.ts`). `materialize`
> creates new leaders, so an expression with no reaching definition on the first sweep may have
> one on a second; `anticipate` creates new phis, which are new merge points; and the
> reverse-postorder walk has already passed the blocks where either could be used. Compare
> `string-split-lowering`, which wraps its lowerings in `untilStable`
> (`src/optimizing/target/legalization.ts:67-83`) and is pinned as reaching a fixpoint by
> [t: tests/optimizing/pipeline-order.test.ts > "runs the split lowering to a fixpoint rather
> than once"]. Cost to finish: the same wrapper plus an iteration bound, and a measurement that
> does not exist in this tree — there is no benchmark harness here ([Conventions § 9]), so
> *would a second sweep pay for itself* is currently unanswerable rather than answered no. Raised
> by [Ch 44].

> **Unenforced.** Nothing checks that load elimination's three indexes — `byLocation`, `byBase`
> and `visibleBaseKeys` — agree. `addEntry` (`src/optimizing/passes/load-elimination.ts:244-255`),
> used only by `meetStates`, is a second hand-written copy of `addLocation`'s three-map update
> with the `removeLocation` call dropped; the two are kept in step by hand. Cost to enforce: give
> `MemoryState` a class with `add`/`remove` methods and make `meetStates` call `add`, or assert
> set membership under a debug flag. Raised by [Ch 45].

> **Dead.** `meetPredecessors` (`src/optimizing/passes/intrinsic-cse.ts:70-87`) is a complete,
> correct predecessor-merge function with `sawKnown` bookkeeping and no caller anywhere;
> re-verified 2026-09-08, a tree-wide grep over `src/`, `tests/` and `tools/` returns exactly one
> hit, its own definition. `runSnapshotDataflow`'s `mergeInputs` does the merging now; this is
> what the pass used before it moved onto the shared driver. Cost to remove: eighteen lines. Cost
> to finish: say why the shared `mergeInputs` is not enough for this problem. Raised by [Ch 45].

> **Unenforced.** `replaceValue` (`src/optimizing/passes/escape-analysis.ts:801-815`) takes a
> `graph` parameter and never uses it. It rewrites input edges directly rather than going through
> `replaceValueUses`, so it does **not** call `replaceGraphFrameStateValue` — a frame state naming
> the replaced load would keep naming a node that is about to be detached. The three call sites
> compensate by calling `replaceGraphFrameStateValue` themselves on the very next line (`:253-254`,
> `:280-281`, `:307-308`); nothing enforces that pairing, and the unused `graph` parameter is the
> shape of the fix half-made. Cost to enforce: delete the local helper and call `replaceValueUses`,
> which does both. Raised by [Ch 45].

> **Unenforced.** The invariant "every frame state that names an alias got a `sunkAllocations`
> entry" is maintained by construction inside `recordVirtualState`
> (`src/optimizing/passes/escape-analysis.ts`) and verified by no verifier —
> `validateOptimizedGraph` checks frame-state *value dominance*, not sunk-allocation coverage, so
> an allocation deleted without a snapshot would be found only by a program that bailed out and
> read `undefined`. Cost to enforce: one walk over every frame state after the pass, asking
> whether any deleted id is still named without a matching `sunkAllocations` entry. Raised by
> [Ch 45].

> **Unfinished.** `ObjectMaterializer._resolveValue` (`src/deopt/materializer.ts:77`) returns
> `mkUndefined()` for anything it cannot resolve, and `materialize` iterates `sunkAllocations` in
> insertion order with no topological sort — so a sunk object whose field names a *later* sunk
> object silently gets `undefined` for that field rather than an error, and a cycle between two
> sunk objects cannot be built at all. Cost to finish: sort the map by dependency before the loop,
> or two passes — allocate every object first, then fill fields. Raised by [Ch 45].

> **Broken.** Escape analysis writes array elements into the same `fields` map under **string**
> keys: `initialOffsetState` (`src/optimizing/passes/escape-analysis.ts:501-509`) seeds
> `"elem_i0"`, `"elem_i1"` and so on for an `IR_NEW_ARRAY` and `offsetStateKey` (`:723-739`) keeps
> using them, while `VirtualAllocation.fields` is declared `Map<number, FrameValue>`
> (`src/deopt/frame-state.ts:16-19`) and `recordVirtualState` gets past that with an
> `as Map<number, FrameValue>` cast. Re-verified 2026-09-08: the seeding line and the declared
> key type are both still as described. The materializer then treats every key as a slot index —
> `obj.slots.length <= "elem_i0"` is a NaN comparison and is false, so the growth loop never runs
> and the value is assigned as a *string property of the slots array* — and it always builds a
> `JSObject`, never a `JSArray`. A scalar-replaced array materialized at a bailout therefore comes
> back as a plain object with no elements. Cost to fix: a separate element map on
> `VirtualAllocation`, a `JSArray` branch in `materialize`, and deleting the cast that hid the
> mismatch. **[unpinned]** — the seven tests in `tests/deopt/materializer.test.ts` all use numeric
> offsets or props, and no test materializes an array. Raised by [Ch 45].

> **Unfinished.** `allocationSinking` recognises only `IR_NEW_OBJECT`
> (`src/optimizing/passes/allocation-sinking.ts:47`); re-verified 2026-09-08. An array whose only
> escape is a deopt is never sunk, even though `escapeAnalysisAndScalarReplacement` handles
> `IR_NEW_ARRAY` fully. Cost to finish: element state in `buildVirtualState` and a matching branch
> in `ObjectMaterializer` — which, per the `> **Broken.**` item above, that branch does not have
> yet either. Raised by [Ch 45].

> **Unfinished.** `peelLoopChecks` (`src/optimizing/passes/loop-opts.ts:115`) returns a count of
> *loops peeled*, not nodes peeled, so the pass manager reports "changed" without saying how much,
> and nothing at pass level notices that the pass is a pure code-size regression on its own: it
> depends on the `#20`/`#21` adjacency in `src/optimizing/pipeline.ts` for the in-loop original to
> be deleted afterwards. If that adjacency is ever broken, three pipeline tests are the only thing
> that fails. Cost to finish: have the pass remove the original itself once it has re-asked
> dominance, or assert the adjacency in `tests/optimizing/pipeline-order.test.ts` where the other
> ordering invariants live. Raised by [Ch 46].

> **Never runs.** `loopUnswitching` (`src/optimizing/passes/loop-opts.ts`) cannot fire in the JIT,
> by construction, at any optimization level. `unswitchBudget` is `0` at `none` and `baseline`
> anyway and `48`/`96` at `speed`/`max`, but `src/optimizing/pipeline.ts:110` overrides all four
> to `0` whenever `options.deoptimizes` — re-verified 2026-09-08, the line reads
> `const unswitchBudget = options.deoptimizes ? 0 : options.unswitchBudget;`. The transform is
> fully implemented and has nine unit tests, all of which pass it an explicit budget. Cost to
> deploy: decide whether a tier that can bail out should ever pay for loop duplication, which is a
> policy question the code has already answered "no" without saying so anywhere a reader would
> find it. Raised by [Ch 46].

> **Unfinished.** `narrowRange` (`src/optimizing/passes/checks.ts:363-375`) takes a block and
> ignores it: the narrowing is global, not per-edge. Two consumers read the narrowed map — the
> `noOverflow` stamping loop at `:447-466` and the bounds-check gate at `:638` — so a fact proved
> on one branch could in principle license a stamp or a proof in a block that branch does not
> dominate. It has not been observed doing so, because the true and false narrowings of the same
> comparison intersect to an inverted interval and cancel to unbounded, and because the
> bounds-check path never gets far enough to read the map. Cost to finish: key the ranges by
> (block, node) and merge per predecessor, the same shape as [Ch 45 § a-snapshot-dataflow]'s meet
> — or delete the parameter and state that the narrowing is whole-function. **[unpinned]** — no
> test constructs a narrowing that survives into a non-dominated block. Raised by [Ch 46].

> **Unenforced.** Two bare string comparisons against the opcode name `"LoadArrayLength"`
> (`src/optimizing/passes/checks.ts:592`, `:620`) are what routes 2 and 3 of bounds-check
> elimination match on. Renaming the opcode would silently disable both — no type error would be
> raised, and the pass would go on reporting that it kept every bounds check. Cost to enforce: two
> identifier substitutions, replacing the literals with `ir.IR_LOAD_ARRAY_LENGTH`. **[unpinned]**.
> Raised by [Ch 46].

> **Broken.** `rangeAnalysisAndBoundsCheckElimination` (`src/optimizing/passes/checks.ts:141-738`)
> does not remove a `CheckBounds` produced from tera source. Re-verified 2026-09-08:
> `node dist/cli.js --print-ir --filter total_of docs/example/stats-deopt.tera` still prints
> `v17 = CheckBounds v10, v15` in `B2` after the whole middle end. All four reasons are separate.
> Route 1, the symbolic guard proof, *would* succeed — B2's only predecessor is B3, whose
> terminator `v13 = Branch v12` compares the same SSA value `v10` the check uses. Route 2 cannot
> succeed ever, because `detectInductionVariable` requires an `IR_PHI` and the IR builder always
> wraps the index: `const chkBounds = ir.irCheckBounds(chkSmi, chkKind)`
> (`src/optimizing/builder/ir-builder.ts:1342`, same shape at `:1422` and twice in
> `builder/inline.ts`). Route 3 cannot succeed here, because `arrayLengthNodes` is keyed by the id
> of `LoadArrayLength`'s input — the header's `CheckElementsKind` `v8` — while `CheckBounds`'s
> array input is the body's `v15`. And none of the three is reached: the gate at `checks.ts:638-644`
> demands a finite numeric interval for the index first, and the range walk visits `graph.blocks`
> in list order, putting the body before the header, so the index phi comes out unbounded. Cost to
> fix: reorder the gate so a route-1 `bounded` proof is tried before the numeric precondition,
> **plus** the soundness review deferred since 2026-08-24 — `findLoopGuard` has never been audited
> for whether the guard it finds is against *that array's* length, and the pass removes a
> memory-safety check. This is a review, not a patch. Raised by [Ch 46]; carried into this
> appendix from the subsystem survey, whose one-line version — "the `CheckSmi` wrapper defeats all
> three bounded paths" — is right about route 2 and wrong about the other two.

> **Never runs.** The `BCE-IV` (`src/optimizing/passes/checks.ts:679-682`) and `BCE-Range`
> (`:693-696`) trace messages, and the `remarks.applied` sentence at `:715-718`, describe
> successes the pass cannot reach on any tera program in this tree. Cost to finish: the gate
> reorder in the item above. Cost to remove: three message sites. Raised by [Ch 46].

> **Unenforced.** No test in `tests/` removes a `CheckBounds`. The two tests that exist for the
> pass's bounds path assert *refusals* —
> [t: tests/optimizing/infra/pass-remarks-from-passes.test.ts > "says the index range is unknown
> when the index is an opaque parameter"] and
> [t: tests/optimizing/infra/pass-remarks-from-passes.test.ts > "gives a different reason once the
> index has a known range but no known length"] — and
> `tests/optimizing/passes/checks.test.ts` contains the string `CheckBounds` zero times. The
> success path has no coverage, so the day the gate is fixed there is nothing to tell you whether
> it was fixed correctly. Cost to enforce: one graph-level test that builds a bounded index and
> asserts the check is gone. **[unpinned]**. Raised by [Ch 46].

> **Broken.** `x + 0 → x` is unsound for `IR_FLOAT64_ADD` when `x` is `-0`, and three tiers
> disagree with the interpreter. `simplified` (`src/optimizing/passes/simplify.ts:41-43`) applies
> `identityOperand(node, 0)` to `IR_FLOAT64_ADD` as well as `IR_INT32_ADD`, but IEEE addition is
> not the identity on signed zero: `(-0) + (+0)` is `+0`, so replacing the sum with its left
> operand hands back `-0` where the program computed `+0`. Re-verified 2026-09-08, one run per
> fresh process, on `fn f(x: float) -> float:` / `return x + 0.0` / `print(1.0 / f(-0.0))`:
>
> ```
> node dist/cli.js negzero.tera                                     -> Infinity
> node dist/cli.js --no-opt negzero.tera                            -> Infinity
> node dist/cli.js --opt-threshold 1 --baseline-threshold 1 …       -> -Infinity
> node dist/cli.js compile negzero.tera -o negzero.exe; ./negzero.exe -> -Infinity
> ```
>
> `--print-after-all` names the pass —
> `*** IR after #10 algebraic-simplification [changed, nodes 4 -> 3 (-1), invalidated nothing] ***`
> — and the C backend emits `double f(double p0) { return (double)p0; }`. Cost to fix: one
> condition. Restrict the `0` identity to `IR_INT32_ADD`, or require the surviving operand to be
> proved not-`-0` the way `mayBeMinusZero` already does for `noOverflow`
> (`src/optimizing/passes/checks.ts:435-445`). The `-0` reasoning is already written down in the
> same test file, for `x * 0`; nobody applied it to `x + 0`. **[unpinned]** — no test covers the
> `Float64Add` zero identity in either direction. Raised by [Ch 47].

> **Unenforced.** Nothing in the tree states, checks or tests the invariant that an entry in
> `simplified` (`src/optimizing/passes/simplify.ts:41-43`) must be sound over IEEE doubles. The
> three refusals that exist do so only as `it("does NOT …")` titles in
> `tests/optimizing/passes/simplify.test.ts`; a fifth rule added tomorrow would be pinned by
> whatever test its author happened to write and by nothing else. The `Float64Add` bug above is
> what that costs. Cost to enforce: a per-opcode soundness table the rule set is derived from, or
> a differential test that runs every rule's before and after over a signed-zero, NaN and
> infinity corpus. Raised by [Ch 47].

> **Unfinished.** `algebraicSimplification` (`src/optimizing/passes/simplify.ts:55-78`) re-scans
> every block and every node on each iteration of its outer `while (changed)` loop, and sets
> `changed` from any single rewrite anywhere in the graph, so on a graph where each fold exposes
> the next it is quadratic in the number of folds. It is not measured ([Conventions § 9]), and on
> `stats.tera` it never fires at all, so nothing in this tree has ever paid for it. Cost to finish:
> a worklist seeded from the uses of each rewritten node, the shape `eliminateTrivialPhis` already
> uses forty lines away. Raised by [Ch 47].

> **Unfinished.** `strengthReduction` (`src/optimizing/passes/simplify.ts:85`) handles only
> `IR_INT32_MUL`. `Int32Div` and `Int32Mod` are excluded on purpose and correctly — the two
> `does NOT` titles in `tests/optimizing/passes/simplify.test.ts` are the reason — but the *sound*
> versions are not implemented either: a power-of-two divide guarded by a proved-non-negative
> range is safe, and `checks.ts`'s `nonNegative` already computes exactly that predicate one
> ordinal earlier. Cost to finish: thread the `Range` map out of
> `rangeAnalysisAndBoundsCheckElimination` (#17) into `strengthReduction` (#18); today the two
> adjacent passes share nothing but the graph. **[unpinned]**. Raised by [Ch 47].

> **Unenforced.** `TRUNCATES_ITS_INPUTS` and `COUNTS_IN_INT32`
> (`src/optimizing/passes/type-narrowing.ts:36`, `:48`) *are* the int32 demand table, and nothing
> derives either or checks it against the passes that read int32 operands. The `range` entry is
> there because it was missing: `for i of range(1, n + 1)` widened `n + 1` to a double, the
> iterator lowering refused the sequence, the `IteratorInit` node survived, and the AOT backend
> declined the whole function with `unsupported opcode IteratorInit` — a message naming a symptom
> five passes downstream of the cause. Any future pass that starts requiring an int32 operand and
> does not add itself to one of the two sets gets the same failure. Cost to enforce: a single
> table that both the demand set and the requiring passes read, which does not exist. Raised by
> [Ch 48].

> **Unfinished.** The declared-`int` return coercion is a boundary coercion, not typed arithmetic:
> `asDeclaredInt32` (`src/runtime/declared-int.ts:24-29`) is applied at one site per tier — the
> interpreter's `ROP_RETURN`, the baseline's `returnExpression`, and `WasmCodegen.createWrapper` —
> so an *intermediate* overflow flowing into a float context still disagrees across tiers:
> `fn f(n: int) -> float: return n * 2 + 0.5` wraps `n * 2` natively and does not in the
> interpreter. Cost to finish: typed int32 arithmetic through the whole expression rather than a
> coercion at the return, which is a different design, not a patch. Raised by [Ch 48].

> **Unfinished.** `REP_TAGGED` is the sixth representation name and `representationSelection`
> never assigns it — re-verified 2026-09-08,
> `grep -c "REP_TAGGED\b" src/optimizing/passes/repr-selection.ts` returns `0` — and
> `abiRepresentationOf` folds it into `REP_TAGGED_NUMBER` by falling through two `if`s. It is not
> dead: the wasm code generator assigns it in its own map for a different purpose, marking an
> in-place object parameter and its map checks (`src/optimizing/backends/wasm/codegen.ts:1096`,
> `:1099`), and `src/optimizing/target/model.ts:29` maps it to the machine representation
> `"tagged"`. One enum serves two vocabularies: five names the middle end assigns, and a sixth
> only a backend introduces. Cost of separating them: a distinct `WasmValueRep` name for the
> backend's case, and a check that no parsed IR fixture stamps the literal string `"tagged"`.
> Raised by [Ch 48].

> **Unenforced.** Nothing in the tree states or checks that `demandOfUse`
> (`src/optimizing/passes/repr-selection.ts:87`) is a *soundness* table rather than a performance
> one — that a use not listed there must default to demanding `REP_HANDLE`. `demandOfUse` encodes
> the rule by omission: no assertion, no `satisfies` constraint, and in a codebase with 26 comment
> lines, no comment. Between the tree and the `"56"` bug there stands one e2e test and one
> chapter. A future reader who reads those seven lines as a performance table will delete the
> default and reintroduce the bug, and the failure will surface as a wrong *string*, not as a
> compiler error. Cost to enforce: a named constant and an assertion at the default arm, or a
> per-opcode demand table constrained the way `OPERATIONS` is. Raised by [Ch 48].

> **Unfinished.** `producesNumber` (`src/optimizing/passes/repr-selection.ts:41-61`) and
> `isProvablyNumericOperand` (`:149-168`) are two overlapping answers to "is this numeric", the
> second calling the first as one of its four clauses, and neither consults `TypeInference` — the
> component that actually knows. A value the type solver has proved `Smi` reads as non-numeric
> here unless it happens to carry a `CheckSmi` use or a numeric result class. Cost to finish:
> threading the cached analysis into the pass, which is one `requires:` entry and one parameter,
> and then re-measuring, because widening what counts as numeric changes what gets unboxed.
> Raised by [Ch 48].

> **Unfinished.** `makeConversion` (`src/optimizing/passes/repr-selection.ts:494-499`) returns
> `null` for bool↔int32 in both directions and for every pair it does not list, and both call
> sites `continue` silently on `null` (`:567`, `:601`). A disagreement the pass cannot bridge
> therefore does not fail here; it fails one pass later in `representation-check`, as an internal
> compiler error naming a node and two ABI names. The fail-fast is real and the diagnostic names
> the symptom rather than the missing conversion. Cost to finish: two conversion cases, or an
> error at the `null` that says which pair was unbridgeable. Raised by [Ch 48].

> **Measured worse.** The whole-function return join — `joinIncomingReps`
> (`src/optimizing/passes/repr-selection.ts:185`) writing `graph.returnRepresentation` at `:386`,
> the field declared at `src/optimizing/ir/index.ts:262` — makes strictly more functions compile
> and makes some of
> them slower than the baseline tier they used to fall back to, because boxing a numeric return
> costs one wasm→JS runtime-stub call per return. On the adversarial shape — a loop of 800,000
> iterations over a function whose cold arm is `return "x"` and whose hot arm is `return a + 1` —
> the newly-compiled version measured **5.8–13.8s against 2.2s** for the baseline tier.
> Min-of-five, one case per fresh process, measured 2026-08-18 and not re-measured since; there is
> no benchmark harness in this tree ([Conventions § 9]), so these numbers are a record of one
> investigation, not a standing measurement. The join is kept because 144 of 144 mixed-return
> shapes compile with it against 61 of 144 without. Raised by [Ch 48].

> **Broken.** `IR_CHECK_PRIMITIVE` is the eighth guard opcode and it is **not** in
> `SPECULATIVE_SOURCES` (`src/optimizing/analyses/type-inference.ts:30-38`), so a declared
> `string | null` parameter reaches `definedComparison` carrying a speculative type the analysis
> reports as clean — `GUARD_BY_KIND` (`src/optimizing/passes/parameter-guards.ts:8-14`) maps
> `TypeKind.String` and `TypeKind.Boolean` to exactly that opcode. Re-verified 2026-09-08 on the
> chapter's probe — a `probe(s: string | null, b: Box) -> bool` returning `s == null` — the
> interpreter prints `true` then `false` and the PE binary prints `false` twice; the set still
> holds seven entries and `IR_CHECK_PRIMITIVE` is not among them. `--print-after-all` names the
> pass and the node: `#8 type-narrowing` turns `v5 = GenericCompare v7, v4 [op="loose=="]`, where
> `v7 = CheckPrimitive v0 [primitive="string"]`, into `v9 = Constant [value=false]`. Substituting
> `int | null` — a `CheckSmi`, which *is* in the set — leaves the compare untouched, which
> isolates the taint set as the difference. `bool | null` does not reproduce, for an unrelated
> second reason: `joinTypes` has no `Boolean`-with-`Nullish` case
> (`src/optimizing/types/lattice.ts:232-249`), so no guard is inserted at all. Cost to fix: one
> entry in `SPECULATIVE_SOURCES`. Cost to fix so it cannot recur: the item below. **[unpinned]** —
> `tests/e2e/optimizing/aot/null.test.ts` tests `int | null` only. Raised by [Ch 49].

> **Unenforced.** `SPECULATIVE_SOURCES` (`src/optimizing/analyses/type-inference.ts:30-38`) is a
> hand-maintained `Set<string>`. Nothing checks it against the guard entries in the operation
> table, and the two have already drifted by one entry — the `IR_CHECK_PRIMITIVE` bug above is
> that drift. Cost to enforce: making one of `guardTransfer`-ness or `speculationRoleOf` an exact
> statement of "this opcode narrows its input on evidence a target may delete", and a test that
> asserts the set equals the derived answer. Raised by [Ch 49].

> **Unfinished.** `guard-with-slowpath` is one of the three `SpeculationKind`s
> (`src/optimizing/target/speculation.ts:1-4`) and no target in the tree selects it; re-verified
> 2026-09-08, its only other hit is the dispatch row at
> `src/optimizing/passes/speculation-lowering.ts:174`. The wasm target uses `deoptToInterpreter`
> and the C, x64 and riscv64 targets use `proveOrGeneric`, so the branch it would take —
> `proveOrGeneric(…, lowerGenerics = false)`, which deletes only the three base guards and leaves
> the native ones standing — is reachable only from a hand-built `TargetModel`. Cost to finish: a
> slow-path lowering for every guard opcode and a capability on `TargetModel` — a backend that
> keeps the guard and emits a generic slow path beside the fast one, a third answer to [Ch 49]'s
> question. Raised by [Ch 49].

> **Unenforced.** Nothing prevents a new pass from calling `TypeInference.typeOf`
> (`src/optimizing/analyses/type-inference.ts:25-28`), reading a speculatively narrowed answer,
> and folding on it. There is no lint, no wrapper type, no assertion and no verifier that could
> detect it — the wrong code is indistinguishable from the right code until you run the binary.
> `typeOf` has many call sites across `src/optimizing/passes/`; `isSpeculative` has one. The only
> structural mitigation is that `TypeInference` is an interface with two methods rather than a
> bare function, so every pass that receives the analysis has `isSpeculative` in scope whether or
> not it calls it — documentation dressed as a type, not enforcement. Cost to enforce: a branded
> `SpeculativeType` that a fold cannot consume without unwrapping. Raised by [Ch 49].

> **Unfinished.** No test pins budget-exhaustion behaviour in the inliner at all. Every test in
> `tests/optimizing/passes/inlining.test.ts` runs with a budget large enough for the callee, so
> the decision in `inlineKnownCalls` (`src/optimizing/passes/inlining.ts:305`) is never close, and
> a change to block ordering could silently change which functions get inlined in a real compile.
> Cost to finish: one test with a two-callee caller and a budget that fits exactly one of them,
> which would also force a decision about whether the scan order is intended to be the policy.
> Raised by [Ch 50].

> **Unfinished.** No test pins the inliner's cost model, its budget, or either bonus.
> `inlineCostOf` (`src/optimizing/passes/inlining.ts:137`) is exported and imported by no file
> under `tests/` — re-verified 2026-09-08, `grep -rn "inlineCostOf\|foldingBonus" tests/` returns
> nothing — and `foldingBonus` (`:126`) is worse off than [Ch 50] states: it is module-private,
> not exported, so a unit test cannot reach it at all. Every inlining test runs with a threshold
> large enough that the comparison at `:350` never decides anything. Cost to finish: three unit
> tests over `inlineCostOf` directly, which is already exported for exactly that purpose and never
> used, plus an export for `foldingBonus` if the bonus is to be pinned separately. **[unpinned]**.
> Raised by [Ch 50].

> **Unenforced.** Nothing in `src/optimizing/passes/inlining.ts` asserts that the pass is only
> safe in a pipeline that does not deoptimize, checks `options.deoptimizes`, or is named for it.
> Run in a deoptimizing pipeline, a bailout inside a spliced body would resume the interpreter at
> the caller's bytecode offset with the callee's values — a frame with the right shape and the
> wrong contents, the hardest possible failure to attribute, and there is no verifier that would
> catch it. The option is one field away: `inlineKnownCalls` already takes `options`. Cost to
> enforce: one early return and one test. Raised by [Ch 50].

> **Never runs.** `inlineLoweredCalls` (`src/optimizing/drivers/aot.ts:627-642`) is the second
> place `inlineKnownCalls` is called, at `:823`, and it sits **outside** any `stage(...)`, so its
> remarks are discarded even in the visualizer. It is also the one of the two that does not re-run
> the middle end: it calls `analyses.invalidateAll()` and stops, so a graph inlined at this late
> point is never re-optimized and the spliced body never sees SCCP, GVN or the narrowing the
> splice made possible. Cost to finish: wrap the call in a `stage(...)` and re-run `runMiddleEnd`
> on any graph it rewrote, plus a decision about the compile-time cost of a second module-wide
> middle-end run. Raised by [Ch 50].

> **Unfinished.** `src/optimizing/drivers/aot.ts:639-640` calls `analyses.invalidateAll();` twice
> in a row on the same object; re-verified 2026-09-08, the two identical lines are still adjacent
> inside `inlineLoweredCalls`. The second call cannot do anything the first did not. Cost to
> remove: one line. Raised by [Ch 50].

> **Unfinished.** No backend emits a machine tail call. `inlineKnownCalls`'s self-tail-call
> handling stops at the IR, and there is no `TailCall` opcode in
> `src/optimizing/ir/operations.ts`. Cost to finish: a `TailCall` opcode in the operation table, a
> capability on `TargetModel` so a backend that cannot do it declines rather than miscompiles,
> and — for x64 and riscv64 — an epilogue that restores the frame *before* the jump, which
> interacts with the unwind tables of [Ch 71 § what-unwinding-is-for], because the frame being
> unwound at the destination is not the frame that was entered. Raised by [Ch 50].

### The wasm back end: legalization, the encoder, the boundary and the way out — Ch 51–54

> **Unenforced.** Nothing verifies that a graph compiled for a target without `deopt` reaches
> the backend carrying no `frameState`. `elideFrameStates`
> (`src/optimizing/passes/frame-state-elision.ts:4-18`) nulls them at legalization `#36` and
> `capabilityCheck` (`src/optimizing/passes/capability-check.ts:35-55`) refuses the *nodes* that
> would have needed one — but the check is at `#40`, four passes later, and `if-conversion`,
> `operation-legalization` and `dead-code-elimination` all create nodes in between.
> `speculatable` in if-conversion happens to test `node.frameState === null`, which catches the
> case by accident rather than by design. The entry is also registered
> `preserves: { kind: "all" }` (`legalization.ts:411`), which is a considerably stronger claim
> about liveness than a pass that deletes every frame-state *use* has any business making; it
> does not currently matter because nothing downstream in that pipeline reads liveness. Cost to
> enforce: one loop in `validateOptimizedGraph` gated on the target's capability set, which
> requires threading the target into a validator that today takes only a graph. Raised by
> [Ch 51].

> **Never runs.** `legalizeOperations` (`src/optimizing/passes/operation-legalization.ts:71-89`)
> is a member of `targetLegalizationPipeline` for **every** target, and its second line is
> `if (legal === null) return 0;`. Re-verified 2026-09-09: `graph.emits` is assigned in exactly
> one place in `src/`, `src/optimizing/drivers/aot.ts:769` (the only other hit is the `null`
> initializer at `src/optimizing/ir/index.ts:301`), so on the JIT path it is `null` and neither
> the pass nor its only expansion, `expandSelect`, ever executes for `wasmTarget`. Cost to
> finish: an `emits` set on `WasmBackend` — the field is declared on `AotBackend`, not on
> `CodeBackend`, so this is an interface change — plus assigning it in `jitCompile`. Raised by
> [Ch 51].

> **Never runs.** `ifConversion` (`src/optimizing/passes/if-conversion.ts:195-244`) is `#37` of
> the wasm pipeline and cannot convert anything there. `wasmTarget`
> (`src/optimizing/backends/wasm/target.ts:7`) holds neither `select-integer` nor
> `select-float`, so `valuesTargetSelects` answers false for every phi and every candidate takes
> the `unselectable` branch at `:223`. Cost: the `OP_SELECT` item below, plus re-reading the
> remarks it would then start emitting. Raised by [Ch 51].

> **Dead.** `OP_SELECT = 0x1b` (`src/optimizing/backends/wasm/wasm-format.ts:87`). The wasm
> select opcode is defined and referenced nowhere else; re-verified 2026-09-09, a grep over
> `src/`, `tests/` and `tools/` returns exactly one line, its own definition. Cost to use it:
> add `IR_SELECT` to `SUPPORTED_GRAPH_NODES` and one case to `emitNode`, which would also make
> `ifConversion` worth enabling on wasm and close the `Math.sign` hole below. Raised by
> [Ch 51], [Ch 52] — [Ch 52] meets it inside a group of five carried-but-unused opcode
> constants and separates it from the other four, because the other four are table completeness
> and this one is a functional hole.

> **Broken.** A function that calls `Math.sign` can never be JIT-compiled. `lowerMathSurface`
> (`src/optimizing/passes/math-surface.ts:106-107`) lowers it to two `irSelect` nodes, and
> `IR_SELECT` is not in `SUPPORTED_GRAPH_NODES`
> (`src/optimizing/backends/wasm/graph-support.ts:213-226`). Re-verified 2026-09-09 on a probe
> under `--opt-threshold 1 --baseline-threshold 1`:
> `[JIT] Compiling "s": Wasm: graph not compilable: block 0 instruction 16 Select is not
> supported by wasm backend`. The function falls back to the interpreter permanently while
> compiling cleanly ahead of time — not a wrong answer, a silent hole in a builtin. Cost:
> identical to the `OP_SELECT` item; it is the same fix three times over. Raised by [Ch 51].

> **Unfinished.** `EXPANSIONS` (`src/optimizing/passes/operation-legalization.ts:51-54`) has
> exactly one entry, `[[IR_SELECT, expandSelect]]` — re-verified 2026-09-09. The pass is written
> as a general opcode-expansion framework (an `OperationExpansion` type, a worklist over blocks,
> a block re-queued after every rewrite) carrying one rewrite. Nothing is missing; the
> generality is unpaid for, and a second entry is the only thing that would justify it. Raised
> by [Ch 51].

> **Unfinished.** None of the three refusals in `src/optimizing/passes/capability-check.ts:35-55`
> is reachable from the command line on any program in `docs/example/`, and probing did not
> reach them either. The native refusal cannot fire because `speculationLowering` deletes seven
> of the eight guard opcodes first and the eighth, `IR_CHECK_MAP`, never enters an AOT graph.
> The wasm `throw` refusal was probed three ways on 2026-09-08 — a throwing callee, a throwing
> top-level loop, and both under `--opt-threshold 1 --no-osr` — and in every case the function
> containing the `throw` was declined for optimization *before* it reached the pipeline,
> silently, with no trace line. The pass is a backstop behind an earlier gate, and the earlier
> gate does not explain itself. Cost to make it observable: a trace line on whatever sets
> `disableOptimization` for these functions (`src/api/engine.ts:1743`, `:1847`). **[unpinned]**
> — no test under `tests/` references `capabilityCheck`, `UnsupportedSpeculationError` or either
> message string. Raised by [Ch 51].

> **Unenforced.** `targetLegalizationPipeline` has forty-one entries and roughly a dozen real
> ordering dependencies, of which **five** are recorded — as test titles in
> `tests/optimizing/pipeline-order.test.ts`, not as anything `src/` reads. Nothing checks that
> `speculation-lowering` precedes `class-member-lowering`, that `frame-state-elision` precedes
> `capability-check`, or that `if-conversion` precedes `operation-legalization` — the last of
> which is a correctness requirement, since the second pass exists to clean up after the first.
> There is no `after:` field on `TransformPass` and no topological check in `PassManager`. Cost:
> a declared `after: [...]` plus that check — a design change, not a patch, and the same change
> the module-stage entry under Ch 55 below asks for one level up. Raised by [Ch 51].

> **Unfinished.** `encodeS64` (`src/optimizing/backends/wasm/wasm-format.ts:29-43`) is the only
> LEB encoder written through `BigInt` — `Number(BigInt(n) & 0x7fn)` per seven-bit group — and
> every one of its five call sites passes a value inside the double-safe range: `2147483647`,
> `-2147483648` and `0` (`codegen.ts:2338`, `:2341`, `:3294`, `:3304`, `:3315`), re-verified
> 2026-09-09. So the `BigInt` round-trip has never had to be right for a true 64-bit value,
> which is the only case it exists for. Cost to finish: pass and accept `bigint` rather than
> `number`, or delete the generality. **[unpinned]** — no test names `encodeS64` or any of the
> other four encoders. Raised by [Ch 52].

> **Broken.** A wasm module declares a memory minimum it did not compute.
> `WasmModuleBuilder.toBytes` writes the imported memory as
> `IMPORT_MEMORY, 0x00, ...encodeU32(1)` — flags `0`, hard-coded minimum of **one page** —
> whatever `wasmMemoryLayout` said (`src/optimizing/backends/wasm/wasm-format.ts:264`). A
> function whose fixed regions span three pages declares that it needs one. It works only
> because `WasmCodegen.compile` supplies the instance a `WebAssembly.Memory` whose `initial`
> *is* `analysis.memoryLayout.initialPages` (`codegen.ts:4094-4097`), so the host always
> over-supplies. The same bytes instantiated against a one-page memory would validate, link, and
> fault on the first `constPointers` access with no diagnostic. Cost to fix: thread the layout
> into `WasmModuleBuilder` and write `encodeU32(layout.initialPages)`; `exceedsAddressSpace`
> already computes the number. Raised by [Ch 52].

> **Unenforced.** Nothing checks that the memory `WasmCodegen.compile` creates and the memory
> `wasmMemoryLayout` describes agree. `exceedsAddressSpace`
> (`src/optimizing/backends/wasm/memory-layout.ts:66-68`) is a *ceiling* test —
> `initialPages > 256` — not an equality test against the declared import, and no third party
> reads both. Cost to enforce: one assertion in `compile`, once the item above has made the two
> numbers the same number. Raised by [Ch 52].

> **Unenforced.** Two recursive graph walks in the wasm backend have nothing bounding them
> against the host's JavaScript stack: `computeBlockOrder`'s `dfs`
> (`src/optimizing/backends/wasm/graph-support.ts:654-663`) and `computePostDominators`' `dfs`
> and `compress` plus `depthOf`
> (`src/optimizing/backends/wasm/structured-control-flow.ts:127-146`, `:53-62`). A graph deeper
> than that stack throws a `RangeError` out of `analyzeGraph` rather than producing a
> `CompileRejection` — an exception escaping a component whose contract is that it answers with
> one. `MAX_WASM_CALL_DEPTH = 1000` (`codegen.ts:183`) sounds like the guard and is not: it
> bounds wasm *activation* nesting at run time (`codegen.ts:4715`). Cost to fix: an explicit
> stack in the two searches, or a depth counter that returns a rejection. **[unpinned]**. Raised
> by [Ch 52].

> **Never runs.** `OP_NOP` (`src/optimizing/backends/wasm/wasm-format.ts:76`), `OP_I64_LOAD`
> (`:92`), `OP_I64_STORE` (`:95`) and `OP_F64_NEAREST` (`:154`) are exported and referenced
> nowhere in `src/`, `tests/` or `tools/`. These four are table completeness — the opcode list
> was written from the spec, not from what `emitNode` happened to need — and the honest cost is
> a deletion. The fifth constant in the same group, `OP_SELECT`, is a functional hole and is a
> `> **Dead.**` entry of its own above. Raised by [Ch 52].

> **Unenforced.** Irreducible control flow is refused twice and tested never.
> `compileRejection` returns `unsupported("irreducible control flow")` on `forest.irreducible`
> (`src/optimizing/backends/wasm/codegen.ts:507-509`) and `generateBody` calls `failEmit` on the
> identical condition twenty lines into itself (`:1616-1619`), but no test in
> `tests/optimizing/backends/wasm/rejection.test.ts` constructs an irreducible graph — and
> tera's own front end cannot produce one, since the language has no `goto`. The two checks are
> insurance against a *pass* creating one. **[unpinned]**. Cost: a hand-built graph fixture,
> about fifteen lines. Raised by [Ch 52], which spells this callout `> **Unpinned.**` — a
> seventh marker word not in [Conventions § 6]; recorded here under the sixth.

> **Unenforced.** The wasm object layout is written twice, in literals, and nothing derives one
> from the other. The offsets `8`, `16`, `4` and the array's `-1` map-id mark appear in
> `emitNode` (`src/optimizing/backends/wasm/codegen.ts:3545-3552`, `:3206-3211`, `:3724-3751`,
> `:3109-3145`) and independently again in `serializeObject` / `deserializeObject`
> (`src/optimizing/backends/wasm/runtime-support.ts:1194-1234`). No test asserts that the
> writer's layout and the reader's layout agree, so a changed header size is a silent miscompile
> that only an end-to-end differential would catch, and only for a shape it happens to cover.
> Cost to fix: one exported `objectHeaderBytes` / `arrayHeaderBytes` pair both files import,
> about ten lines, plus a round-trip unit test per kind. Raised by [Ch 53].

> **Unfinished.** `ensureMemory` (`src/optimizing/backends/wasm/codegen.ts:4436-4445`) calls
> `memory.grow(...)` inside a `try { } catch (e) { }` whose body is **empty**. A refused growth
> is silently ignored and the `serializeObject` that follows writes past the end of the buffer,
> where `DataView.setFloat64` throws a `RangeError` that nothing converts into a deopt — it
> propagates out of the wrapper as a language exception the program never wrote. Cost to finish:
> route the failed grow into the `SerializeTooDeep` path that already exists ten lines below —
> two lines in the `catch`, plus a decision about whether a partially grown memory is safe to
> keep using. Raised by [Ch 53].

> **Broken.** A JIT-compiled call with more than seven arguments silently drops the rest.
> `emitRuntimeStubCall` (`src/optimizing/backends/wasm/codegen.ts:2247`) emits exactly eight
> `f64` operands, while `executeRuntimeStub`
> (`src/optimizing/backends/wasm/runtime-support.ts:600`) maps over the node's **full** input
> list, so `rawArgs[8]` and beyond are `undefined` and arrive at the callee as zero. Nothing in
> `compileRejectionForNode` bounds the arity of a variadic stub node — `FIXED_INPUT_COUNTS`
> (`graph-support.ts:228-303`) does not list the variadic call opcodes at all. Re-verified
> 2026-09-09, one run per fresh process: a nine-argument call prints `45` under `--no-opt` and
> `28` under `--opt-threshold 1`; a seven-argument call prints `28` under both. Nothing throws
> and nothing is traced. Cost to fix: one clause in `compileRejectionForNode` —
> `if (RUNTIME_STUB_NODES.has(node.type) && node.inputs.length > 8) return unsupported(...)` —
> plus the regression test that does not exist. Cost to fix *properly*, so wide calls still
> compile: spill the extra operands through linear memory, roughly thirty lines across the
> emitter and the import. **[unpinned]**, and that is the finding. Raised by [Ch 53].

> **Measured worse.** Three marshalling-shaped tiering declines were added, shipped, and
> reverted — a loop that mutates a global object and calls a heap-passing helper, a loopless
> leaf that allocates and returns a heap value, and a function that stores a fresh object into a
> global each iteration. They were correct when written: those shapes really did pay the
> copy-in/copy-back cost. They were removed because the premise stopped being true underneath
> them — the inline numeric field store and the global-load LICM fix took most of the
> marshalling out of exactly those shapes. The evidence left behind is
> `tests/e2e/optimizing/tiering-declines.test.ts:270-307`, a `describe` block named
> `"functions that should still tier up are not over-declined"` whose entire purpose is to
> assert that they no longer fire. The general rule: **a decline is a bet that the cost is
> structural; when the cost turns out to be a missing optimization, the decline is the thing to
> delete** — and the only way to keep that honest is a test that asserts a refusal is *absent*,
> because nothing else in a suite accumulates assertions that things stop happening. Raised by
> [Ch 53], [Ch 54].

> **Unenforced.** The wasm external-root provider visits only the innermost activation's map.
> `registerExternalRootProvider` (`src/optimizing/backends/wasm/codegen.ts:177-181`) reads
> `threadLocal.currentObjPtrs`, so during a *nested* wasm activation the outer activation's
> `objPtrs` is not visited at all. Nothing checks that the outer map's values are rooted
> elsewhere; in practice they usually are, because they are typically also arguments, globals,
> or values the interpreter's own frames hold — but "usually" is the whole of the guarantee, and
> it is neither stated nor tested. Cost to fix: make the provider walk a stack of maps rather
> than one slot, a handful of lines that adds a push and a pop to a path taken on every
> optimized call. Raised by [Ch 53].

> **Unfinished.** `optimizedCode._declinesEntry` is installed only under `analysis.isOsr`
> (`src/optimizing/backends/wasm/codegen.ts:4853-4856`). A non-OSR optimized function has no way
> to say "do not enter me with these arguments" other than entering and bailing out. That is
> inexpensive — `failingEntryGuard` runs before marshalling — but it still calls
> `recordWasmDeopt`, which still increments `deoptCount`, which still walks the function toward
> `maxDeoptCount` and permanent `disableOptimization`. A caller alternating between two argument
> shapes burns its deopt budget on a condition detectable without executing anything. Cost to
> fix: install `_declinesEntry` unconditionally and consult it in the interpreter's entry path
> beside the `optimizedCode` check — a handful of lines that changes the tiering accounting.
> **[unpinned]**. Raised by [Ch 54].

> **Unenforced.** The deopt snapshot's slot numbering is positional and shared by convention
> only. `emitDeoptSnapshot` (`src/optimizing/backends/wasm/codegen.ts:2151`) and
> `readDeoptSnapshot` (`:4101`) each declare their own `let slot = 0` and each call
> `visitDeoptSnapshotValues` (`src/optimizing/ir/frame-state-values.ts:55-65`). Nothing in the
> eight bytes says which value they hold; if a pass ever mutated a frame state between the two,
> or if one skipped a value the other counted, the reader would silently attribute one node's
> value to another — a wrong answer with no diagnostic anywhere. There is not even a slot-count
> word written into the region. Cost to fix: write `deoptSnapshotSlotCount(fs)` into a header
> slot and check it on read, about six lines plus one more slot of memory. **[unpinned]**.
> Raised by [Ch 54].

> **Unfinished.** The `REP_HANDLE` patch loop in the deopt catch
> (`src/optimizing/backends/wasm/codegen.ts:4738-4750`) is a second-chance pass over values that
> no longer need one. `readDeoptSnapshot` records, for a `REP_HANDLE` node, either the real
> `TaggedValue` or *nothing at all* — it never records a raw linear-memory pointer — and every
> other producer of a `DeoptSignal` passes either an empty `Map` or an already-resolved value
> (`src/optimizing/backends/wasm/runtime-support.ts:565`, `:655`, `:830`, `:857`, `:1051`). So
> the loop asks an address-keyed map about a tagged word. Cost to fix: delete the loop, or give
> `readDeoptSnapshot` a side map of node id to unresolved pointer so the pass has something to
> resolve — the second is the version that would make the comment the code does not have true.
> **[unpinned]**. Raised by [Ch 54].

> **Unenforced.** `materializeFrameValue` treats two identical situations two different ways.
> Three opcodes throw when they cannot be re-derived — a non-trivial `IR_PHI` with
> `Cannot materialize non-trivial Phi v<id> without runtime value`,
> `IR_LOAD_CONTEXT_SLOT` and `IR_MAKE_CLOSURE` — and every *other* unhandled node type falls off
> the end and returns `mkUndefined()` (`src/deopt/frame-materializer.ts:379`). An opcode that
> reaches a frame state with no runtime value and no re-derivation case therefore produces
> `undefined` silently, where a phi in the same position produces a loud throw naming the node.
> Cost to fix: make the fallback throw the same message the context-slot case already uses —
> one line — and then find out from the suite which opcodes were quietly relying on `undefined`.
> **[unpinned]**. Raised by [Ch 54].

> **Broken.** `--stats` reports zero deopts for a wasm bailout.
> `Deoptimizer.recordDeoptReason` and `Deoptimizer.getStats`
> (`src/deopt/deoptimizer.ts:384-398`) are the source of the `deoptStats` block, and the wasm
> wrapper never routes through `Deoptimizer` at all: `createWrapper`'s local `recordWasmDeopt`
> calls `tracer.jitDeopt` and `policy.recordDeopt` directly. Re-verified 2026-09-09:
> `node dist/cli.js --stats docs/example/stats-deopt.tera` prints `"jit_deopts": 1` inside
> `tracerStats` and `"deoptStats": { "total": 0, "reasons": {} }` in the same JSON object, for
> the same single bailout. Cost to fix: give the wrapper the `Deoptimizer` it already has an
> interpreter reference for, or move the counters onto the tracer — a handful of lines either
> way, but it has to pick one owner, because two counters for one event is how this happened.
> Raised by [Ch 54].

> **Unfinished.** `Deoptimizer.deoptimizeFromSignalState` (`src/deopt/deoptimizer.ts:275-289`)
> is declared `: never` and throws `Deoptimization without FrameState not fully supported yet`.
> It is reached from `Deoptimizer.deoptimize` whenever `signal.frameStateId` is negative or the
> frame state is missing, and the wasm tier never gets there — its bailouts either carry a frame
> state or take the `resumeAt(new RegisterFrame(...))` branch inside the wrapper. So the message
> describes the `Deoptimizer` class rather than the backend. Cost to finish: nothing in this
> tier needs it; the honest move is to delete the branch and let the wrapper's fresh-frame path
> be the documented answer for "no frame state". Raised by [Ch 54].

> **Never runs.** `IC_FAILURE_REASONS` (`src/deopt/deoptimizer.ts:173-180`) is a six-element
> `Set` of reason strings — `map-check-failed`, `smi-check-failed`, `number-check-failed`,
> `array-check-failed`, `elements-kind-check-failed`, `wrong-call-target` — constructed at
> module load and read nowhere; re-verified 2026-09-09, a grep over `src/`, `tests/` and
> `tools/` returns exactly one line, its definition. Cost to remove: one deletion. Cost to
> *use*: it is the beginning of a policy that would count inline-cache-shaped bailouts
> differently from arithmetic ones — a function deopting three times on a map check has a
> polymorphism problem, one deopting three times on integer overflow has a range problem, and
> the two deserve different `maxDeoptCount` treatment. That is a design, not a cleanup. Raised
> by [Ch 54].

### The native back end and the runtime it writes — Ch 55–63

> **Unfinished.** `TargetModel.machineReprOf` is an interface member no target overrides. All
> four assign the identical `defaultMachineReprOf` (`src/optimizing/target/model.ts:32-34`;
> `backends/wasm/target.ts:10`, `backends/c/target.ts:18`, `backends/x64/target.ts:98`,
> `backends/riscv64/target.ts:54`), and its one call site in `src/`,
> `src/optimizing/backends/wasm/graph-support.ts:311`, does not even go through the interface —
> it names the module-level `wasmTarget` constant directly. Re-verified 2026-09-09. So an
> interface member exists, four implementations exist, and the single consumer bypasses all of
> it. Cost to finish: nothing is missing; removing the indirection is a five-line change. Raised
> by [Ch 55].

> **Never runs.** `CompilerOptions.splitLiveRanges` defaults to `false`
> (`src/optimizing/options.ts:122`) and `staticCompilerOptions` does not change it, so the
> live-range splitter is off on **every** AOT build and there is no flag that would turn it on.
> Its one reader is `src/optimizing/machine/pipeline.ts:53`; re-verified 2026-09-09, the only
> other hits in `src/` are the field declaration and the option-key union in `options.ts`. This
> is deliberate and it was measured — the numbers are the `> **Measured worse.**` item the
> subsystem survey carries for [Ch 67], and the two entries are the same flag seen from two
> chapters. All [Ch 55] owes is the fact that the AOT path does not turn it on. Raised by
> [Ch 55].

> **Unfinished.** `AotBackend.emits` is a `ReadonlySet<string>` of raw opcode names with no
> relation to the `OPERATIONS` table that defines them
> (`src/optimizing/target/backend.ts:37`). A backend can claim to emit an opcode that does not
> exist and nothing notices — `legalizeOperations` would simply never match it. Cost to close:
> type the field as `ReadonlySet<IrOpcode>` and make `OPERATIONS`' key type the source of truth,
> a one-file change that the `Object.create(CFunctionEmitter.prototype)` trick in
> `cEmittedOpcodes` (`src/optimizing/backends/c/emit.ts:2588-2591`) would survive unchanged,
> since it derives strings from the same constants. Raised by [Ch 55].

> **Unenforced.** The seventeen module-level stages in `compileModule`
> (`src/optimizing/drivers/aot.ts:689-797`) have no declared order and no order test, and at
> least two of the dependencies are real. `closure-conversion` (stage 8) stamps
> `CLOSURE_CAPTURE_PROP` (`src/optimizing/metadata/closure-conversion.ts:48`) and
> `argument-specialization` (stage 10) reads it through `carriesCapture`
> (`src/optimizing/passes/function-argument-specialization.ts:166`); `module-captures` (stage 3)
> rewrites captures into global accesses and so changes the very count `promoteRunOnceGlobals`
> (stage 7) filters on (`src/optimizing/metadata/global-variables.ts:80-84`). Swap either pair
> and the compiler silently produces different, worse code — not an error, a missed
> specialization. `stage()` is only a tracing wrapper: there is no `ModuleStage` type, no
> `preserves`, no `requires` and no invalidation. Unlike `targetLegalizationPipeline`, which has
> `tests/optimizing/pipeline-order.test.ts` beside it, `tests/optimizing/drivers/` holds
> `aot.test.ts`, `module-trace.test.ts`, `text-driver.test.ts` and `write.test.ts` and no order
> test at all. Cost to close: the `after: [...]` field the Ch 51 entry above prices for passes,
> or — far cheaper — a `tests/optimizing/drivers/module-order.test.ts` mirroring the pipeline
> one. Raised by [Ch 55].

> **Unenforced.** "…, or keep this part interpreted" is a contract this book states and nothing
> checks. `src/optimizing/analyses/aot-legality.ts` has **49** `this.fail(...)` sites and the
> phrase appears **25** times in the file — both counts re-verified 2026-09-09 — and only
> **11** of the 49 spell it inline. Several of the rest delegate to a helper that does
> (`SPREAD_CALL_REASON` at `:308-311`, `undeclaredParameterReason`, one arm of `globalValueReason`
> at `:334-337`), but a large group does not on any path: `unsupported opcode ${node.type}`
> (`:1600`), `unsupported builtin ${name}` (`:1774`), `function has no return` (`:1581`),
> `return without a value` (`:1651`), `references can only be compared for equality` (`:1645`),
> `value has no representation in ${context}` (`:1014`). The driver's own two are the same:
> `duplicate symbol ${symbol}` (`src/optimizing/drivers/aot.ts:876`) and
> `calls unavailable function ${name}` (`:177`). No test asserts the ending. Cost to close: a
> lint test over the file's string literals — cheap, and it would freeze the wording — or a
> two-argument `fail(what, remedy)` helper that appends the clause, a roughly 50-site mechanical
> change and the version that could not drift again. Raised by [Ch 56].

> **Unfinished.** `SCALAR_VOID` has no entry in `SCALAR_WIDTHS`
> (`src/optimizing/types/scalar.ts:56-63`), so `scalarWidth(SCALAR_VOID)` throws
> `no storage width for void` (`:101-105`). That is *correct* — a void has no storage — but it
> is enforced by a thrown `Error` reaching the user rather than by the type system.
> `isStorableScalar` (`:79-81`) exists precisely to filter it out beforehand, and every caller
> has to remember to call it; `requireStorable` (`aot-legality.ts:1010-1016`) is the legality
> analysis's disciplined wrapper and nothing makes it the only door. Cost to close: split
> `AotScalar` into `StorableScalar | typeof SCALAR_VOID` and let the type checker find the
> callers that forgot — the same split the `SCALAR_TEXT` entry under Ch 59 asks for, and the two
> should be done together. Raised by [Ch 56].

> **Broken.** `docs/example/stats-poly.tera` cannot be compiled at all, and the reason is not
> polymorphism. `fn report(s)` declares no parameter type, so `requireDeclaredParameters`
> (`src/optimizing/drivers/aot.ts:588-601`) throws `AotUndeclaredParameterError` before the
> class table or the legality analysis is consulted. Re-verified 2026-09-09:
>
> ```
> $ node dist/cli.js compile docs/example/stats-poly.tera -o /tmp/poly.exe
> tera compile: compiling ahead of time needs every parameter to have a declared type
>   report: parameter 's' has no declared type; declare it (for example 's: int'), or keep this part interpreted
> $ echo $?
> 1
> ```
>
> The message is good — it is the one message in the file that offers a concrete edit — but the
> file is listed in `docs/example/README.md` as the structural-dispatch example and does not
> reach dispatch, so [Ch 57] works from `examples/design-pattern/20_state.tera` instead. Cost to
> fix the *example*: declare an interface both `Series` and `Constant` conform to and annotate
> `s`, two lines, plus a decision about whether the book wants an example that is refused for a
> different reason than the one [Ch 56] uses it to illustrate. Cost to fix the *compiler*: infer
> the parameter from its call sites the way `adopt-inferred-types` already does for some shapes,
> which is a real design question about how much a whole-program compiler may conclude from the
> calls it can see. Raised by [Ch 56], [Ch 57].

> **Unenforced.** The two-word heap block header. Every producer must write the shape id at
> offset 0 and the block size at offset 4, and the low three bits of that size must be zero
> (`CLASS_ALIGNMENT_BYTES = 8`, `TERA_BLOCK_FLAGS = 7`). There are **four** independent
> producers — `tera_alloc` in C (`src/optimizing/backends/c/emit.ts:1683-1684`), the x64
> `tera_alloc` routine (`src/optimizing/backends/x64/heap.ts:845-846`), the x64 **inline**
> bump-allocation fast path, which bypasses `tera_alloc` entirely
> (`src/optimizing/backends/x64/lowering.ts:1219-1229`), and riscv64
> (`src/optimizing/backends/riscv64/heap.ts:462-463`) — and nothing checks that they agree.
> Getting it wrong is not a crash: it is a collector reading `tera_classes[garbage]` and walking
> whatever that row describes. Cost to close: a size assertion in a debug build, or a single
> shared emitter for the prologue — the second is a real refactor across three backends. Raised
> by [Ch 57].

> **Unfinished.** `TERA_CLASS_RECORD` declares a fourth field, `reserved`
> (`src/optimizing/target/runtime-layout.ts:205`), that nothing reads or writes — re-verified
> 2026-09-09. It is the slot freed when per-block `size` moved into the flags word and
> `tailReferences` took its place. Cost to remove: it is padding to a power-of-two record size,
> and `TERA_CLASS_RECORD_SHIFT = Math.log2(TERA_CLASS_RECORD.bytes)` (`:250`) requires that, so
> removing the field means giving the shift a different definition — a multiply instead of a
> shift, or a different row width. Raised by [Ch 57].

> **Unfinished.** An array's buffer never shrinks. `pushElement`
> (`src/optimizing/passes/array-shapes.ts:968-992`) and the emitted `tera_array_reserve`
> amortised-double and copy; there is no counterpart for `pop`, `shift` or `splice`, which
> return an element and lower the length while the capacity stays where it was. Capacity is
> written in exactly two places in the pass — `allocate` (`:848`) and `emptyArray` (`:959`) —
> and neither ever lowers it. Named in the file only by absence. Cost: a shrink policy is a
> policy question, not a patch, and nothing in the tree measures allocation behaviour. Raised
> by [Ch 57].

> **Unenforced.** `conformsTo` (`src/optimizing/metadata/class-table.ts:908-925`) compares
> callables by **arity only** — parameter and return types are not checked. Two classes whose
> `render()` answers a `string` and an `int` are therefore in one dispatch cone, and the ladder
> will call both through one call site's signature. No test covers a cone member whose member
> *types* disagree. Cost: comparing declared signatures needs a subtyping relation the class
> table does not hold — it holds names, offsets and arities, and the checker's relation lives in
> `src/frontend/checker/type-system.ts` on the other side of the pipeline. **[unpinned]**.
> Raised by [Ch 57].

> **Broken.** An interface that declares a **data field** silently miscompiles when two
> implementing classes lay that field out at different offsets. `interfaceSurfaceOf`
> (`src/frontend/modules/interface.ts:126-128`) keeps the field as a `CLASS_DATA_MEMBER`,
> `Table.define` gives the interface its own offset for it, and `conformsTo`
> (`src/optimizing/metadata/class-table.ts:909-913`) then drops any class that put another field
> first — so the cone collapses to one member and `applyMemberCall` devirtualizes to it.
> Re-verified 2026-09-09 with `interface Named: label: string; describe() -> string` and two
> implementors, one declaring `label` first and one declaring an `n: int` first:
>
> ```
> $ node dist/cli.js /tmp/iface-field.tera
> a b
> $ node dist/cli.js compile /tmp/iface-field.tera -o /tmp/ifacefield.exe && /tmp/ifacefield.exe
> a
> ```
>
> The binary prints `a`, a space, and nothing — the second call went to `First.describe`, which
> read `Second`'s bytes at `First`'s `label` offset and found the zeroed `n`. Reordering the two
> fields so both classes agree makes the binary print `a b`. This is the structural/nominal
> mismatch one level down: the cone now matches the checker on *surface* and still does not
> match it on *layout*, and `objectAssignable` compares names and types, never offsets. Cost to
> make it a refusal rather than a wrong answer: `conformsTo` would have to report *why* it
> rejected a candidate, and `dispatchConeOf` refuse a cone the member-name index says should be
> wider than the layout comparison made it — roughly one extra index lookup per cone, plus a new
> refusal sentence. Cost to make it *work*: interface fields would need an indirection the
> object model does not have. **[unpinned]** — no test covers an interface with a data field,
> and no file in `docs/example/` covers it either. Raised by [Ch 57].

> **Unfinished.** `values.map(f)` does not compile on any backend, so
> `docs/example/stats-closure.tera` cannot be the higher-order-monomorphisation example even
> though `docs/example/README.md:35` lists it as one. Re-verified 2026-09-09:
>
> ```
> $ node dist/cli.js compile docs/example/stats-closure.tera --emit source --target c -o /tmp/closure-c
> tera compile: note: 'tera_program' is not in the binary, and nothing the program runs calls it (C backend cannot emit: unsupported property map)
> ```
>
> That is a `note`, not a `warning` — the whole entry point is left out, so nothing in the
> program runs. Its `scaler`/`scale` half *does* compile and is [Ch 58]'s closure-conversion
> listing. Cost: `map` would have to lower to an allocate-and-loop in
> `src/optimizing/passes/array-methods.ts` the way `push` does, over a monomorphised callee. The
> specialization machinery already exists; the array-method lowering does not. Raised by
> [Ch 58].

> **Unfinished.** Closure conversion **declines silently**. `capturedOf` and `heldValuesOf` have
> five `return null` paths between them
> (`src/optimizing/metadata/closure-conversion.ts:141`, `:143`, `:147`, `:160`, `:169-171`) and
> not one writes a sentence. What the user sees is whatever `analyzeAotLegality` says about the
> surviving `LoadContextSlot` — a downstream symptom naming a bytecode opcode, for a cause that
> is "this closure writes the variable it captured". Cost: a `DeclineReason` returned alongside
> `null` and threaded to the skipped-function list — mechanical, five sites — but it must stay a
> *decline* rather than becoming a *refusal*, since a later stage may compile the closure
> another way. Raised by [Ch 58].

> **Unfinished.** `specializeFunctionArguments` abandons a whole function when **any** one call
> site hands it something it cannot resolve: line 203 of
> `src/optimizing/passes/function-argument-specialization.ts` is `return`, inside the loop over
> sites, not `continue`. A program with nine monomorphisable sites and one dynamic one gets zero
> clones. Cost: specializing the resolvable sites and leaving a generic copy for the rest —
> which requires the generic copy to be compilable, and it is not, because a callable parameter
> is exactly what the backends refuse. So this is honestly *blocked* rather than merely
> unfinished: the fix needs a representation for a called function value first, which is the
> thing the whole chapter exists to avoid needing. Raised by [Ch 58].

> **Unenforced.** `nameFor` (`src/optimizing/passes/function-argument-specialization.ts:72-74`)
> builds `owner$callee$callee…` by string join, and `clones` is a `Map` keyed by that string.
> Two different handoff combinations producing the same string would silently share one clone.
> `uniquify-graph-names` runs at `aot.ts:689`, *before* specialization, so it does not cover the
> names specialization invents. Cost: key `clones` by the handoff tuple rather than by a name
> derived from it, and derive the name second — about five lines. **[unpinned]** — no test
> covers a name collision. Raised by [Ch 58].

> **Unfinished.** `joinedNames` (`src/optimizing/passes/generators.ts:89-93`) is a two-case
> special: identical names join, `int`/`float` widen to `float`, everything else refuses.
> Meanwhile `src/optimizing/types/lattice.ts` has a real `joinTypes` and
> `src/optimizing/metadata/class-table.ts:375` has `joinedTypeName` — the one `joinedLiteralShape`
> uses to merge two record literals into one layout. A generator yielding two record shapes that
> `joinedLiteralShape` could merge is refused with *"yields both … and …"*. Cost: replacing the
> two cases with `joinedTypeName(classes, [...])`, plus a decision about what a `null`-admitting
> yield means for the `yielded` field's scalar. Raised by [Ch 58].

> **Unenforced.** The code-pointer contract. `CORO_RESUME_TYPE` is the string
> `"(tera_frame) -> int"` (`src/optimizing/metadata/coroutines.ts:7`), and `<fn>$resume`'s
> `declaredSignature` is built independently as
> `{ params: [frame.name], returns: DECLARED_INT }` (`src/optimizing/passes/coroutines.ts:933`
> and `src/optimizing/passes/generators.ts:216`). They agree by inspection and by nothing else:
> `params: [frame.name]` is `mean_of$frame` while the field says `tera_frame`, which is sound
> only because every frame extends `tera_frame` and the class table's prefix property makes the
> layouts compatible. `checkCallThrough` compares the *call site* against the field's declared
> type; nothing compares the field's declared type against the resume function actually stored
> there. This matters because it guards the one indirect call in a compiled tera program. Cost:
> `coroutineFrameShape` could take the resume signature and assert compatibility, roughly five
> lines. Raised by [Ch 58].

> **Unenforced.** "`SCALAR_TEXT` is a storage scalar and is never a value's scalar" is the only
> thing keeping `cTypeOf(SCALAR_TEXT)` (`src/optimizing/target/c-types.ts:61`) and
> `locationOf(SCALAR_TEXT)` (`src/optimizing/backends/x64/target.ts:95`) from ever being
> reached, and nothing checks it. `isStorableScalar` (`src/optimizing/types/scalar.ts:79-81`)
> filters only `SCALAR_VOID`; `AotScalar` is one flat seven-member union; the whole guarantee is
> that `aotScalarOf` never returns `SCALAR_TEXT` while `fieldScalarOf` and `defineArray` rewrite
> into it. Breaking it produces a thrown `no C type for scalar text` reaching the user as a
> crash — not a type error and not a refusal. Cost to enforce: split `AotScalar` into value
> scalars and storage scalars, which is the same fix the `SCALAR_VOID` entry under Ch 56 asks
> for; the two should be done together. Raised by [Ch 59].

> **Unfinished.** `boxable` returns false for a value whose uses are all `IR_RETURN` or `IR_PHI`
> (`src/optimizing/passes/string-boxing.ts:150`), leaving returned strings to the caller's proof
> and phis to `boxWeb` — but `boxWeb` only fires on a web that `mergesStorage`, strictly more
> than one string input from outside. A single-producer string phi carried around a loop and
> then returned is therefore neither boxed nor merged, and is refused later if anything in the
> loop can rebuild the buffer. This is reachable in ordinary code. Cost to finish: a real
> decision about who owns a returned string, not a patch. Raised by [Ch 59].

> **Unfinished.** A producer string buffer is `DEFAULT_TEXT_BUFFER_BYTES` — 16 KB — **per
> producer**, emitted as a function-`static` array whether or not the function ever runs.
> `Series_label` alone carries 32 KB of BSS for two `+` operations; a program with forty
> producers carries 640 KB. Nothing sizes a buffer to what its producer can actually build, even
> where every input is a constant of known length. Cost to finish: a length analysis over
> `buildsString` inputs — the pieces exist (`characterCapacity`, constant folding, the
> per-buffer `capacity` field on `AotStringBuffer` already threaded everywhere); the pass does
> not. Raised by [Ch 59].

> **Unenforced.** `bufferOf` (`src/optimizing/backends/c/emit.ts:2006-2015`) throws a bare
> `Error` — "the string vN produces has no buffer to live in, because the compiler could not see
> where it is built; keep this part interpreted" — rather than a `BackendLoweringError`.
> Re-verified 2026-09-09: it is a plain `throw new Error(...)`. A bare throw is a crash; only a
> `BackendLoweringError` is caught by the driver and turned into a refusal. The machine backends
> do it properly — `requireStringBuffer` raises a `BackendLoweringError` naming the operation,
> and that path *is* tested. Cost to fix: one throw site. Raised by [Ch 59].

> **Unfinished.** riscv64 does not declare `"utf16-text"`
> (`src/optimizing/backends/riscv64/target.ts:42`, whose whole capability set is
> `capabilitySet("terminating-throw", "float-text")` — re-verified 2026-09-09), so on that
> target every member in `INDEXES_CHARACTERS` is refused for any program containing a single
> non-ASCII character, including `print("Xin chào".length)`, which x64 and C compile and answer
> correctly. The refusal is honest and its wording is good; the gap is real. Cost to finish: the
> code-unit work already done for x64 in `src/optimizing/backends/x64/`, carried into riscv64's
> own lowering and data emission. Raised by [Ch 59].

> **Unfinished.** `WideTextModel.exact` (`src/optimizing/analyses/wide-text.ts:74-78`) is a
> capability answer wearing the name of a precision claim. It is a parameter of
> `summarizeWideText` defaulting to `false`, set from `capabilities.has("utf16-text")` at
> `src/optimizing/drivers/aot.ts:858`, and read in exactly one place,
> `aot-legality.ts:1019`, to choose between the two refusal sets. No test in the tree names the
> field. Cost to fix: rename it to what it means — `storesCodeUnits`, say — or give it the
> meaning its name implies. Raised by [Ch 59].

> **Unfinished.** All four `SOURCE_PRELUDES` are **entry-module only**, on both halves.
> `preludeFor` (`src/api/engine.ts:456-460`) passes `[graph.entry.ast]` as the `entry` argument,
> so `sourcePreludes` never sees an imported module's AST, and `adoptPreludeCalls` (`:462-468`)
> calls `adoptSourcePreludes([graph.entry.ast])`, so no imported call site is rewritten. The
> consequence is four different refusals for one cause, three of which name a downstream symptom
> rather than it — measured with a two-file project whose entry only imports:
> `to_fixed` gives `unsupported property to_fixed`; `substring` gives
> `unsupported property substring`; a float `%` gives `unsupported opcode GenericMod`; and
> `Math.exp` gives *"Math.exp is part of the runtime rather than of the program, so there is
> nothing to compile for it; keep this part interpreted"*. The same programs compile when the
> entry module spells the construct. Cost: move each rewrite from the AST to IR the way
> `shapeModuleCollections` and `lowerParseNumbers` already do — both reach every module because
> they rewire a callee to a program-wide class or function global, and both are why `Map` and
> `parse_float` work in an imported module while `to_fixed` does not. Pinned only as a *limit*
> by `tests/e2e/optimizing/aot/fixed-text.test.ts` >
> `"stands down where the formatting lives in an imported module"`; the other three are
> **[unpinned]**. Raised by [Ch 60].

> **Unfinished.** `src/optimizing/prelude/float-mod.ts` is the design the other three preludes
> should adopt — no `adopt`, an IR pass (`lowerFloatRemainder`,
> `src/optimizing/passes/float-mod.ts:34`) doing the rewrite — and only half of that is true.
> The *lowering* does reach every module. The *emit* still only reads the entry, so with no `%`
> in the entry, `_float_mod` is never declared, `lowerFloatRemainder` hits its
> `signature === undefined` guard at `:35` and returns 0, and the imported module is refused
> with `unsupported opcode GenericMod`. An IR-level rewrite is only half a fix; the demand test
> has to move too. Cost: give `SourcePrelude.emit` the whole module graph rather than the entry
> — a one-argument change in `preludeFor` and a re-audit of every `emit` for name collisions
> across modules. Raised by [Ch 60].

> **Unenforced.** The rule that produced a null-array read in a compiled binary — "prelude state
> must not live at module level" — has no checker anywhere. It is respected by convention in all
> four preludes and by nothing else. Cost of enforcing: a scan in `sourcePreludes`
> (`src/optimizing/prelude/index.ts:27-29`) rejecting any top-level `VariableDeclaration` in the
> emitted text, roughly ten lines, since the text is parseable by construction. Raised by
> [Ch 60].

> **Unenforced.** `preludeText` (`src/api/engine.ts:446-453`) fixes the concatenation order by
> hand — `numbers`, `collections`, `errorPrelude`, `json`, `sourcePreludes` — while
> `SOURCE_PRELUDES` fixes only the order of the last four. Nothing checks that two preludes do
> not emit the same name, and the one real dependency in the set is expressed as a boolean
> argument rather than as structure: JSON forces the number readers by passing `json.length > 0`
> into `parseNumberPrelude` at `:452`. Cost of enforcing: a duplicate-name assertion over the
> concatenated text, or an explicit `requires` field on `SourcePrelude`. Raised by [Ch 60].

> **Unenforced.** `text-methods.ts`'s `sharedName` flag has no relationship to the set of
> members arrays actually carry; it is a hand-maintained boolean on two entries
> (`src/optimizing/prelude/text-methods.ts:25`, `:50`). Add a third `TextMethod` whose member
> name an array also has, forget the flag, and `rewriteTextMethods` will rewrite an array
> receiver's call into a `string`-typed helper. Nothing derives the flag from
> `data/tera-language-spec.ts` and nothing cross-checks it. Cost: derive it. Raised by [Ch 60].

> **Unfinished.** Four runtime array capacities are compile-time constants with no flag, while
> the arena beside them is tunable with `--heap-size`. `TERA_ROOT_CAPACITY` (16384),
> `TERA_MARK_CAPACITY` (4096), `TERA_YOUNG_CAPACITY` (8192) and `TERA_REMEMBERED_CAPACITY`
> (2048) all live at `src/optimizing/target/runtime-layout.ts:106-109`. Two distinct
> consequences: a deeply recursive program exhausts `TERA_ROOT_CAPACITY` in `tera_enter_roots`
> and exits with `TERA_EXIT_HEAP_EXHAUSTED` — exit code 70, from
> `src/optimizing/target/faults.ts:1` — which is the *same* code and the same silence the
> allocator produces when the arena is full, so the two failures are indistinguishable from
> outside the process; and a program whose live young set exceeds 8192 objects promotes
> everything on its first minor collection and gets no generational benefit at all, silently and
> with nothing reported. Cost of finishing: thread the four through `AotCompileOptions` the way
> `heapBytes` already is, give the root overflow its own exit code and its own sentence, and add
> a `--stats`-style line reporting minor-versus-major collection counts so the degenerate
> nursery case is visible. Raised by [Ch 61], [Ch 62] — [Ch 61] meets the root-capacity half and
> [Ch 62] the nursery half; one gap, two symptoms.

> **Unenforced.** Nothing verifies the root-frame protocol after it is emitted.
> `validateMachineFunction` (`src/optimizing/machine/verifier.ts:192-209`) runs four checks per
> call — block links, operand validity, tied form, and then either no-surviving-virtuals or
> reaching-definitions — and none is about roots: no rule pairs a `tera_enter_roots` call with
> the epilogue store, and none checks that the `N` the prologue publishes equals the number of
> slots the body writes. The C output is text and is never parsed. `emitRoot`
> (`src/optimizing/machine/select.ts:141-158`) returns silently when the value has no slot, no
> frame or no register, so a dropped store is indistinguishable from a value that was never
> rooted, and a function that leaked root slots would report as `TERA_EXIT_HEAP_EXHAUSTED` from
> some unrelated later call. Cost of enforcing: a machine-IR verifier rule pairing the
> `tera_enter_roots` call with the epilogue restore and comparing the published count against
> `fn.roots`, roughly twenty lines, plus the equivalent assertion in `CEmitter`. Raised by
> [Ch 61].

> **Unenforced.** The runtime list heads the collectors mark are written out by hand, once per
> collector, and the three lists are **not the same length**. Twice in
> `src/optimizing/backends/c/emit.ts` (`:1566-1570`, `:1590-1594`), once in `markRoots` in
> `src/optimizing/backends/x64/heap.ts:492-500` (shared by the major and minor entry points),
> and once in `src/optimizing/backends/riscv64/heap.ts:349-359` — which marks three of the five.
> The only thing making that correct is that riscv64 does not declare `timers`, so its two timer
> heads are permanently null; nothing states that reasoning and nothing would notice if `timers`
> were added tomorrow. There is no `root: true` on the field spec, no derived loop, and no test
> relating a backend's capability set to its root set. Cost of enforcing: an `ownership`-style
> tag on the `TERA_CONTEXT` field spec and a generated loop in each emitter, perhaps thirty
> lines across `runtime-layout.ts` and the three backends. Raised by [Ch 61].

> **Measured worse.** The address-range nursery — reserve one end of the heap, bump a cursor
> into it, copy survivors out on a minor collection and reset. C backend, `gcc -O2`, an
> allocation-heavy program with a live old set, one case per fresh process: **400 ms → 630 ms**.
> The defect is not tuning: a collector that cannot move an object cannot get survivors *out* of
> a nursery, so the nursery's floor never rises and it grows until it is the whole arena. What
> shipped instead keeps the generational idea and throws away the geometry — an explicit young
> list, promotion as a bit flip. The losing implementation was removed when it lost, so this is
> a recorded measurement and **not a reproducible one**. Cost of "finishing" it: it cannot be
> finished without a moving collector, which the shadow stack's mirror slots rule out and which
> is priced at three backends' code generators plus the register allocator of [Ch 67]. The
> general rule, stated so nobody retries it: **a non-moving collector cannot keep a nursery
> contiguous, so its young set must be a list of objects, not a range of addresses.** Raised by
> [Ch 62]; this entry replaces the subsystem survey's placeholder for it.

> **Measured worse.** A fixpoint-rescan minor mark, in the shape x64's major `markPass` uses:
> **1.3× slower** than the work-stack `markYoung` (`src/optimizing/backends/x64/heap.ts:204-254`).
> Like the address-range nursery it is not in the tree, so this too is recorded rather than
> reproducible. The general rule: the right marking shape depends on what a pass iterates over
> and how often it runs, not on which collector it belongs to — a rescan is a good trade when
> the pass is rare and the set is one you were going to walk anyway, and a bad one when the pass
> is frequent and the set is small enough that a worklist fits. Raised by [Ch 62].

> **Unenforced.** The soundness of the remembered set is a coincidence of two constants being
> equal in four places. `tera_remember` drops on
> `rememberedCount == TERA_REMEMBERED_CAPACITY` (`src/optimizing/backends/c/emit.ts:1392`) and
> `tera_minor` escalates to a full collection on the same equality (`:1579`), 187 lines apart in
> one file — and the same pair is written twice more in `src/optimizing/backends/x64/heap.ts`,
> at `:679-681` inside `writeBarrier` and `:608-612` inside `minor`. Nothing relates the four
> sites. Dropping without escalating loses objects; escalating without dropping would need an
> unbounded set; neither half is sound alone. Change any one site — to `>=`, to a different
> constant, to a growable buffer — and the collector silently frees live objects, in the one
> configuration nothing tests. Cost of enforcing: make the drop impossible to misread — have the
> barrier set a `rememberedOverflow` flag in `tera_context` that `tera_minor` checks, so the
> invariant is one variable rather than one equality repeated four times. Raised by [Ch 62].

> **Unenforced.** The write barrier's region guard is written independently in
> `src/optimizing/backends/c/emit.ts:2302` and
> `src/optimizing/backends/x64/lowering.ts:1316`, and nothing checks that the two agree. The
> guard is a statement about which memory *region* is being written, not about which IR opcode
> is doing the writing, so an opcode that can reach two regions needs the region in its
> condition — and that predicate belongs somewhere both backends can call. It does not exist.
> Both regression tests compile with `backend: "c"`, so the x64 half is **[unpinned]**: the only
> x64 assertion in the suite is that a barrier appears *somewhere* in the output, which a
> wrongly-fired barrier also satisfies. Cost of enforcing: lift the predicate into one shared
> `remembersStore(node, scalar)` under `src/optimizing/analyses/`, roughly ten lines, and have
> both backends call it. Raised by [Ch 62].

> **Unfinished.** riscv64 has no generational collector.
> `src/optimizing/backends/riscv64/target.ts:42` declares no `generational-heap`, so that target
> keeps only the full mark-sweep. Cost of finishing: port `markYoung`, `markYoungPass`,
> `sweepYoung`, `minor` and `writeBarrier` from `src/optimizing/backends/x64/heap.ts` into
> riscv machine IR — five routines, on the order of 450 lines of builder code — and, first, a
> riscv64 instruction encoder, because until one exists nothing written there can be run. That
> encoder is the `> **Unfinished.**` item at the top of this appendix. **An unexecutable
> collector is worse than no collector**, because the full collector it would replace does work
> and is exercised through the C backend. Raised by [Ch 62].

> **Unenforced.** The one-waiter invariant — that a promise can never reach two coroutines — is
> established by `misusedPromise` in `src/optimizing/drivers/aot.ts`, which is a *refusal in a
> different file* from the field it protects. Nothing in `coroutineBaseShapes`
> (`src/optimizing/metadata/coroutines.ts:82-107`) records that `waiter` is single-occupancy,
> and a future pass that introduced a phi between a suspending call and its await would silently
> overwrite a parked frame — losing a coroutine with no diagnostic. Cost of enforcing: the
> no-comment rule means it cannot be a note, so it wants an assertion in `appendWaiting` that
> `waiting == CORO_NOBODY_WAITING` before the store — about four IR nodes, paid on every park.
> Raised by [Ch 63].

> **Unenforced.** Two coroutine-lowering ordering constraints are held by the order of three
> statements and nothing else (`src/optimizing/passes/coroutines.ts:937-939`). `suspendAt` must
> run before `spillInto`, because it introduces new uses of the awaited promise on the far side
> of a split that is reached by a jump rather than by falling through; and `exits` must be
> captured before `suspendAt`, because `suspendAt` inserts returns of its own that must not be
> settled as though a value had been returned. Reversing either produces a graph that passes
> `validateSSA` on simple programs and reaches an undefined value on programs with more than one
> suspend, surfacing in a resume block a long way from the cause. The coroutine pass is not among
> the passes `verifyEachPass` covers, so nothing re-checks the graph between these three lines
> and the next stage. Cost of enforcing: an assertion in `suspendAt` that the exit set is already
> frozen, plus adding the coroutine pass to the per-pass verifier. **[unpinned]**. Raised by
> [Ch 63].

> **Unenforced.** `drainBeforeExit` is applied to `entry.graph` alone — the single unit whose
> name matches `entryName` (`src/optimizing/drivers/aot.ts:572-573`). A program whose real exit
> lay in another unit would leave the event loop undrained and every rejection unreported,
> silently. No current lowering produces that shape and no test covers it. Cost of enforcing:
> check that `drainBeforeExit` returned a non-zero count when the module has coroutines — one
> line, which at least converts silence into a compiler error. Raised by [Ch 63].

> **Unfinished.** The AOT unhandled-rejection suite is four cases short of the interpreter's.
> `tests/e2e/language/unhandled-rejection.test.ts` has nine cases; the AOT counterpart,
> `describe("AOT rejections nobody awaits")`, has five, plus one deadline case in
> `timers.test.ts`. The four with no AOT twin are the ones about a rejection *observed* at top
> level (`"surfaces a top level await of a rejection nobody caught as uncaught"`,
> `"does not report when the rejection is observed at the top level (surfaces as uncaught)"`),
> about module entry (`"surfaces the same uncaught rejection when the entry is run as a
> module"`), and `"does not report when the rejection is handled with catch"`. Since the whole
> chapter's claim is that the binary's report is byte-identical to the interpreter's, the gap is
> in the evidence rather than in the code. Cost of finishing: the AOT cases are all `itRunsPe`,
> so each needs a PE runner and each only runs on Windows; adding them is otherwise mechanical.
> Raised by [Ch 63].

## Carried from the subsystem survey, to confirm when each chapter is written

Each of these was reported by a reader of that subsystem and must be re-verified by the
chapter that raises it before it appears in prose.

- **Measured worse.** Live-range splitting is implemented, tested and off by default: two
  of the three Wimmer split rules measured as regressions.
  `src/optimizing/machine/linear-scan.ts`, `src/optimizing/options.ts`. [Ch 67]
- **Measured worse.** An address-range nursery was built and reverted; the young-list
  design shipped instead. [Ch 62]

Four entries have left this list because the chapters that owed them are now written. Three
were confirmed rather than dropped, and one was not.

`EphemeronHashTable` is above under § the-collectors, as [Ch 26]'s `> **Broken.**` — the
survey attributed it to [Ch 31], but the chapter that meets the class is the one about the
objects that are not objects. Incremental marking is above as [Ch 31]'s `> **Dead.**` on
`checkSafepoint`, which is the reason nothing steps it. Bounds-check elimination is above
under § the-middle-end as [Ch 46]'s `> **Broken.**`, confirmed on 2026-09-08 by a command
that still prints the surviving `CheckBounds` — but the survey's *reason* did not survive
contact with the chapter: the `CheckSmi` wrapper defeats route 2 only, and routes 1 and 3
fail for two other reasons while a numeric gate in front of all three means none of them is
ever reached.

The fourth, `loopUnrolling`, is in § Closed: the symbol no longer exists.

## Closed

Items that have left the two lists above. They are recorded, not deleted: the five markers
describe the tree as it is, and this section is how an entry stops being one of them without
the history going with it.

**`loopUnrolling` was a misleading name.** Renamed. The survey carried it as this book's
canonical [Conventions § 4] case — a name that must be kept because the code's names win —
and `docs/CONVENTIONS.md:27` still cites it as the example. **The symbol no longer exists.**
Verified 2026-09-08: `grep -rn "loopUnrolling" src/ tests/ tools/` returns nothing, and
`git log -S loopUnrolling --oneline -- src/` shows it leaving in commit `0f3b0bc`. The
function is now `peelLoopChecks` (`src/optimizing/passes/loop-opts.ts:115`), registered as
`loop-check-peeling` at `src/optimizing/pipeline.ts:222` and called at `:225`; the name now
says what the code does — it copies a loop-invariant guard or field load into the preheader
and never duplicates a loop body. Nothing about the *behaviour* changed: [Ch 46] still carries
a `> **Unfinished.**` on the same function for returning a count of loops rather than nodes.
What closed is the naming complaint, and the closure is a rename rather than a fix, which is
the one shape of closure this section had not yet recorded. Two consequences are worth
carrying: `docs/CONVENTIONS.md` § 4's example is now stale and should be re-sourced to
`EphemeronHashTable`, which is still misnamed and still above in this appendix; and [Ch 46]
says so itself in a `> **The name.**` callout rather than an honesty marker, which is correct
— a name that has been fixed is not one of the six markers. Raised by the subsystem survey
for [Ch 46], closed there.

**The optimizing tier answered differently on an `int[]` comparison.** Fixed. The symptom was
a wrong answer with no crash: a 27-line reduction of a decimal-bignum formatter — a `compare`
that walks two `int[]` limb arrays backwards inside a `while` and returns early, called 54
times with `halve` shrinking one array between calls — ended `...,1,1,1,1,` under `--no-opt`
and `...,1,0,0,0,0,0,` once the optimizing tier had installed compiled code, from roughly the
forty-ninth call. The mechanism was one root with five faces, and it lived in the shared
middle end rather than in either tier. `MemoryLocation.key`
(`src/optimizing/analyses/heap-model.ts`) is `partitionKey|fieldKey` — for two `int[]`
parameters, `shape:-1|anyIndex` for both, because points-to gives them the same array shape
and no single allocation site, and a non-constant subscript is `anyIndex`. That is a
**may-alias** key: it names a class of cells. `load-elimination` used it as the identity of
its available-value map, so it forwarded `a[i]` in place of `b[i]`; `a[i] != b[i]` became
`a[i] != a[i]`, always false, `compare` fell out of its loop and returned `0`.
`dead-store-elimination` had the mirror-image bug — a store killed the liveness of every
may-aliasing key, so a store to `b[0]` made an earlier store to `a[0]` look dead. The fix was
to stop asking one key two questions. `MemoryLocation` now carries `identity: string | null`
beside `key` (`src/optimizing/analyses/heap-model.ts:64`, built at `:134`) —
`v<identity-root id>|slot:<offset>`, `|index:<const>`, `|index:v<index root id>`, or
`global:<name>`, and `null` when the cell cannot be named. Both passes key their dataflow
state by `identity` (`load-elimination.ts:63-65,161-165`, `dead-stores.ts:141-150`) and keep
using `key`/`mayAlias` for kills; the identity-root walk follows `forwardsPointerIdentity`, so
`CheckElementsKind(CheckArray(a))` in two blocks still resolves to one root and the legitimate
forwarding of `a[i]` for `a[i]` survives. `dead-stores` also lost its private copy of
`memoryLocation`/`isExternallyVisible` and now shares the heap model's. The regression tests
are the five shapes that miscompiled: `tests/optimizing/passes/load-elimination.test.ts` >
`"keeps a load of a second array that only shares the first array's shape"`,
`"keeps a second load of one array taken at a different index"`,
`"keeps a load of a second object that only shares the first object's shape"`, and
`tests/optimizing/passes/dead-stores.test.ts` >
`"keeps a store that a second object of the same shape overwrites"`,
`"keeps a store that a different index of the same array overwrites"`. The general rule it
produced: **a partition answers whether two accesses *may* touch the same memory; it never
answers whether they *are* the same cell.** Redundancy — forwarding a load, killing a store —
needs the second question, so it must key on identity, and where identity is `null` it must
eliminate nothing.

Two things about how this entry closed are worth keeping. First, the closure was measured, not
asserted. The reproducer was rebuilt byte-for-byte from the heredoc in [Ch 82] and run four
ways on 2026-09-07 — `--no-opt`, default thresholds, `--always-opt`, and `--opt-threshold 1`.
All four printed the same 54 marks, `-1,` followed by fifty-three `1,`, and `diff` reports the
four outputs identical; there is not one `0` mark under any optimizing configuration. The
non-reproduction is not vacuous: `--trace-opt` shows `compare` really is speculatively
compiled and installed — it prints
`[JIT] Compiling "compare": Compare(>=) at bc:14 → Int32Compare (smi speculation)`, then
`Wasm module compiled: 2037 bytes, 8 blocks`, then a `Wasm installed` line — so optimized
code ran and agreed. Second, [Ch 82 § how-to-read-a-codebase] states the rule that retires
entries from this appendix — **an entry
leaves the inventory when a command reproduces nothing, not when a note says so** — and this
is that rule applied to that chapter's own `> **Broken.**` entry. Ch 82's worked example of
distrusting notes over code is the note it was itself carrying. What the chapter loses with it
is a live divergence to bisect: [Ch 77]'s worked example localized this divergence to a named
pass, and it now has to demonstrate the same machinery on an injected difference. That
`tests/e2e/optimizing/decimal-formatter.test.ts` > `"prints what toFixed prints, at every
tier"` passes remains literally true and no longer describes a gap: it never covered this
shape, and the shape is now covered by the five tests above. Raised by [Ch 77] and [Ch 82],
closed in both.

**A guard's proof outlived what it proved: `Binding.filled`.** Fixed. The symptom was one
source with two answers. `docs/example/queue.tera` drains a queue two elements at a time under
`while q.length > 0`, and on an odd-length argument — `drain([1, 2, 3])` takes `1` and `2`,
loops again because the length is still `1`, takes `3`, and finds nothing for the second name
— the interpreter added `3` to nothing and printed `NaN`, while the native binary compiled
from the same file printed `0`. The mechanism was a refinement that nothing falsified.
`Binding`, the record a name resolves to (`src/frontend/checker/type-system.ts`), carried
`filled?: boolean`. The narrowing machinery set it to `true` in the child scope when it saw
`q.length > 0`; the inference machinery read it at the call site and stripped the `undefined`
from `shift()`'s return type. Nothing ever cleared it — least of all the `shift()` that
consumed the element the guard had proved — because the field was written by one half of the
checker and read by the other, and neither half owned the transition between them. So the
second `shift()` found `filled === true` still sitting there, the checker typed the result
`int`, `a + b` typed as `int + int`, and the backend believed it and emitted integer
arithmetic. The fix was not a kill rule. Clearing `filled` on every take is one line and is
still wrong the moment a guard proves two elements and the code takes two, because a boolean
cannot tell `>= 1` from `>= 2`. Commit `11021f9` deleted the field
(`src/frontend/checker/type-system.ts:26-36` no longer declares it) and added the 290 lines of
`src/frontend/checker/length-bounds.ts`, which replaces the boolean with a **count**: `takes()`
(`:221-227`) spends one element and records the call as proven only if one was left, `adds()`
(`:229-233`) repays one, and `merge()`, `apart()` and `forget()` say what happens at joins, at
aliasing and at anything the analysis cannot follow. The regression tests are the thirty in
`tests/frontend/checker/length-bounds.test.ts`, of which
`"proves the first take and refuses the next"` is the one the old design cannot pass. The
general rule it produced: **a refinement about mutable state must name what falsifies it** —
if you cannot say, at the moment you record the fact, which operations kill it, you have
recorded a hope and not a fact — **and where the state is quantitative, the refinement must be
quantitative too: carry the quantity and spend it.** The field was live for five days, added
in `851e025` on 2026-09-02 and removed in `11021f9` on 2026-09-07. Note what did *not* close
with it: the same divergence still arrives through `splice`, which neither table above models,
and that entry is live in this appendix. Raised by [Ch 1] and [Ch 13], closed in both.

**Labeled `continue` never terminated.** Fixed. `continue outer` compiled to a jump nobody
ever patched: the labelled statement created the list of labelled continues, `continue outer`
filled it with placeholder jumps whose target was `0`, and the label discarded the list
without patching it — so `continue outer` jumped to instruction `0`, the first instruction of
the script, which rebuilt `rows` and printed `1 2` forever. `docs/example/labeled.tera` did
not terminate; `break outer` was correct throughout, which is why the bug went unnoticed. The
mechanism was ownership, not a missing line:
`compileLabeledStatement` in `src/bytecode/register/compiler/statements.ts` held the label's
continue jumps but had no target to patch them to, because the loop compiler swaps
`_continueJumps` in and out around the body and restores it before returning. The fix hands
the label to the loop instead. A labelled statement now only declares the label pending —
`_pendingLoopLabels` (`src/bytecode/register/compiler/helpers.ts:128`) — and the next
`enterLoop` (`:131`) claims it, aliasing `_labeledContinues[label]` to the loop's own
`continueJumps` (`:140-143`) so that `exitLoop` (`:147`) patches labelled and unlabelled
continues together at the latch (`:153-154`). A label that no loop claims is now rejected
outright. Pinned by `tests/bytecode/register/compiler.test.ts` >
`"backpatches labeled continue in a while loop to the outer loop latch"`,
`"backpatches labeled continue in a for loop to the outer loop latch"`,
`"sends labeled continue past the inner loop rather than to the inner latch"`,
`"rejects a labeled continue whose label does not name a loop"`, and by
`tests/e2e/docs/book-examples.test.ts` >
`"labeled.tera resumes the outer loop instead of restarting the program"`, which runs the
file and expects `["1", "2", "3", "5", "6", "7"]` — six lines, one number each, exit 0.
The general rule it produced: **a jump can only be patched by
the construct that owns its target.** Raised by [Ch 19], closed there and in [Ch 82].

## Rule

An item leaves the lists above only when it is fixed **and** the chapter that raised it is
updated; it then moves to § Closed with its fix and the tests that pin it. Deleting an entry
because it is embarrassing is the one edit this book does not allow.
