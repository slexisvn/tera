# 15. Modules: two graphs, not one   ⟨I · B · J · N⟩

> **Status:** outline

**Thesis.** The order you must initialize in and the order you must check in are different —
a package must *run* before its submodules and be *checked* after them — and the engine keeps
them apart by running Tarjan twice over two different edge sets.

**What arrived.** From [Ch 14 § what-leaves]: an AST with `async` and `implicitAwait` stamped
on it — but per *file*. Nothing so far has asked which files exist. From [Ch 8]: a
`SemanticProgram` whose `Import` nodes carry `level`, `path`, `alias` and `bindings`, which
is the only input this chapter's resolver has.

**What leaves.** A `ModuleGraph` (`graph.ts:57-63`): the `entry` record, `modules` interned
by canonical path, two orderings `initOrder` and `checkOrder`, and `cycles`. Plus, from
`checkModuleGraph`, a `ModuleCheckResult` carrying one `ModuleInterface` per module, the
merged `TypeEnv`, and the `ClassSurface[]` [Ch 12] produced — now flattened across every
module in the program. Ch 16 takes the `diagnostics` field and decides what it means.

**New ideas.** A module and a compilation unit; a *dependency graph*; a *strongly connected
component* and Tarjan's algorithm; why a cycle is a component, not an error; edit distance,
named once for the "did you mean" suggestion.

**Length.** 14 pages

## Anchors

- `src/frontend/modules/resolver.ts` — 217 lines. Constants `ENTRY_SPEC = "__main__"`,
  `MODULE_EXTENSION = ".tera"`, `PACKAGE_INDEX = "__init__.tera"`,
  `NATIVE_PREFIX = "native:"`, `PROJECT_MANIFEST = "tera.json"`. `ModuleKind` — the four-way
  `"file" | "package" | "namespace" | "native"`. `projectRootFor` walking up for the
  manifest; `moduleAt` (the three-line precedence); `dottedSpec` and `specWithin`;
  `moduleSpecFor`. The `ModuleResolver` class: `bases` (root first, then search paths,
  deduplicated), `hasNative`, `specOf` (longest-base wins), `resolveEntry`, `resolve`,
  `tryResolve`, `resolveAbsolute`, `moduleUnder`, `resolveRelative`, `owningPackage`.
- `src/frontend/modules/graph.ts` — 446 lines. Types `ModuleBinding`, `ResolvedBinding`,
  `ResolvedImport`, `ModuleRecord`, `ModuleGraph`, `ModuleGraphError` (which appends
  `(imported by a -> b -> c)`). `isExportable` — one line, `!name.startsWith("_")`.
  `parentSpec`, `bindingsOf`, `collectBinding` (the eight semantic kinds that produce a
  binding), `importsOf`, and `tarjan(nodes, successors)` — an explicit-stack Tarjan at
  lines 156-206. The `ModuleLoader` class: `build`, `drain`, `intern` (the identity rule),
  `load`, `resolveImport`, `resolveModule`, `resolvePackagePrefixes`,
  `linkSubmoduleBindings`, `resolveOwnedSubmodule`, `importEdges`, `finish` (lines 388-434 —
  where the two orders are computed), and `freeze`.
- `src/frontend/modules/interface.ts` — 274 lines. `ClassMemberSurface` / `ClassSurface`
  and their builders `shapeMembers`, `setterMembers`, `classSurfaceOf`,
  `interfaceSurfaceOf`, `classSurfacesOf` (all handed on from [Ch 12]).
  `signatureToExternal`. `moduleInterfaceOf` (line 158) publishing four lists —
  `builtins`, `values`, `aliases`, `interfaces`. Then the import side: `renameSignature`,
  `qualifiedSurface`, `mergeSurface`, `surfaceIsEmpty` and `importedSurface` (line 240) with
  its `claim` closure.
- `src/frontend/modules/check.ts` — 242 lines. `editDistance` (an in-place two-row
  Levenshtein), `SUGGESTION_DISTANCE = 3`, `nearestName`, `exportedNamesOf` (memoized in a
  `WeakMap`), `moduleLabel`, `importedLocals`, `assignedTopLevelNames`. The `ModuleChecker`
  class: `run` (line 118, the `checkOrder` loop), `adoptAliases` with its `disputed` set,
  `report`, `error`, `checkImports`, `checkNativeImport`, `checkImportAssignments`. Entry
  `checkModuleGraph`.
