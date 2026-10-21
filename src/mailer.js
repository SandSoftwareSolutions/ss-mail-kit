import { setTimeout as sleep } from "node:timers/promises";

import { parseAddress, parseAddressList } from "./address.js";
import { MailError } from "./errors.js";
import { prepareMessage } from "./message.js";

const mask = (address) => address.replace(/^(.).*(@.*)$/, "$1***$2");

/**
 * The one object an app uses: `mailer.send({ to, subject, html })` checks the message, sends it, retries
 * temporary failures with a pause, and can keep staging or test systems from mailing real people.
 *
 * @param {object} options
 * @param {{ send(message): Promise<object> }} options.transport  smtpTransport, resendTransport, memoryTransport, failoverTransport
 * @param {string|{name,address}} options.from  default sender
 * @param {string|string[]} [options.redirectAllTo]  every mail goes to these addresses instead (staging); the real recipients are put in the subject
 * @param {string[]} [options.allowDomains]  only these recipient domains may receive mail; others fail before sending
 */
export function createMailer(options = {}) {
  const { transport, retries = 2, retryDelayMs = 500, onSent, onError, redirectAllTo, allowDomains, ...defaults } = options;
  if (!transport || typeof transport.send !== "function") throw new MailError("createMailer needs a transport", { code: "invalid_config" });
  const redirect = redirectAllTo ? parseAddressList(redirectAllTo) : null;
  const allowed = allowDomains ? new Set(allowDomains.map((d) => String(d).toLowerCase())) : null;
  if (defaults.from !== undefined) parseAddress(defaults.from);

  const guard = (message) => {
    if (!allowed) return;
    const blocked = message.envelope.to.filter((a) => !allowed.has(a.split("@")[1]));
    if (blocked.length) throw new MailError(`Recipient domain not allowed: ${blocked.map(mask).join(", ")}`, { code: "recipient_not_allowed" });
  };

  async function send(input) {
    let message = prepareMessage(input, defaults);
    guard(message);
    if (redirect) {
      const original = message.envelope.to.map(mask).join(", ");
      message = prepareMessage({ ...input, to: redirect, cc: undefined, bcc: undefined, subject: `[to: ${original}] ${message.subject}` }, defaults);
    }
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const result = await transport.send(message);
        const done = { ...result, attempts: attempt, transport: result.transport ?? transport.name };
        try { onSent?.({ ...done, to: message.envelope.to.map(mask), subject: message.subject }); } catch { /* a logging hook must not break sending */ }
        return done;
      } catch (error) {
        const wrapped = error instanceof MailError ? error : new MailError(`Sending failed: ${error?.message ?? error}`, { code: "send_failed", cause: error });
        if (wrapped.retryable && attempt <= retries) {
          await sleep(Math.round(retryDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)));
          continue;
        }
        wrapped.attempts = attempt;
        try { onError?.(wrapped, { to: message.envelope.to.map(mask), subject: message.subject }); } catch { /* same */ }
        throw wrapped;
      }
    }
  }

  return {
    send,
    /** Checks the transport settings (connects and logs in for SMTP). Call it once at startup. */
    verify: async () => (typeof transport.verify === "function" ? transport.verify() : true),
    transport,
  };
}
