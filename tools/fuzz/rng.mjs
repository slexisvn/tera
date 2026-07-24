export function makeRng(seed) {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  let b = (seed ^ 0x243f6a88) >>> 0 || 1;
  let c = (seed ^ 0xb7e15162) >>> 0 || 2;
  let d = (seed + 0x85ebca6b) >>> 0 || 3;
  const next = () => {
    const t = (a + b) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = ((c << 21) | (c >>> 11)) >>> 0;
    d = (d + 1) >>> 0;
    const r = (t + d) >>> 0;
    c = (c + r) >>> 0;
    return r / 4294967296;
  };
  for (let i = 0; i < 16; i++) next();

  const rng = {
    float: next,
    int: (n) => Math.floor(next() * n),
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (table) => {
      let total = 0;
      for (const entry of table) total += entry[0];
      let roll = next() * total;
      for (const entry of table) {
        roll -= entry[0];
        if (roll < 0) return entry[1];
      }
      return table[table.length - 1][1];
    },
    sample: (items, count) => {
      const pool = items.slice();
      const out = [];
      while (out.length < count && pool.length > 0) {
        out.push(pool.splice(Math.floor(next() * pool.length), 1)[0]);
      }
      return out;
    },
  };
  return rng;
}
