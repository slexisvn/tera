export class OptBisect {
  private attempted = 0;

  constructor(private readonly limit: number) {}

  static unlimited(): OptBisect {
    return new OptBisect(Number.POSITIVE_INFINITY);
  }

  get attempts(): number {
    return this.attempted;
  }

  allow(): boolean {
    return ++this.attempted <= this.limit;
  }
}
