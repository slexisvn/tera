# Tera site

Standalone React and TypeScript site, built with Vite. Requires Node 22.12+.

```sh
npm install
npm run dev
npm run build
```

The Vite base is `/tera/`, matching GitHub Pages project hosting. Open the local dev server at `/tera/`.

`src/content/site.ts` owns product copy, destinations, examples, and illustration data. `src/sections` composes the page. `src/components` holds shared UI. `src/styles/tokens.css` owns the visual system; `site.css` contains component layouts and responsive rules.

The code explorer shows static examples, not a live runtime. Output is illustrative; the model tab shows architecture. Notebook and visualizer links point to the deployed GitHub Pages routes, while source-only tooling links point to the corresponding repository directories.

Language claims and examples are based on `examples/`, `data/tera-language-spec.ts`, `src/cli/spec.ts`, and `docs/README.md` in the parent repository. Native compilation is described only for supported programs.
