const STYLE = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
} as const;

const CATEGORY_STYLES: Record<string, { prefix: string; color: string }> = {
  hidden_class: { prefix: "HC", color: STYLE.magenta },
  ic: { prefix: "IC", color: STYLE.cyan },
  feedback: { prefix: "FB", color: STYLE.blue },
  jit: { prefix: "JIT", color: STYLE.green },
  deopt: { prefix: "DEOPT", color: STYLE.red },
  interp: { prefix: "INTERP", color: STYLE.dim },
  wasm: { prefix: "WASM", color: STYLE.yellow },
  gc: { prefix: "GC", color: STYLE.white },
  perf: { prefix: "PERF", color: STYLE.bold },
  microtask: { prefix: "MTASK", color: STYLE.yellow },
  promise: { prefix: "PROM", color: STYLE.cyan },
};

export type TraceData = RuntimeValue;
export type TraceStats = Record<string, number>;

export class TracerEvent {
  category: string;
  message: string;
  timestamp: number;
  data: TraceData;

  constructor(
    category: string,
    message: string,
    timestamp: number,
    data?: TraceData,
  ) {
    this.category = category;
    this.message = message;
    this.timestamp = timestamp;
    this.data = data;
  }
}

export class Tracer {
  enabled: boolean;
  categories: Set<string>;
  history: TracerEvent[];
  maxHistory: number;
  counters: Map<string, number>;
  timers: Map<string, number>;
  indentLevel: number;
  useColors: boolean | undefined;

