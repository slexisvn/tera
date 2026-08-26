export type RemarkKind = "missed" | "applied" | "analysis";

export interface Remark {
  readonly kind: RemarkKind;
  readonly pass: string;
  readonly node: number | null;
  readonly message: string;
}

export interface RemarkSubject {
  readonly id: number;
}

export const REMARK_BUDGET = 64;

const NONE: readonly Remark[] = [];

type Scope = {
  readonly pass: string;
  readonly collected: Remark[];
  readonly seen: Set<string>;
  dropped: number;
};

function subjectId(subject: RemarkSubject | null | undefined): number | null {
  return subject === null || subject === undefined ? null : subject.id;
}

export class RemarkRecorder {
  private readonly open_: Scope[] = [];

  private get scope(): Scope | null {
    return this.open_[this.open_.length - 1] ?? null;
  }

  get listening(): boolean {
    return this.scope !== null;
  }

  get depth(): number {
    return this.open_.length;
  }

  open(pass: string): void {
    this.open_.push({ pass, collected: [], seen: new Set(), dropped: 0 });
  }

  close(): readonly Remark[] {
    const scope = this.open_.pop() ?? null;
    if (scope === null) return NONE;
    if (scope.dropped === 0) return scope.collected;
    return [
      ...scope.collected,
      {
        kind: "analysis",
        pass: scope.pass,
        node: null,
        message: `${scope.dropped} further remarks were not recorded`,
      },
    ];
  }

  record(kind: RemarkKind, subject: RemarkSubject | null, message: string): void {
    const scope = this.scope;
    if (scope === null) return;
    const node = subjectId(subject);
    const key = `${kind} ${node} ${message}`;
    if (scope.seen.has(key)) return;
    if (scope.collected.length >= REMARK_BUDGET) {
      scope.dropped++;
      return;
    }
    scope.seen.add(key);
    scope.collected.push({ kind, pass: scope.pass, node, message });
  }

  missed(subject: RemarkSubject | null, message: string): void {
    this.record("missed", subject, message);
  }

  applied(subject: RemarkSubject | null, message: string): void {
    this.record("applied", subject, message);
  }

  analysis(subject: RemarkSubject | null, message: string): void {
    this.record("analysis", subject, message);
  }
}

export const remarks = new RemarkRecorder();