- `src/frontend/packages.ts` — 99 lines. `PACKAGES_DIRECTORY = "tera_packages"`,
  `STATE_DIRECTORY = ".peta"`, `STATE_FILE = "state.json"`, `STATE_VERSION = 2`.
  `parseState`, `packagesUnder`, `searchPathsUnder`, `searchPathsIn`, `searchPathsForEntry`,
  `installedPackagesIn`. This is the whole of the seam with the `peta` package manager —
  described here by its interface only, per [Conventions § 19].
- `src/frontend/modules/file-system.ts` (12 lines) and `node-file-system.ts` (20 lines) —
  the `ModuleFileSystem` port. Named because it is why the entire module system is testable
  from an in-memory map of file names to strings.
- `src/api/engine.ts` — `runModuleGraph` (line 1304) walking `initOrder`;
  `compileAotModuleInRuntime` (line 1006) walking the *same* order and building
  `moduleInits`; `MODULE_INIT_NAME = "tera_module_init"` (line 145); `linkModuleGraph`,
  `publishModuleNamespaces`, `cellKey`.
- `src/optimizing/drivers/aot.ts` — `startModules` (242-267), which unshifts one
  `irCallKnownFunction` per initializer into the entry graph's first block, and its refusal
  when a module `canReject`. Line 885: `moduleInits = started ? [] : …` — the link-time
  table is the fallback path, not the primary one.
- `src/cli/main.ts` — `printModuleGraph` (line 157), which is what `--print-module-graph`
  prints: every record with its kind and targets, then `init order:`, then one line per
  cycle.

## Worked example

`examples/geometry/` — four modules and a package, the only example in the tree that
exercises every resolution rule at once:

```
main.tera            import shapes; from mathx import abs_int, max_int
                     from shapes.area import border_area as border
mathx.tera
shapes/__init__.tera from .area import square_area, rect_area, border_area
                     from .volume import cube_volume, box_volume, prism_volume
shapes/area.tera
shapes/volume.tera
```

```bash
node dist/cli.js --print-module-graph examples/geometry/main.tera
```

```
entry: __main__
  __main__ [file] -> shapes, mathx, shapes.area
  shapes [package] -> shapes.area, shapes.volume
  mathx [file]
  shapes.area [file] -> mathx
  shapes.volume [file] -> mathx, shapes.area
init order: mathx -> shapes -> shapes.area -> shapes.volume -> __main__
```

Read the order carefully: `shapes` comes **before** `shapes.area`, even though `shapes`
imports from it. That inversion is the chapter, and it is deliberate. The same program
compiles to a native binary and prints the same four lines:

```bash
node dist/cli.js compile examples/geometry/main.tera -o /tmp/geo.exe && /tmp/geo.exe
```

## Outline

- [ ] **New idea: a module.** Primer — a file with a name, a private top level, and a
      published surface. Establish the two questions this chapter answers and keeps apart:
      *where does this name's code live* (resolution) and *when does its top level run*
      (ordering). Establish the third, quieter one that motivates the split: *what does the
      importing module know about it* (the interface).
- [ ] **Finding the root.** Establish `projectRootFor` (`resolver.ts:35-43`): walk up from
      the entry's directory looking for `tera.json`, and if you reach the filesystem root
      with no manifest, fall back to the entry's own directory. Establish why a marker file
      and not a flag: the same entry file must resolve the same way from any working
      directory. Pin with *"walks up to the directory holding tera.json"* and *"falls back to
      the entry directory when no manifest exists"*.
