export const MAP_GLOBAL = "Map";
export const SET_GLOBAL = "Set";
export const COLLECTION_GLOBALS: ReadonlySet<string> = new Set<string>([MAP_GLOBAL, SET_GLOBAL]);

const KEY_KINDS = ["string", "int"] as const;
const VALUE_KINDS = ["int", "float", "string"] as const;

export type KeyKind = (typeof KEY_KINDS)[number];
export type ValueKind = (typeof VALUE_KINDS)[number];

const ZERO: Record<string, string> = {
  int: "0",
  float: "0.0",
  string: '""',
};

const TITLE: Record<string, string> = {
  int: "Int",
  float: "Float",
  string: "Text",
};

const HASH_MULTIPLIER = 31;
const HASH_MASK = 1073741823;
const FIRST_MASK = 7;

export function mapClassName(key: KeyKind, value: ValueKind): string {
  return `TeraMap${TITLE[key]}${TITLE[value]}`;
}

export function setClassName(key: KeyKind): string {
  return `TeraSet${TITLE[key]}`;
}

function marker(key: KeyKind, value: ValueKind | null): string {
  return `holds_${key}_${value ?? "member"}`;
}

function hashBody(key: KeyKind): readonly string[] {
  if (key === "int") return ["    return key & this.mask"];
  return [
    "    h: int = 0",
    "    i: int = 0",
    "    while i < key.length:",
    `      h = (h * ${HASH_MULTIPLIER} + key.char_code_at(i)) & ${HASH_MASK}`,
    "      i += 1",
    "    return h & this.mask",
  ];
}

function table(key: KeyKind, value: ValueKind | null): readonly string[] {
  const cells = value === null ? [] : [`      this.cells.push(${ZERO[value]})`];
  return [
    "    i: int = 0",
    "    while i <= this.mask:",
    "      this.taken.push(0)",
    `      this.slots.push(${ZERO[key]})`,
    ...cells,
    "      this.spot.push(0)",
    "      i += 1",
  ];
}

function fields(key: KeyKind, value: ValueKind | null): readonly string[] {
  const cells = value === null ? [] : [`  public cells: ${value}[]`];
  return [
    `  public ${marker(key, value)}: int`,
    "  public taken: int[]",
    `  public slots: ${key}[]`,
    ...cells,
    "  public spot: int[]",
    `  public order: ${key}[]`,
    "  public live: int[]",
    "  public filled: int",
    "  public used: int",
    "  public dead: int",
    "  public mask: int",
  ];
}

function initialiser(key: KeyKind, value: ValueKind | null): readonly string[] {
  const cells = value === null ? [] : ["    this.cells = []"];
  return [
    "  public constructor():",
    `    this.${marker(key, value)} = 0`,
    "    this.taken = []",
    "    this.slots = []",
    ...cells,
    "    this.spot = []",
    "    this.order = []",
    "    this.live = []",
    "    this.filled = 0",
    "    this.used = 0",
    "    this.dead = 0",
    `    this.mask = ${FIRST_MASK}`,
    ...table(key, value),
  ];
}

function lookup(key: KeyKind): readonly string[] {
  return [
    `  public hashed(key: ${key}) -> int:`,
    ...hashBody(key),
    `  public at(key: ${key}) -> int:`,
    "    slot: int = this.hashed(key)",
    "    while this.taken[slot] != 0:",
    "      if this.taken[slot] == 1:",
    "        if this.slots[slot] == key:",
    "          return slot",
    "      slot = (slot + 1) & this.mask",
    "    return slot",
    `  public has(key: ${key}) -> bool:`,
    "    return this.taken[this.at(key)] == 1",
  ];
}

function rebuild(key: KeyKind, value: ValueKind | null): readonly string[] {
  const held = value === null ? [] : [`    held: ${value}[] = this.cells`];
  const emptied = value === null ? [] : ["    this.cells = []"];
  const carried = value === null ? [] : ["        this.cells[slot] = held[j]"];
  return [
    "  public rebuild():",
    "    marks: int[] = this.taken",
    `    names: ${key}[] = this.slots`,
    "    places: int[] = this.spot",
    ...held,
    "    if this.filled * 4 > this.mask:",
    "      this.mask = this.mask * 2 + 1",
    "    this.taken = []",
    "    this.slots = []",
    ...emptied,
    "    this.spot = []",
    ...table(key, value),
    "    this.used = this.filled",
    "    j: int = 0",
    "    while j < marks.length:",
    "      if marks[j] == 1:",
    "        slot: int = this.at(names[j])",
    "        this.taken[slot] = 1",
    "        this.slots[slot] = names[j]",
    "        this.spot[slot] = places[j]",
    ...carried,
    "      j += 1",
  ];
}

