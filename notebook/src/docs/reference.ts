import type { Builtin, LanguageData, Method } from "../utils/language-data";

export type Entry = {
  key: string;
  name: string;
  signature: string;
  description: string | null;
  returns: string | null;
  effect: string;
};

export type ChipRow = { label: string; items: string[] };
export type ChipSection = { id: string; title: string; rows: ChipRow[] };
export type EntrySection = { id: string; title: string; entries: Entry[] };
export type MemberGroup = { id: string; name: string; entries: Entry[] };

export type ReferenceModel = {
  chipSections: ChipSection[];
  categories: EntrySection[];
  members: MemberGroup[];
};

const CATEGORY_LABELS: Record<string, string> = {
  reactive: "Reactivity",
  factory: "Tensor creation",
  function: "Core functions",
  global: "Core functions",
  module: "Neural-network layers",
  sequential: "Neural-network layers",
  trainer: "Training",
  optimizer: "Training",
  scheduler: "Training",
  callback: "Training",
  logger: "Training",
  metric: "Training",
  metric_collection: "Training",
  step: "Training",
  ml_model: "Classic ML",
  ml_metric: "Classic ML",
  ml_transform: "Classic ML",
  ml_split: "Classic ML",
  ml_function: "Classic ML",
  ml_cluster: "Classic ML",
  one_hot_encoder: "Classic ML",
  label_encoder: "Classic ML",
  grid_search: "Classic ML",
  linalg: "Numerics & statistics",
  numeric_func: "Numerics & statistics",
  numeric_array_op: "Numerics & statistics",
  numeric_transform: "Numerics & statistics",
  numeric_random: "Numerics & statistics",
  numeric_dist: "Numerics & statistics",
  numeric_stats_test: "Numerics & statistics",
  numeric_timeseries: "Numerics & statistics",
  data: "DataFrames & data",
  quant: "Quant & finance",
};

const CATEGORY_ORDER = [...new Set(Object.values(CATEGORY_LABELS))];

const OPERATOR_LABELS: Record<string, string> = {
  threeChar: "Three-character",
  twoChar: "Two-character",
  oneChar: "Single-character",
};

export function refSlug(text: string): string {
  return `ref-${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function titleCase(text: string): string {
  return text.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function entryFromBuiltin(builtin: Builtin): Entry {
  return {
    key: builtin.name,
    name: builtin.name,
    signature: builtin.signature?.display ?? builtin.name,
    description: builtin.description,
    returns: builtin.returns,
    effect: builtin.effect,
  };
}

function entryFromMethod(owner: string, method: Method): Entry {
  return {
    key: `${owner}.${method.name}`,
    name: method.name,
    signature: method.signature.display,
    description: method.description,
    returns: method.returns,
    effect: method.effect,
  };
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

function uniqueEntries(entries: Entry[]): Entry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => (seen.has(entry.key) ? false : seen.add(entry.key)));
}

function buildChipSections(data: LanguageData): ChipSection[] {
  return [
    {
      id: refSlug("Keywords"),
      title: "Keywords",
      rows: Object.entries(data.keywordGroups)
        .filter(([, items]) => items.length)
        .map(([group, items]) => ({ label: titleCase(group), items })),
    },
    {
      id: refSlug("Types"),
      title: "Types",
      rows: [{ label: "", items: data.types }],
    },
    {
      id: refSlug("Operators"),
      title: "Operators",
      rows: Object.entries(data.operators)
        .filter(([, items]) => items.length)
        .map(([group, items]) => ({ label: OPERATOR_LABELS[group] ?? group, items })),
    },
  ];
}

function buildCategories(data: LanguageData): EntrySection[] {
  const buckets = new Map<string, Entry[]>();
  for (const builtin of data.builtins) {
    if (builtin.kind === "namespace") continue;
    const label = CATEGORY_LABELS[builtin.kind] ?? titleCase(builtin.kind);
    const bucket = buckets.get(label) ?? [];
    bucket.push(entryFromBuiltin(builtin));
    buckets.set(label, bucket);
  }
  const extra = [...buckets.keys()].filter((label) => !CATEGORY_ORDER.includes(label)).sort();
  return [...CATEGORY_ORDER, ...extra]
    .filter((label) => buckets.has(label))
    .map((label) => ({ id: refSlug(label), title: label, entries: uniqueEntries(buckets.get(label)!.sort(byName)) }));
}

function buildMembers(data: LanguageData): MemberGroup[] {
  const fromTypes = Object.entries(data.pseudoTypes)
    .filter(([, methods]) => methods.length)
    .map(([name, methods]) => ({ id: refSlug(`type ${name}`), name, entries: uniqueEntries(methods.map((method) => entryFromMethod(name, method))) }));
  const fromNamespaces = data.builtins
    .filter((builtin) => builtin.kind === "namespace" && builtin.methods.length)
    .map((builtin) => ({ id: refSlug(`type ${builtin.name}`), name: builtin.name, entries: uniqueEntries(builtin.methods.map((method) => entryFromMethod(builtin.name, method))) }));
  return [...fromTypes, ...fromNamespaces].sort(byName);
}

export function buildReferenceModel(data: LanguageData): ReferenceModel {
  return {
    chipSections: buildChipSections(data),
    categories: buildCategories(data),
    members: buildMembers(data),
  };
}

export function countBuiltins(model: ReferenceModel): number {
  return model.categories.reduce((total, section) => total + section.entries.length, 0);
}

function entryMatches(entry: Entry, query: string): boolean {
  return `${entry.name} ${entry.signature} ${entry.returns ?? ""} ${entry.description ?? ""}`.toLowerCase().includes(query);
}

export function filterReferenceModel(model: ReferenceModel, query: string): ReferenceModel {
  if (!query) return model;
  return {
    chipSections: model.chipSections
      .map((section) => ({
        ...section,
        rows: section.rows
          .map((row) => ({ ...row, items: row.items.filter((item) => item.toLowerCase().includes(query)) }))
          .filter((row) => row.items.length),
      }))
      .filter((section) => section.rows.length),
    categories: model.categories
      .map((section) => ({ ...section, entries: section.entries.filter((entry) => entryMatches(entry, query)) }))
      .filter((section) => section.entries.length),
    members: model.members
      .map((group) => ({ ...group, entries: group.entries.filter((entry) => entryMatches(entry, query)) }))
      .filter((group) => group.entries.length),
  };
}
