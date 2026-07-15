// Shared subscribe() scaffolding: adapters must never throw, so each attach
// and each detach is guarded individually.
export const listenToWindowEvents = (
  events: readonly string[],
  onEvent: (event: Event) => void
): (() => void) => {
  const attached: Array<() => void> = [];

  for (const eventName of events) {
    try {
      window.addEventListener(eventName, onEvent);
      attached.push(() => window.removeEventListener(eventName, onEvent));
    } catch {
      // ignore
    }
  }

  return () => {
    for (const off of attached) {
      try {
        off();
      } catch {
        // ignore
      }
    }
  };
};
