export function createSingleFlightGate(
  busyMessage = "A wallet transaction request is already in progress in this tab. Finish or dismiss that wallet prompt before trying again."
): <T>(operation: () => Promise<T>) => Promise<T> {
  let inFlight = false;

  return async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (inFlight) throw new Error(busyMessage);
    inFlight = true;
    try {
      return await operation();
    } finally {
      inFlight = false;
    }
  };
}
