const STABILITY_WINDOW = 50;
const EMA_ALPHA = 0.3;

export class ExecutionProfile {
  totalCalls: number;
  totalTimeMs: number;
  recentTimes: number[];
  maxRecentTimes: number;
  emaTimeMs: number;
  deoptCount: number;
  deoptReasons: string[];
  lastDeoptTime: number;
  lastCallTime: number;
  callsInWindow: number;
  windowStart: number;
  icTransitionCount: number;
  callsSinceLastICTransition: number;
  loopIterations: number;
  compileFailureCount?: number;
  lastCompileFailureReason?: string | null;
  lastCompileFailureTime?: number;

  constructor() {
    this.totalCalls = 0;
    this.totalTimeMs = 0;
    this.recentTimes = [];
    this.maxRecentTimes = 32;
    this.emaTimeMs = 0;
    this.deoptCount = 0;
    this.deoptReasons = [];
    this.lastDeoptTime = 0;
    this.lastCallTime = 0;
    this.callsInWindow = 0;
    this.windowStart = 0;
    this.icTransitionCount = 0;
    this.callsSinceLastICTransition = 0;
    this.loopIterations = 0;
  }

  recordExecution(elapsedMs: number): void {
    this.totalCalls++;
    this.totalTimeMs += elapsedMs;
    this.lastCallTime = Date.now();

    if (this.emaTimeMs === 0) {
      this.emaTimeMs = elapsedMs;
    } else {
      this.emaTimeMs = EMA_ALPHA * elapsedMs + (1 - EMA_ALPHA) * this.emaTimeMs;
    }

    this.recentTimes.push(elapsedMs);
    if (this.recentTimes.length > this.maxRecentTimes) {
      this.recentTimes.shift();
    }

    const now = Date.now();
    if (now - this.windowStart > 100) {
      this.callsInWindow = 1;
      this.windowStart = now;
    } else {
      this.callsInWindow++;
    }

    this.callsSinceLastICTransition++;
  }

  recordDeopt(reason: string): void {
    this.deoptCount++;
    this.lastDeoptTime = Date.now();
    this.deoptReasons.push(reason);
    if (this.deoptReasons.length > 10) {
      this.deoptReasons.shift();
    }
  }

  recordICTransition(): void {
    this.icTransitionCount++;
    this.callsSinceLastICTransition = 0;
  }

  recordLoopIterations(count: number): void {
    this.loopIterations += count;
  }

  get avgTimeMs(): number {
    if (this.totalCalls === 0) return 0;
    return this.totalTimeMs / this.totalCalls;
  }

  get callFrequency(): number {
    return this.callsInWindow;
  }

  hotness(loopWeight = 0): number {
    return this.callFrequency * this.emaTimeMs * (1 + loopWeight);
  }

  isStable(): boolean {
    return this.callsSinceLastICTransition >= STABILITY_WINDOW;
  }

  timeSinceLastDeopt(): number {
    if (this.lastDeoptTime === 0) return Infinity;
    return Date.now() - this.lastDeoptTime;
  }
}
