// Display failures must never change a durable operation's outcome.
export function notifySafely(notify: () => void) {
  try {
    notify();
  } catch {
    console.warn('Display notification failed; the next state request will resynchronize.');
  }
}