- [ ] **Three candidates, in order.** Establish `moduleAt` (`resolver.ts:53-66`) as the whole
      precedence rule, three `if`s: `<target>.tera` is a `"file"`; `<target>/__init__.tera` is
      a `"package"`; a bare directory is a `"namespace"`. Establish the consequence — a file
      and a directory of the same name are not ambiguous, the file wins — and pin it with
      *"prefers a module file over a package directory of the same name"*. Establish the
      fourth kind, `"native"`, which short-circuits everything: `resolveAbsolute` checks
      `this.natives` *first*, and if a real file also exists at that path it does not shadow —
      it raises `Cannot shadow native module 'name'`. Pin with *"refuses a file that shadows
      a native module"*.
- [ ] **Bases, and where `peta` comes in.** Establish `ModuleResolver.bases` — the project
      root first, then `searchPaths`, deduplicated — and `resolveAbsolute` trying each in
      order, so the root always wins. Establish where the search paths come from:
      `searchPathsForEntry` (`packages.ts:80`) appends `tera_packages` when the project has
      one, and `installedPackagesIn` reads `tera_packages/.peta/state.json`, refusing any
      `stateVersion` other than `2`. Establish this as the whole `peta` seam and stop there
      ([Conventions § 19]). Pin with *"resolves a project module ahead of an installed
      package of the same name"*, *"keeps every module path ahead of the packages
      directory"*, and *"ignores a state file written by a different state version"*.
- [ ] **Relative imports, and the name a module ends up with.** Establish `resolveRelative`
      (`resolver.ts:176-198`): the starting directory is the importer's directory — *except*
      for a namespace importer, where it is the directory itself — then one `dirname` per
      extra dot. Establish the two things that then happen to the answer. `specOf` refuses a
      path outside every base: `Relative import '..x' escapes the project root`. And
      `owningPackage` (`:200-207`) renames the target after the package the *importer* was
      reached as, so the same file reached two ways still gets one spec. Pin with *"resolves
      relative imports from inside a package"*, *"resolves a parent-relative import"*,
      *"reports a relative import that escapes the project root"*, *"follows the package the
      importer was reached as"* and *"names a file by the innermost base that holds it"*.
- [ ] **One file, one record.** Establish `intern` (`graph.ts:246-268`) as the identity rule:
      keyed by *canonical path* when `resolved.path !== null`, by spec when it is null —
      which is native modules only, since a namespace has a real directory path. Establish
      the `parsed` flag it sets in the same object: `native` and `namespace` records are born
      parsed and never enter the queue, so a namespace directory has a path that is never
      read. Establish the two consequences that are tested: a file imported by two modules is
      loaded once, and a path spelled with mixed separators is one record. Establish the `chain` field carried alongside, and how
      it becomes `(imported by a -> b -> c)` in `ModuleGraphError`. Pin with *"loads a file
      only once when two modules import it"*, *"resolves a path with mixed separators to one
      record"*, *"loads the entry file once even when another module imports it by name"* and
      *"reports an unresolved module with the import chain"*.
- [ ] **Two things a `from` import might name.** Establish the ambiguity: `from pkg import
      inner` may name an *exported binding* of `pkg` or a *submodule* `pkg.inner`, and you
      cannot know which until `pkg` is parsed. Establish the resolution:
      `linkSubmoduleBindings` (`graph.ts:355-376`) runs after the queue drains, and for each
      binding the owner does not export, tries `resolveOwnedSubmodule` — which interns a new
      module, which refills the queue, which is why `build` loops
      `while (this.linkSubmoduleBindings()) this.drain()`. Establish the precedence, and pin
      it: *"prefers an exported name over a same-named submodule"*, *"binds a submodule named
      in a from-import"*, *"allows a submodule import that is not an exported name"*.
- [ ] **New idea: a strongly connected component.** Primer — a set of nodes each reachable
      from every other; in a dependency graph, a cycle. Establish `tarjan` (`graph.ts:156`) as
      an explicit-stack implementation (no recursion, so a deep import chain cannot blow the
      JS stack), and the property that matters here: components come out in **reverse
      topological order**, so dependencies precede dependents for free. Establish
      `component.sort(by discovery index)` as the determinism guarantee, pinned by *"produces
      the same init order across builds"*.
