import type { CategoryScale, ChartScale, LinearScale } from './types';

type ScaleDomain = [number, number] | null;

type ScaleOptions = {
  zero?: boolean;
  padding?: number;
  domain?: ScaleDomain;
};

export function createScale(
  values: Array<string | number>,
  start: number,
  end: number,
  { zero = false, padding = 0, domain = null }: ScaleOptions = {},
): ChartScale {
  const numeric = values.every(value => typeof value === 'number' && Number.isFinite(value));
  return numeric ? linearScale(values as number[], start, end, zero, padding, domain) : categoryScale(values, start, end);
}

export function linearScale(
  values: number[],
  start: number,
  end: number,
  zero = false,
  padding = 0.05,
  domain: ScaleDomain = null,
): LinearScale {
  let min: number;
  let max: number;
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
  const scale = (value: string | number) => start + ((Number(value) - min) / (max - min)) * (end - start);
  const invert = (position: number) => min + ((position - start) / (end - start)) * (max - min);
  return { type: 'linear', min, max, domain: [min, max], scale, invert, ticks: linearTicks(min, max) };
}

export function categoryScale(values: Array<string | number>, start: number, end: number): CategoryScale {
  const domain: string[] = [...new Set(values.map(value => String(value)))];
  const step = domain.length ? (end - start) / domain.length : 0;
  const positions = new Map(domain.map((value, index) => [value, start + step * (index + 0.5)]));
  const scale = (value: string | number) => positions.get(String(value)) ?? start;
  return { type: 'category', domain, step, scale, ticks: domain };
}

function linearTicks(min: number, max: number, count = 5): number[] {
  const rough = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  const step = nice * power;
  const first = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let value = first; value <= max + step * 0.001; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}
