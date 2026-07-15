import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = resolve(HERE, '..');

const TARGETS = [
  { svg: 'assets/logo-mark.svg', png: 'icons/icon.png', width: 256 },
  { svg: 'assets/logo-mark.svg', png: 'assets/logo-mark-512.png', width: 512 },
  { svg: 'assets/logo-wordmark.svg', png: 'assets/logo-wordmark-1024.png', width: 1024 },
  { svg: 'assets/file-icon.svg', png: 'icons/file-icon.png', width: 128 },
  { svg: 'assets/file-icon-tenb.svg', png: 'icons/file-icon-tenb.png', width: 128 },
];

for (const target of TARGETS) {
  const svgPath = join(EXT_ROOT, target.svg);
  const pngPath = join(EXT_ROOT, target.png);
  mkdirSync(dirname(pngPath), { recursive: true });
  const svg = readFileSync(svgPath);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: target.width } });
  const png = resvg.render().asPng();
  writeFileSync(pngPath, png);
  process.stdout.write(`${target.svg} → ${target.png} (${target.width}px)\n`);
}