- [ ] **Two edge sets. The chapter's centre.** Establish `importEdges` (`graph.ts:378-390`):
      one edge per import, plus one per resolved submodule binding. Then `finish`
      (`graph.ts:392-403`): `initEdges` is `importEdges` **plus an edge from every module to
      its parent package** (`parentSpec`). Establish exactly what that extra edge does. In the
      init graph, `shapes` imports `shapes.area` and `shapes.area` has a parent edge back to
      `shapes` — so they are one SCC, and the parent is discovered first, so the parent runs
      first. In the check graph there is no parent edge, so `shapes.area` is a plain
      dependency and is checked first. Run the two tests side by side, on the same three
      files: *"checks a package after the submodules it imports"* gives
      `[pkg.inner, pkg, __main__]`; *"still initialises the package before its submodule"*
      gives `[pkg, pkg.inner, __main__]`. **Why the obvious design fails** goes here — one
      order cannot be both, because `pkg/__init__.tera` must exist as a namespace before
      `pkg.inner` can be reached through it, but its *types* are exactly what `pkg.inner`
      does not depend on.
- [ ] **What a cycle is and is not.** Establish `cycles` (`graph.ts:428-431`): a component of
      more than one module, or a single module that imports itself. Establish that this is
      *reported*, not refused — `--print-module-graph` prints a `cycle:` line, and the checker
      keeps going. Establish what the runtime does with it instead: a read of a value that has
      not initialized yet is the error, not the cycle. Pin with *"keeps a two-module cycle in
      one component"*, *"reports a self import as a cycle"*, *"checks a cycle without
      hanging"*, *"supports mutually recursive functions across a cycle"* and *"reports a
      cycle read of a value that is not initialised yet"*.
- [ ] **What a module publishes.** Establish `bindingsOf` / `collectBinding`
      (`graph.ts:106-152`): eight semantic kinds become a `ModuleBinding`, including `Import`
      itself — so a name you imported is a name you re-export. Establish `isExportable` as
      the entire privacy model: one line, leading underscore, no keyword. Establish
      `moduleInterfaceOf` (`interface.ts:158-190`) sorting each exported binding into one of
      four lists — a type alias into `aliases`, a shape into `interfaces`, a signature into
      `builtins`, and everything else into `values` with its type text. Pin with *"marks
      underscore-prefixed names as not exported"*, *"records declarations of every top-level
      kind"*, *"re-exports names brought in by an import"* and *"lets a module keep private
      state that the importer cannot see"*.
- [ ] **What the importer sees.** Establish `importedSurface` (`interface.ts:240-274`) and its
      two shapes. A `from X import a as b` goes through `renameSignature`, which searches
      builtins, aliases and interfaces first and falls back to values — so an imported
      function keeps its *signature* under the local name. A plain `import X` pushes
      `{ name: local, type: "any" }` and then merges `qualifiedSurface`, which re-publishes
      every builtin and value under the dotted name `X.f`. Establish the `claim` set: the
      first import to bind a local name wins and later ones are dropped silently.
      Pin with *"renames an aliased import in the importing module"*, *"types a call made
      through a namespace import"*, *"does not leak a private name into the importing
      module"*.
- [ ] **The checker's own diagnostics.** Establish the three `ModuleChecker` checks that the
      per-module checker cannot make: `checkImports` (unknown export, with a Levenshtein
      suggestion within distance 3, and private-name access), `checkNativeImport` (the same,
      against the four external lists), and `checkImportAssignments` (`Cannot assign to
      imported binding 'x'`). Establish `adoptAliases` and its `disputed` set — a type alias
      is adopted into a program-wide `TypeEnv`, and the *first disagreement deletes it for
      everyone*, which is the one place the module system chooses silence over an error.
      Pin with *"reports an unknown export"*, *"suggests a near miss"*, *"reports an import of
      a private name"*, *"points the diagnostic at the specifier"*, *"reports assignment to an
      imported binding"*, *"carries an imported type alias into the importing module"*.
