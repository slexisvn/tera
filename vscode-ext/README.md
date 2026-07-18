# Tera Language

Language support for **Tera** (`.tera`) — a tensor algebra & neural network DSL.

Syntax highlighting, diagnostics, and IntelliSense powered by a built-in language server.

## Features

- **Syntax highlighting** for tensors, models, functions, and control flow
- **Diagnostics** — type errors and undefined names reported as you type
- **IntelliSense** — completions for builtins, tensor methods, and modules
- **Snippets** for common patterns (models, layers, training loops)
- **Bracket matching, auto-indent, and comment toggling**

## Example

```tera
x = tensor([[1, 2], [3, 4]])
w = randn([2, 3])
y = (x @ w).relu()

model MLP(input: int, hidden: int, output: int):
  fc1 = Linear(input, hidden)
  fc2 = Linear(hidden, output)

  forward (x: Tensor) -> Tensor:
    x = fc1(x).relu()
    return fc2(x)

net = MLP(2, 4, 1)
print(net(randn([8, 2])).shape)
```

## Requirements

VS Code `^1.94.0`. The extension activates automatically when you open a `.tera` file.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tera.trace.server` | `off` | Trace LSP communication between VS Code and the Tera language server (`off` / `messages` / `verbose`). |

## Development

```bash
npm --prefix ..  run build   # build the Tera compiler bundles this extension consumes
npm run build                # regenerate language data, then bundle to dist/
npm run typecheck && npm test
```

| Path | Purpose |
|------|---------|
| `src/client/` | Extension host: language client + notebook controller |
| `src/server/` | Language server: `analyzer/` (tokens, symbols, diagnostics) and `providers/` |
| `src/notebook/` | Notebook kernel process and chart renderer |
| `src/shared/` | Types shared between the server, the emitters, and the web notebook |
| `scripts/` | `generate.ts` emits the grammar, snippets and `language-data.json`; `build.ts` bundles |
| `data/builtin-docs.md` | Descriptions, parameters and methods for every built-in |

Nothing about the language is hand-listed twice. Keywords come from the compiler frontend
(`@slexisvn/tera/frontend`); built-ins, their `kind` and their return types come from
`src/runtime/domain`; `data/builtin-docs.md` supplies only the prose. The `chart` namespace is
the exception — its methods are documented in `notebook/src/chart/docs.ts`.

`npm run generate` fails when these disagree: if the lexer gains or drops a keyword
(`scripts/language-spec.ts`), or if a built-in is undocumented, documented but nonexistent,
or annotated with a kind the runtime contradicts. So the grammar and the docs cannot
silently drift from the language.

To add a language feature, drop a provider in `src/server/providers/` and list it in that
folder's `index.ts`.

## License

[MIT](LICENSE)
