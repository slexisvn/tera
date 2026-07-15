import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(HERE, '../providers');

export async function loadProviders() {
  const files = readdirSync(PROVIDERS_DIR).filter(f => f.endsWith('.js'));
  const providers = [];
  for (const file of files) {
    const url = pathToFileURL(join(PROVIDERS_DIR, file)).href;
    const mod = await import(url);
    if (typeof mod.register !== 'function') continue;
    providers.push({ id: mod.id ?? file, register: mod.register, legend: mod.legend ?? null });
  }
  return providers;
}
