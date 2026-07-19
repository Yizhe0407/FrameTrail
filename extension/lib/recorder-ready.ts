export interface RecorderIdentity {
  runId: string;
  tabId: number;
  controlVersion: number;
}

/** Resolves only after the exact content-script instance reports that all of
 * its event listeners have been installed. */
export class RecorderReadyGate {
  readonly promise: Promise<boolean>;

  private settled = false;
  private resolve!: (ready: boolean) => void;
  private timeout: ReturnType<typeof setTimeout>;

  constructor(
    private readonly expected: RecorderIdentity,
    timeoutMs: number,
  ) {
    this.promise = new Promise<boolean>((resolve) => {
      this.resolve = resolve;
    });
    this.timeout = setTimeout(() => this.finish(false), timeoutMs);
  }

  signal(actual: RecorderIdentity): boolean {
    if (this.settled || !this.matches(actual)) {
      return false;
    }
    this.finish(true);
    return true;
  }

  matches(actual: RecorderIdentity): boolean {
    return (
      actual.runId === this.expected.runId &&
      actual.tabId === this.expected.tabId &&
      actual.controlVersion === this.expected.controlVersion
    );
  }

  cancel(): void {
    this.finish(false);
  }

  private finish(ready: boolean): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timeout);
    this.resolve(ready);
  }
}
