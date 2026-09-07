# The running example

Every listing in this book comes from a program in this directory. No chapter
invents a snippet. When a chapter needs a stage to behave differently, it uses one
of the named variations below — each is a small edit to `stats.tera`, and each is
run by `tests/e2e/docs/book-examples.test.ts` so it cannot silently break.

## `stats.tera` — the spine

Twenty-four lines: a class with a typed `float[]` field, a counted `while` loop over
an array, a monomorphic method call, string concatenation, `.to_fixed(2)`, and `print`.
It is carried from its first character to a self-linked native executable.

```
$ node dist/cli.js docs/example/stats.tera
latency mean=15.70
throughput mean=898.19
```

It compiles ahead of time and the binary agrees, byte for byte:

```
$ node dist/cli.js compile docs/example/stats.tera -o /tmp/stats.exe
$ /tmp/stats.exe
latency mean=15.70
throughput mean=898.19
```

## The variations

| File | One-line edit | What it demonstrates | Chapters |
| --- | --- | --- | --- |
| `stats-poly.tera` | a second class with the same members | call and property sites go polymorphic; structural, not nominal, dispatch | 12, 34, 57 |
| `stats-async.tera` | `async fn load()` and an `await` | the implicit-await effect analysis, a suspended frame, coroutine lowering | 14, 30, 58, 63 |
| `stats-closure.tera` | a returned inner function, `values.map(double)` | closure conversion and higher-order monomorphisation | 20, 50, 58 |
| `stats-deopt.tera` | a string inside a numeric array | an elements-kind guard fails and the JIT bails out | 33, 34, 54 |
| `stats-refused.tera` | one function returns `string` or `float` | AOT declines a function, then its caller, then the entry | 56, 81 |
| `queue.tera` | `while q.length > 0: a = q.shift(); b = q.shift()` | the interpreter answers, the AOT compiler refuses | 1, 13 |
| `labeled.tera` | `continue outer` | a jump only the loop can patch: the labelled-`continue` bug and the handover that fixed it | 19, 82 |

## Two answers, one program

`queue.tera` is the book's cold open. The interpreter runs it and prints `10`.
The ahead-of-time compiler refuses the same program:

```
$ node dist/cli.js docs/example/queue.tera
10

$ node dist/cli.js compile docs/example/queue.tera -o /tmp/queue.exe
tera compile: 6:18 Operator '+' cannot be applied to 'int' and 'int | undefined'
  (the value may be absent: guard it before use, or spell a fallback with ??)
```

`while q.length > 0` proves that the *first* `shift()` returns a value. It proves
nothing about the second. The interpreter never asks the question; the compiler
cannot avoid it. Chapter 13 tells the whole story.

## `labeled.tera` and the jump nobody patched

```
$ node dist/cli.js docs/example/labeled.tera
1
2
3
5
6
7
```

It did not always answer that. `continue outer` used to compile to a jump nobody ever
patched: the labelled statement created the list of labelled continues,
`continue outer` filled it with placeholder jumps whose target was `0`, and the label
deleted the list without patching it. So `continue outer` jumped to instruction 0 —
the first instruction of the script — which rebuilt `rows` and printed `1 2` forever.
`break outer` was correct throughout; only `continue` was affected.

A labelled statement cannot patch that jump, because it does not own the target. A
labelled `continue` has to land on the labelled *loop's* continue point, which is a
different instruction in a `while`, a `for`, a `do-while` and a `for-of`, and the label
sees none of them. So the label hands itself over instead: it registers itself in
`_pendingLoopLabels`, and `enterLoop`
(`src/bytecode/register/compiler/helpers.ts:131-145`) drains that list into the loop
context it is building, so the loop owns the label's continue jumps and patches them
with its own. A label that names no loop is now rejected outright. The rule it
produced: **a jump can only be patched by the construct that owns its target.**

The example suite runs this file like every other variation
[t: tests/e2e/docs/book-examples.test.ts >
"labeled.tera resumes the outer loop instead of restarting the program"].
Chapter 19 tells the whole arc, down to the disassembly.
