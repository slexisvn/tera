import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = [
  { svg: "assets/logo-mark.svg", png: "icons/icon.png", width: 256 },
  { svg: "assets/logo-mark.svg", png: "assets/logo-mark-512.png", width: 512 },
  { svg: "assets/logo-wordmark.svg", png: "assets/logo-wordmark-1024.png", width: 1024 },
  { svg: "assets/file-icon.svg", png: "icons/file-icon.png", width: 128 },
  { svg: "assets/file-icon-tenb.svg", png: "icons/file-icon-tenb.png", width: 128 },
];

for (const target of TARGETS) {
  const pngPath = join(EXT_ROOT, target.png);
  mkdirSync(dirname(pngPath), { recursive: true });

  const svg = readFileSync(join(EXT_ROOT, target.svg));
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: target.width } });
  writeFileSync(pngPath, resvg.render().asPng());

  process.stdout.write(`${target.svg} → ${target.png} (${target.width}px)\n`);
}
