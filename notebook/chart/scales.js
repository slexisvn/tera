export function createScale(values, start, end, { zero = false, padding = 0, domain = null } = {}) {
  const numeric = values.every(value => typeof value === 'number' && Number.isFinite(value));
  return numeric ? linearScale(values, start, end, zero, padding, domain) : categoryScale(values, start, end);
}

export function linearScale(values, start, end, zero = false, padding = 0.05, domain = null) {
  let min;
  let max;
  if (domain) {
    [min, max] = domain;
  } else {
    min = values.length ? Math.min(...values) : 0;
    max = values.length ? Math.max(...values) : 1;
    if (zero) {
      min = Math.min(0, min);
      max = Math.max(0, max);
    }
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const span = max - min;
    min -= span * padding;
    max += span * padding;
  }
  const scale = value => start + ((value - min) / (max - min)) * (end - start);
  const invert = position => min + ((position - start) / (end - start)) * (max - min);
  return { type: 'linear', min, max, domain: [min, max], scale, invert, ticks: linearTicks(min, max) };
}

export function categoryScale(values, start, end) {
  const domain = [...new Set(values.map(value => String(value)))];
  const step = domain.length ? (end - start) / domain.length : 0;
  const positions = new Map(domain.map((value, index) => [value, start + step * (index + 0.5)]));
  const scale = value => positions.get(String(value));
  return { type: 'category', domain, step, scale, ticks: domain };
}

function linearTicks(min, max, count = 5) {
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const step = nice * power;
  const first = Math.ceil(min / step) * step;
  const ticks = [];
  for (let value = first; value <= max + step * 0.001; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}
