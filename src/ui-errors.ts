/** A missing or changed UI must stop collection, never look like an empty wallet. */
export class UiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiError';
  }
}
