export class OperationError extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "OperationError";
    this.details = details;
  }
}
