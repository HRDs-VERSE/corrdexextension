export class ValidationScheduler {
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly delayMs: number,
    private readonly validate: (uri: string) => void,
  ) {}

  schedule(uri: string) {
    this.clear(uri);

    const timer = setTimeout(() => {
      this.pending.delete(uri);
      this.validate(uri);
    }, this.delayMs);

    this.pending.set(uri, timer);
  }

  clear(uri: string) {
    const timer = this.pending.get(uri);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.pending.delete(uri);
  }

  clearAll() {
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }
}