function compaction(key: KeyKind): readonly string[] {
  return [
    "  public compact():",
    `    names: ${key}[] = this.order`,
    "    marks: int[] = this.live",
    "    this.order = []",
    "    this.live = []",
    "    j: int = 0",
    "    while j < names.length:",
    "      if marks[j] == 1:",
    "        this.order.push(names[j])",
    "        this.live.push(1)",
    "      j += 1",
    "    this.dead = 0",
    "    j = 0",
    "    while j < this.order.length:",
    "      this.spot[this.at(this.order[j])] = j",
    "      j += 1",
  ];
}

function admit(key: KeyKind, value: ValueKind | null): readonly string[] {
  const stored = value === null ? [] : ["    this.cells[slot] = value"];
  return [
    ...stored,
    "    this.spot[slot] = this.order.length",
    "    this.order.push(key)",
    "    this.live.push(1)",
    "    this.filled += 1",
    "    this.used += 1",
    "    if this.used * 2 > this.mask:",
    "      this.rebuild()",
  ];
}

function removal(key: KeyKind): readonly string[] {
  return [
    `  public delete(key: ${key}) -> bool:`,
    "    slot: int = this.at(key)",
    "    if this.taken[slot] != 1:",
    "      return false",
    "    this.taken[slot] = 2",
    "    this.live[this.spot[slot]] = 0",
    "    this.filled -= 1",
    "    this.dead += 1",
    "    if this.dead * 2 > this.order.length:",
    "      this.compact()",
    "    return true",
  ];
}

function listing(key: KeyKind): readonly string[] {
  return [
    "  public get size() -> int:",
    "    return this.filled",
    `  public keys() -> ${key}[]:`,
    `    held: ${key}[] = []`,
    "    j: int = 0",
    "    while j < this.order.length:",
    "      if this.live[j] == 1:",
    "        held.push(this.order[j])",
    "      j += 1",
    "    return held",
  ];
}

function mapSource(key: KeyKind, value: ValueKind): string {
  return [
    `class ${mapClassName(key, value)}:`,
    ...fields(key, value),
    ...initialiser(key, value),
    ...lookup(key),
    ...rebuild(key, value),
    ...compaction(key),
    `  public get(key: ${key}) -> ${value} | null:`,
    "    slot: int = this.at(key)",
    "    if this.taken[slot] == 1:",
    "      return this.cells[slot]",
    "    return null",
    `  public set(key: ${key}, value: ${value}):`,
    "    slot: int = this.at(key)",
    "    if this.taken[slot] == 1:",
    "      this.cells[slot] = value",
    "      return",
    "    this.taken[slot] = 1",
    "    this.slots[slot] = key",
    ...admit(key, value),
    ...removal(key),
    ...listing(key),
    `  public values() -> ${value}[]:`,
    `    held: ${value}[] = []`,
    "    j: int = 0",
    "    while j < this.order.length:",
    "      if this.live[j] == 1:",
    "        held.push(this.cells[this.at(this.order[j])])",
    "      j += 1",
    "    return held",
  ].join("\n");
}

function setSource(key: KeyKind): string {
  return [
    `class ${setClassName(key)}:`,
    ...fields(key, null),
    ...initialiser(key, null),
    ...lookup(key),
    ...rebuild(key, null),
    ...compaction(key),
    `  public add(key: ${key}):`,
    "    slot: int = this.at(key)",
    "    if this.taken[slot] == 1:",
    "      return",
    "    this.taken[slot] = 1",
    "    this.slots[slot] = key",
    ...admit(key, null),
    ...removal(key),
    ...listing(key),
    `  public values() -> ${key}[]:`,
    "    return this.keys()",
  ].join("\n");
}

export function collectionPrelude(): string {
  const sources: string[] = [];
  for (const key of KEY_KINDS) {
    for (const value of VALUE_KINDS) sources.push(mapSource(key, value));
    sources.push(setSource(key));
  }
  return `${sources.join("\n")}\n`;
}