  constructor() {
    this.enabled = false;
    this.categories = new Set(["all"]);
    this.history = [];
    this.maxHistory = 10000;
    this.counters = new Map();
    this.timers = new Map();
    this.indentLevel = 0;
    this.useColors =
      typeof process !== "undefined" && process.stdout && process.stdout.isTTY;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  setCategories(cats: Iterable<string>): void {
    this.categories = new Set(cats);
  }

  shouldLog(category: string): boolean {
    if (!this.enabled) return false;
    return this.categories.has("all") || this.categories.has(category);
  }

  formatMessage(category: string, message: string): string {
    const style = CATEGORY_STYLES[category] || {
      prefix: category.toUpperCase(),
      color: STYLE.white,
    };
    const indent = "  ".repeat(this.indentLevel);
    if (this.useColors) {
      return `${style.color}[${style.prefix}]${STYLE.reset} ${indent}${message}`;
    }
    return `[${style.prefix}] ${indent}${message}`;
  }

  log(category: string, message: string, data?: TraceData): void {
    if (!this.shouldLog(category)) return;

    const event = new TracerEvent(category, message, performance.now(), data);
    if (this.history.length < this.maxHistory) {
      this.history.push(event);
    }

    console.log(this.formatMessage(category, message));
  }

  incrementCounter(name: string): void {
    this.counters.set(name, (this.counters.get(name) || 0) + 1);
  }

  getCounter(name: string): number {
    return this.counters.get(name) || 0;
  }

  startTimer(name: string): void {
    this.timers.set(name, performance.now());
  }

  endTimer(name: string): number {
    const start = this.timers.get(name);
    if (start === undefined) return 0;
    const elapsed = performance.now() - start;
    this.timers.delete(name);
    return elapsed;
  }

  indent(): void {
    this.indentLevel++;
  }

  dedent(): void {
    if (this.indentLevel > 0) this.indentLevel--;
  }

  hcTransition(fromId: number, toId: number, propertyName: string): void {
    this.incrementCounter("hc_transitions");
    this.log(
      "hidden_class",
      `Transition: HC${fromId} --"${propertyName}"--> HC${toId}`,
    );
  }

  hcDeleteTransition(fromId: number, toId: number, propertyName: string): void {
    this.incrementCounter("hc_delete_transitions");
    this.log(
      "hidden_class",
      `Delete: HC${fromId} --del("${propertyName}")--> HC${toId}`,
    );
  }

  hcIntegrityChange(hcId: number, level: string): void {
    this.log("hidden_class", `Integrity: HC${hcId} -> ${level}`);
  }

  hcInstability(hcId: number, transitionCount: number): void {
    this.log(
      "hidden_class",
      `Unstable: HC${hcId} (${transitionCount} transitions)`,
    );
  }

  icEvent(
    siteId: number,
    fromState: string,
    toState: string,
    mapId: number,
    offset: number,
  ): void {
    this.incrementCounter("ic_transitions");
    this.log(
      "ic",
      `Site #${siteId}: ${fromState} → ${toState} (map=HC${mapId}, offset=${offset})`,
    );
  }

  icHit(siteId: number, state: string, mapId: number): void {
    this.incrementCounter("ic_hits");
    this.log("ic", `Site #${siteId}: HIT ${state} (map=HC${mapId})`);
  }

  icMiss(siteId: number, state: string): void {
    this.incrementCounter("ic_misses");
    this.log("ic", `Site #${siteId}: MISS ${state}`);
  }

  icInvalidate(siteId: number, reason: string): void {
    this.incrementCounter("ic_invalidations");
    this.log("ic", `Site #${siteId}: INVALIDATED — ${reason}`);
  }

  feedbackRecord(slotId: number, kind: string, details: string): void {
    this.incrementCounter("feedback_records");
    this.log("feedback", `Slot #${slotId}: ${kind} — ${details}`);
  }

  feedbackTransition(slotId: number, fromState: string, toState: string): void {
    this.log("feedback", `Slot #${slotId}: ${fromState} → ${toState}`);
  }

  jitCompile(funcName: string, details: string): void {
    this.incrementCounter("jit_compilations");
    this.log("jit", `Compiling "${funcName}": ${details}`);
  }

  jitOSR(funcName: string, loopOffset: number): void {
    this.incrementCounter("jit_osr");
    this.log("jit", `OSR "${funcName}" at loop offset ${loopOffset}`);
  }

  jitDeopt(funcName: string, reason: string, bytecodeOffset: number): void {
    this.incrementCounter("jit_deopts");
    const bcStr = bytecodeOffset >= 0 ? ` at bytecode:${bytecodeOffset}` : "";
    this.log("deopt", `DEOPT "${funcName}": ${reason}${bcStr}`);
  }

  jitResume(funcName: string, bytecodeOffset: number): void {
    this.log(
      "deopt",
      `Resuming "${funcName}" in interpreter at bytecode:${bytecodeOffset}`,
    );
  }

  jitWasmEmit(funcName: string, bytes: number): void {
    this.log("wasm", `"${funcName}": emitted ${bytes} bytes of Wasm`);
  }

  jitWasmFail(funcName: string, reason: string): void {
    this.incrementCounter("wasm_failures");
    this.log("wasm", `"${funcName}": Wasm compilation failed — ${reason}`);
  }

  interpret(funcName: string, opName: string, details?: string): void {
    if (!this.shouldLog("interp")) return;
    this.log("interp", `${funcName}: ${opName} ${details || ""}`);
  }

  microtaskEvent(action: string, details: string): void {
    this.incrementCounter("microtask_" + action);
    this.log("microtask", `${action}: ${details}`);
  }

  perfMark(label: string, elapsedMs: number): void {
    this.log("perf", `${label}: ${elapsedMs.toFixed(2)}ms`);
  }

  getStats(): TraceStats {
    const stats: TraceStats = {};
    for (const [key, value] of this.counters) {
      stats[key] = value;
    }
    stats.total_events = this.history.length;
    return stats;
  }

  dumpStats(): string {
    const stats = this.getStats();
    const lines = ["=== Tracer Statistics ==="];
    const keys = Object.keys(stats).sort();
    for (const key of keys) {
      lines.push(`  ${key}: ${stats[key]}`);
    }
    lines.push("========================");
    console.log(lines.join("\n"));
    return lines.join("\n");
  }

  getEventsForCategory(category: string): TracerEvent[] {
    return this.history.filter((e) => e.category === category);
  }

  clearHistory(): void {
    this.history.length = 0;
    this.counters.clear();
  }

  reset(): void {
    this.history.length = 0;
    this.counters.clear();
    this.timers.clear();
    this.indentLevel = 0;
  }
}

export const tracer = new Tracer();
