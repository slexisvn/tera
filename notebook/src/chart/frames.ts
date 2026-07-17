import { isDataFrame } from './adapters';
import { colorAt } from './palette';
import { MAX_POINTS } from './spec';
import type { ChartConfig, ChartDimension, ChartPoint, ChartSeries } from './types';

type FrameSlot = {
  value: ChartDimension;
  groups: Map<string, ChartPoint[]>;
};

type ChartFrame = {
  value: ChartDimension;
  series: ChartSeries[];
};

export async function adaptFrames(type: string, data: unknown, config: ChartConfig): Promise<{ frames: ChartFrame[]; key: string }> {
  if (!isDataFrame(data)) throw new Error('frame= animation requires a DataFrame');
  const frameColumn = requiredColumn(config.frame, 'frame');
  const keyColumn = requiredColumn(config.key, 'key');
  const x = requiredColumn(config.x, 'x');
  const y = requiredColumn(config.y, 'y');
  const sizeColumn = type === 'bubble' ? requiredColumn(config.size ?? config.value, 'size') : null;
  const colorColumn = typeof config.color === 'string' ? config.color : null;
  const columns = unique([x, y, sizeColumn, colorColumn, frameColumn, keyColumn].filter((value): value is string => value != null));
  const rowCount = Number(await data.count());
  if (rowCount > MAX_POINTS) throw new Error(`Chart has ${rowCount} points; maximum is ${MAX_POINTS}. Filter or sample the data before charting.`);
  const rows = await data.select(...columns).collect();
  const defaultGroup = (type === 'bubble' ? sizeColumn : y) ?? y;
  const groupOrder: string[] = [];
  const groupColor = new Map<string, string>();
  const frameOrder: string[] = [];
  const frameSlot = new Map<string, FrameSlot>();
  for (const row of rows) {
    if (!validNumber(row[x]) || !validNumber(row[y])) continue;
    if (sizeColumn != null && !validNumber(row[sizeColumn])) continue;
    const frameValue = row[frameColumn];
    if (frameValue == null) continue;
    const frameKey = String(frameValue);
    if (!frameSlot.has(frameKey)) {
      frameSlot.set(frameKey, { value: typeof frameValue === 'number' || typeof frameValue === 'string' ? frameValue : String(frameValue), groups: new Map() });
      frameOrder.push(frameKey);
    }
    const groupName = colorColumn == null ? defaultGroup : String(row[colorColumn] ?? 'NULL');
    if (!groupColor.has(groupName)) {
      groupColor.set(groupName, colorAt(groupOrder.length));
      groupOrder.push(groupName);
    }
    const slot = frameSlot.get(frameKey);
    if (!slot) continue;
    if (!slot.groups.has(groupName)) slot.groups.set(groupName, []);
    const point: ChartPoint = { x: row[x], y: row[y], key: typeof row[keyColumn] === 'number' || typeof row[keyColumn] === 'string' ? row[keyColumn] : String(row[keyColumn]) };
    if (sizeColumn != null) {
      const size = row[sizeColumn];
      if (validNumber(size)) {
        point.size = Math.abs(size);
        point.value = size;
      }
    }
    slot.groups.get(groupName)?.push(point);
  }
  const frames = sortFrameKeys(frameOrder, frameSlot).map(frameKey => {
    const slot = frameSlot.get(frameKey);
    return {
      value: slot?.value ?? frameKey,
      series: groupOrder.map(groupName => ({ name: groupName, color: groupColor.get(groupName), points: slot?.groups.get(groupName) ?? [] })),
    };
  });
  return { frames, key: keyColumn };
}

function sortFrameKeys(keys: string[], slots: Map<string, FrameSlot>): string[] {
  const numeric = keys.every(key => typeof slots.get(key)?.value === 'number' && Number.isFinite(slots.get(key)?.value));
  return [...keys].sort((a, b) => {
    const left = slots.get(a)?.value ?? a;
    const right = slots.get(b)?.value ?? b;
    if (numeric && typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
  });
}

function requiredColumn(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`frame animation requires ${label}="column"`);
  return value;
}

function validNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