- [ ] **The bug: an imported top level that never ran.** Tell it as engineering. *Symptom* —
      a native binary built from a multi-module program produced wrong values, because only
      `__main__`'s top level executed. *Mechanism* — the interpreter walks `initOrder` and
      calls `interpreter.execute` per record (`engine.ts:1313-1319`); the AOT path compiled
      each record to its own function and then emitted only the entry. *Fix* —
      `compileAotModuleInRuntime` renames each non-entry module's code to
      `<spec>::tera_module_init` and collects the names, and `startModules`
      (`drivers/aot.ts:242-267`) unshifts one `irCallKnownFunction` per initializer into the
      *front of the entry graph's first block*, in `initOrder`. *Regression test* — the
      geometry example builds and prints the same four lines as the interpreter. *General
      rule* — an ordering computed by the front end is a contract, and every back end has to
      implement it, not just the one you were looking at.
- [ ] **When even that is refused.** Establish `startModules`' guard: if any initializer
      `canReject`, the whole rewrite is abandoned with `module <name> can throw while it
      loads, and the compiler cannot yet carry that throw out of a module; keep this part
      interpreted`, and `moduleInits` falls back to a link-time init table
      (`backends/c/backend.ts:116`, `machine/backend.ts:375`). Two mechanisms, one order.
- [ ] **What leaves.** Restate the handover into ch 16: `checkModuleGraph` returns a
      `diagnostics` array that spans every module, with `module` and `path` attached to each
      entry. Whether that array is advice or a refusal is not decided here.

## Honesty items

> **Unfinished.** A namespace import binds its local name as `"any"`
> (`interface.ts:258`: `surface.values.push({ name: entry.local, type: ANY_TYPE })`). The
> *qualified* names are typed — `shapes.square_area("x")` correctly reports `Type 'string' is
> not assignable to parameter 'side: int'` — but a member that does not exist is not an
> error: `shapes.no_such_fn(1)` type-checks silently. Cost of fixing: publishing the module
> as an `ObjectShape` in `env.interfaces` instead of a value plus a set of dotted names,
> which changes how `dottedName` lookups resolve in `infer.ts` for every import in the tree.

> **Unfinished.** `qualifiedSurface` (`interface.ts:228-233`) re-publishes only `builtins`
> and `values`. An `interface`, a `class` or a type alias reached through a namespace import
> — `shapes.Point` as a *type* — is not in the importing module's surface at all. Only the
> `from X import Point` spelling carries a shape across.

> **Unfinished.** `adoptAliases` (`check.ts:141-153`) merges type aliases into one
> program-wide `TypeEnv`, so aliases are effectively global and unqualified. Two modules
> that both define `type Id = int` agree by accident; two that disagree cause the name to be
> **deleted for every module**, with no diagnostic. Cost: per-module alias environments,
> which means `resolveType` needs to know which module it is resolving for.

> **Unenforced.** `importedSurface`'s `claim` set silently drops the second import that binds
> a local name already taken — `from a import f` followed by `from b import f` leaves `f`
> meaning `a.f`, with no diagnostic. `checkImportAssignments` reports a *write* to an
> imported binding but nothing reports a duplicate *import*.

> **Unenforced.** `initOrder` and `checkOrder` are computed by two independent Tarjan runs
> over two independently built edge maps. Nothing asserts the relationship between them
> (that `checkOrder` is a topological order of `importEdges`, or that every runnable module
> appears exactly once in each). The two tests at `tests/frontend/modules/graph.test.ts:329-355`
> pin one three-module case by example; there is no invariant check.

> **Unfinished.** `startModules` (`drivers/aot.ts:242`) abandons the entire IR-level
> initializer rewrite if *any* module can throw while loading, falling back to the link-time
> table for all of them. It is all-or-nothing per program, not per module.

## Verify it yourself

```bash
node dist/cli.js examples/geometry/main.tera
node dist/cli.js --print-module-graph examples/geometry/main.tera
node dist/cli.js compile examples/geometry/main.tera -o /tmp/geo.exe && /tmp/geo.exe
npx vitest run --project unit tests/frontend/modules/ tests/frontend/packages.test.ts
npx vitest run --project e2e tests/e2e/language/modules.test.ts
```

The second prints `init order: mathx -> shapes -> shapes.area -> shapes.volume -> __main__` —
the package before the submodules it imports from. The third prints the same four lines as
the first, which is what the initializer fix bought. The fourth suite is 77 tests across four
files.

## Tests that pin this

`tests/frontend/modules/resolver.test.ts`:

