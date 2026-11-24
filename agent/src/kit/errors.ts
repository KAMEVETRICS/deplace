/**
 * A failure the kit reports to the model as JSON. `retryable` says whether calling the same
 * tool again later can help; `extra` carries fields such as `outcomeUnknown` or `retryAfter`.
 */
export class KitError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "KitError";
  }
}
