import { MAX_SUGGEST_DISTANCE, MAX_SUGGESTIONS } from "./config.js";

function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export function suggestNames(name: string, candidates: Iterable<string>): string[] {
  const scored: Array<{ name: string; distance: number }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === name || seen.has(candidate)) continue;
    seen.add(candidate);
    const distance = boundedDistance(name, candidate, MAX_SUGGEST_DISTANCE);
    if (distance <= MAX_SUGGEST_DISTANCE) scored.push({ name: candidate, distance });
  }
  scored.sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.name);
}