- > "walks up to the directory holding tera.json"
- > "falls back to the entry directory when no manifest exists"
- > "resolves a registered native module"
- > "refuses a file that shadows a native module"
- > "prefers the project root over a search path"
- > "falls through to a search path when the root has no match"
- > "prefers a module file over a package directory of the same name"
- > "rejects an unknown module"
- > "rejects a relative import from a native module"
- > "gives the entry file the __main__ spec"
- > "loads the entry file once even when another module imports it by name"
- > "resolves a path with mixed separators to one record"
- > "follows the package the importer was reached as"
- > "keeps the outer name when the importer was reached through the outer base"
- > "climbs out of the package for a parent import"
- > "names a file by the innermost base that holds it"
- > "gives a package and its relative submodule one namespace in the graph"

`tests/frontend/modules/graph.test.ts`:

- > "loads a single entry module"
- > "loads an imported sibling module"
- > "initialises dependencies before dependents"
- > "loads a package through its __init__"
- > "reaches a submodule through a namespace package"
- > "binds a submodule named in a from-import"
- > "initialises a package before any of its submodules"
- > "prefers an exported name over a same-named submodule"
- > "resolves relative imports from inside a package"
- > "resolves a parent-relative import"
- > "loads a file only once when two modules import it"
- > "resolves dotted namespace imports and binds the root package"
- > "binds the full module when an alias is given"
- > "keeps a two-module cycle in one component"
- > "reports a self import as a cycle"
- > "has no cycles for an acyclic graph"
- > "produces the same init order across builds"
- > "reports an unresolved module with the import chain"
- > "reports a relative import that escapes the project root"
- > "marks underscore-prefixed names as not exported"
- > "records top-level bare assignments as bindings"
- > "records declarations of every top-level kind"
- > "re-exports names brought in by an import"
- > "resolves a registered native module without touching the disk"
- > "refuses to let a file shadow a native module"
- > "checks a package after the submodules it imports"
- > "still initialises the package before its submodule"

The last two are the chapter's thesis, on identical input.

`tests/frontend/modules/check.test.ts`:

- > "accepts an import of an exported name"
- > "reports an unknown export"
- > "suggests a near miss"
- > "reports an import of a private name"
- > "points the diagnostic at the specifier"
- > "reports assignment to an imported binding"
- > "reports assignment to an aliased module binding"
- > "allows a submodule import that is not an exported name"
- > "checks a call against the imported signature"
- > "accepts a call that matches the imported signature"
- > "carries an imported type alias into the importing module"
- > "renames an aliased import in the importing module"
- > "does not leak a private name into the importing module"
- > "checks a cycle without hanging"
- > "still reports an unknown export inside a cycle"
- > "types a call made through a namespace import"
- > "accepts a well-typed namespace call"
- > "types a re-exported name reached through a package namespace"
- > "checks a package after the submodules it re-exports"

`tests/frontend/packages.test.ts`:

- > "appends the packages directory of the project holding the entry"
- > "keeps every module path ahead of the packages directory"
- > "resolves a project module ahead of an installed package of the same name"
- > "resolves an installed package when nothing shadows it"
- > "reads the installed set peta recorded"
- > "ignores a state file written by a different state version"

`tests/e2e/language/modules.test.ts` — the same rules, run in the interpreter:

- > "runs each module body exactly once"
- > "initialises dependencies before dependents"
- > "lets a module keep private state that the importer cannot see"
- > "runs a package __init__ before its submodule"
- > "re-exports a name through a package __init__"
- > "resolves a relative import inside a package"
- > "names a package's own submodule after the package, not after the outer root"
- > "supports mutually recursive functions across a cycle"
- > "reports a cycle read of a value that is not initialised yet"
- > "shares one class definition across modules"
- > "does not fold a member access when a local shadows the module name"

`tests/e2e/language/modules-differential.test.ts` > "multi-module programs agree across
tiers":

- > "calls an imported numeric function in a hot loop"
- > "reads an imported module-level constant in a hot loop"

`examples/geometry/` compiling to a native binary that agrees with the interpreter:
**[unpinned]** — no test compiles this example.
