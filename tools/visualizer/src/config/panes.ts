import type { PipelineId } from "../types/stage";

export type Mode = "pipeline" | "lab";

export type RegionId =
  | "source"
  | "stages"
  | "detail"
  | "console"
  | "lab"
  | "lab-in"
  | "lab-out";

export type ConsoleTab = "output" | "runtime" | "shapes";

export type TabId = Exclude<RegionId, "console" | "lab"> | ConsoleTab;

export type Density = "wide" | "split" | "compact";

export type Wording = string | Readonly<Record<PipelineId, string>>;

export type ModeInfo = {
  readonly id: Mode;
  readonly label: string;
  readonly title: string;
  readonly home: TabId;
  readonly landing?: TabId;
};

export type PaneTab = {
  readonly id: TabId;
  readonly region: RegionId;
  readonly modes: readonly Mode[];
  readonly label: Wording;
  readonly title: Wording;
  readonly consoleTab?: ConsoleTab;
};

export const MODES: readonly ModeInfo[] = [
  {
    id: "pipeline",
    label: "Pipeline",
    title: "Compile one program and step through every stage the compiler goes through",
    home: "stages",
    landing: "stages",
  },
  {
    id: "lab",
    label: "IR lab",
    title: "Hand-write an SSA graph and run a single pass over it",
    home: "lab-in",
  },
];

export const FAILURE_TAB: TabId = "output";

export const TRACE_LABEL: Readonly<Record<PipelineId, string>> = {
  jit: "JIT runtime",
  aot: "AOT trace",
};

export const TRACE_TITLE: Readonly<Record<PipelineId, string>> = {
  jit: "Tiering, deopt, inline-cache and GC events recorded while the engine ran your program",
  aot: "What the AOT compiler did while it built the binary — it never runs your program",
};

export const TABS: readonly PaneTab[] = [
  {
    id: "source",
    region: "source",
    modes: ["pipeline"],
    label: "Code",
    title: "The program every pipeline on this screen compiles",
  },
  {
    id: "stages",
    region: "stages",
    modes: ["pipeline"],
    label: "Passes",
    title: "Every stage this compile ran, in the order it ran them",
  },
  {
    id: "detail",
    region: "detail",
    modes: ["pipeline"],
    label: "Viewer",
    title: "What the selected pass rewrote — diff, graph, raw IR or the note explaining it",
  },
  {
    id: "lab-in",
    region: "lab-in",
    modes: ["lab"],
    label: "Input IR",
    title: "The SSA graph the pass will run on",
  },
  {
    id: "lab-out",
    region: "lab-out",
    modes: ["lab"],
    label: "After pass",
    title: "What the pass rewrote in the graph you wrote",
  },
  {
    id: "output",
    region: "console",
    modes: ["pipeline"],
    label: "Output",
    title: "What the program printed, and anything that failed",
    consoleTab: "output",
  },
  {
    id: "runtime",
    region: "console",
    modes: ["pipeline"],
    label: TRACE_LABEL,
    title: TRACE_TITLE,
    consoleTab: "runtime",
  },
  {
    id: "shapes",
    region: "console",
    modes: ["pipeline"],
    label: "Shapes",
    title: "The hidden class tree the objects in your program walked as they gained properties",
    consoleTab: "shapes",
  },
];

export type ConsoleTabInfo = PaneTab & { readonly consoleTab: ConsoleTab };

export const CONSOLE_TABS: readonly ConsoleTabInfo[] = TABS.filter(
  (tab): tab is ConsoleTabInfo => tab.consoleTab !== undefined,
);

const STACKED: Readonly<Record<Density, readonly RegionId[]>> = {
  wide: [],
  split: ["stages", "detail"],
  compact: ["source", "stages", "detail", "console", "lab-in", "lab-out"],
};

export function stackedRegions(density: Density): ReadonlySet<RegionId> {
  return new Set(STACKED[density]);
}

export function tabsFor(mode: Mode, density: Density): readonly PaneTab[] {
  const stacked = stackedRegions(density);
  return TABS.filter((tab) => tab.modes.includes(mode) && stacked.has(tab.region));
}

export function wordingOf(wording: Wording, pipeline: PipelineId): string {
  return typeof wording === "string" ? wording : wording[pipeline];
}
