import type { AppEvent, State } from '../shared/types';

// Recover a missed event and reject deltas already included in a snapshot.
export class StateSync {
  private sequence = -1;
  private pending: AppEvent[] = [];
  private loading?: Promise<void>;
  constructor(
    private read: () => Promise<State>,
    private snapshot: (state: State) => void,
    private apply: (event: AppEvent) => void,
    private error: (error: unknown) => void,
  ) {}
  receive(event: AppEvent) {
    if (this.loading) {
      this.pending.push(event);
      return;
    }
    if (event.type === 'state') {
      const sequence = event.sequence ?? event.state.sequence ?? 0;
      if (sequence < this.sequence) return;
      this.sequence = sequence;
      this.snapshot(event.state);
      return;
    }
    if (event.sequence === undefined) {
      this.apply(event);
      return;
    }
    if (event.sequence <= this.sequence) return;
    if (event.sequence !== this.sequence + 1 || this.sequence < 0) {
      this.pending.push(event);
      void this.refresh();
      return;
    }
    this.sequence = event.sequence;
    this.apply(event);
  }
  refresh(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.read()
      .then((state) => {
        this.sequence = state.sequence ?? 0;
        this.snapshot(state);
      })
      .catch((error) => {
        this.pending = [];
        this.error(error);
      })
      .finally(() => {
        this.loading = undefined;
        const pending = this.pending;
        this.pending = [];
        for (const event of pending) this.receive(event);
      });
    return this.loading;
  }
}
