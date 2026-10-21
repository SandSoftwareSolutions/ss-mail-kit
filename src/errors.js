/** Every failure of this package is a MailError, so callers can branch on `code` and `retryable`. */
export class MailError extends Error {
  constructor(message, { code = "mail_error", retryable = false, cause, ...extra } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "MailError";
    this.code = code;
    this.retryable = retryable;
    Object.assign(this, extra);
  }
}
