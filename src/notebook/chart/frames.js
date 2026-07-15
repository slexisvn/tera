import { isDataFrame } from './adapters.js';
import { colorAt } from './palette.js';
import { MAX_POINTS } from './spec.js';

export async function adaptFrames(type, data, config) {
  if (!isDataFrame(data)) throw new Error('frame= animation requires a DataFrame');
  const frameColumn = requiredColumn(config.frame, 'frame');
  const keyColumn = requiredColumn(config.key, 'key');
  const x = requiredColumn(config.x, 'x');
  const y = requiredColumn(config.y, 'y');
  const sizeColumn = type === 'bubble' ? requiredColumn(config.size ?? config.value, 'size') : null;
  const colorColumn = config.color ?? null;
  const columns = unique([x, y, sizeColumn, colorColumn, frameColumn, keyColumn].filter(value => value != null));
  const rowCount = Number(await data.count());
  if (rowCount > MAX_POINTS) throw new Error(`Chart has ${rowCount} points; maximum is ${MAX_POINTS}. Filter or sample the data before charting.`);
  const rows = await data.select(...columns).collect();
  const defaultGroup = type === 'bubble' ? sizeColumn : y;
  const groupOrder = [];
  const groupColor = new Map();
  const frameOrder = [];
  const frameSlot = new Map();
  for (const row of rows) {
    if (!validNumber(row[x]) || !validNumber(row[y])) continue;
    if (sizeColumn != null && !validNumber(row[sizeColumn])) continue;
    const frameValue = row[frameColumn];
    if (frameValue == null) continue;
    const frameKey = String(frameValue);
    if (!frameSlot.has(frameKey)) {
      frameSlot.set(frameKey, { value: frameValue, groups: new Map() });
      frameOrder.push(frameKey);
    }
    const groupName = colorColumn == null ? defaultGroup : String(row[colorColumn] ?? 'NULL');
    if (!groupColor.has(groupName)) {
      groupColor.set(groupName, colorAt(groupOrder.length));
      groupOrder.push(groupName);
    }
    const slot = frameSlot.get(frameKey);
    if (!slot.groups.has(groupName)) slot.groups.set(groupName, []);
    const point = { x: row[x], y: row[y], key: row[keyColumn] };
    if (sizeColumn != null) {
      point.size = Math.abs(row[sizeColumn]);
      point.value = row[sizeColumn];
    }
    slot.groups.get(groupName).push(point);
  }
  const frames = sortFrameKeys(frameOrder, frameSlot).map(frameKey => {
    const slot = frameSlot.get(frameKey);
    return {
      value: slot.value,
      series: groupOrder.map(groupName => ({ name: groupName, color: groupColor.get(groupName), points: slot.groups.get(groupName) ?? [] })),
    };
  });
  return { frames, key: keyColumn };
}

function sortFrameKeys(keys, slots) {
  const numeric = keys.every(key => typeof slots.get(key).value === 'number' && Number.isFinite(slots.get(key).value));
  return [...keys].sort((a, b) => {
    const left = slots.get(a).value;
    const right = slots.get(b).value;
    if (numeric) return left - right;
    return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
  });
}

function requiredColumn(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`frame animation requires ${label}="column"`);
  return value;
}

function validNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function unique(values) {
  return [...new Set(values)];
}
