import { formatAddress } from "./address.js";
import { MailError } from "./errors.js";
import { prepareMessage } from "./message.js";
import { extractLinks } from "./text.js";

const asMessage = (input) => (input && typeof input.raw !== "undefined" && input.envelope ? input : prepareMessage(input));

/**
 * Sends through the Resend HTTP API. The message id is sent as the idempotency key, so a retry after a timeout
 * can never deliver the same mail twice.
 */
export function resendTransport(options = {}) {
  const apiKey = options.apiKey;
  if (typeof apiKey !== "string" || !/^re_\S+$/.test(apiKey)) throw new MailError("resendTransport needs an apiKey that starts with re_", { code: "invalid_config" });
  const apiUrl = String(options.apiUrl ?? "https://api.resend.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    name: "resend",
    async send(input) {
      const m = asMessage(input);
      const body = {
        from: formatAddress(m.from),
        to: m.to.map(formatAddress),
        subject: m.subject,
        text: m.text,
        headers: m.headers,
      };
      if (m.cc.length) body.cc = m.cc.map(formatAddress);
      if (m.bcc.length) body.bcc = m.bcc.map(formatAddress);
      if (m.replyTo.length) body.reply_to = m.replyTo.map(formatAddress);
      if (m.html !== undefined) body.html = m.html;
      if (m.attachments.length) {
        body.attachments = m.attachments.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType, ...(a.cid ? { content_id: a.cid } : {}) }));
      }
      let response;
      try {
        response = await doFetch(`${apiUrl}/emails`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": m.messageId.replace(/[<>]/g, "") },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        throw new MailError(timedOut ? "Resend did not answer in time" : `Could not reach Resend (${error?.cause?.code ?? error?.message ?? "error"})`, { code: timedOut ? "timeout" : "connection_failed", retryable: true, cause: error });
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = String(payload?.message ?? payload?.error ?? response.statusText ?? "").slice(0, 300);
        const retryable = response.status === 429 || response.status >= 500;
        const code = response.status === 401 || response.status === 403 ? "auth_failed" : response.status === 429 ? "rate_limited" : retryable ? "temporary_failure" : "rejected";
        throw new MailError(`Resend answered ${response.status}${detail ? `: ${detail}` : ""}`, { code, retryable, responseCode: response.status, response: detail });
      }
      return { id: payload?.id ?? m.messageId, messageId: m.messageId, accepted: m.envelope.to, rejected: [], response: "ok" };
    },
  };
}

/** Keeps every mail in memory instead of sending it. For tests and local development. */
export function memoryTransport() {
  const sent = [];
  return {
    name: "memory",
    sent,
    async send(input) {
      const m = asMessage(input);
      const record = {
        ...m,
        raw: m.raw,
        /** Every http(s) link in the mail (html first, then text), e.g. the verification link. */
        links: [...new Set([...extractLinks(m.html ?? ""), ...extractLinks(m.text)])],
      };
      sent.push(record);
      return { id: `memory-${sent.length}`, messageId: m.messageId, accepted: m.envelope.to, rejected: [], response: "stored" };
    },
    last: () => sent[sent.length - 1],
    clear: () => (sent.length = 0),
    /** Newest mail sent to this address, or undefined. */
    to: (address) => [...sent].reverse().find((m) => m.envelope.to.some((a) => a.toLowerCase() === address.toLowerCase())),
  };
}

/**
 * Tries the first transport and falls back to the next only when the first never got to accept the mail
 * (could not connect, timed out before sending, server said "try later"). Never after a permanent rejection,
 * and never when delivery is unknown, so no mail goes out twice.
 */
export function failoverTransport(transports) {
  if (!Array.isArray(transports) || transports.length < 2) throw new MailError("failoverTransport needs at least two transports", { code: "invalid_config" });
  return {
    name: `failover(${transports.map((t) => t.name).join(",")})`,
    async send(input) {
      const m = asMessage(input);
      let last;
      for (const transport of transports) {
        try {
          const result = await transport.send(m);
          return { ...result, transport: transport.name };
        } catch (error) {
          last = error;
          if (!(error instanceof MailError) || !(error.retryable || error.code === "auth_failed" || error.code === "tls_failed" || error.code === "tls_unavailable")) throw error;
        }
      }
      throw last;
    },
    async verify() {
      const results = await Promise.allSettled(transports.map((t) => t.verify?.()));
      if (results.every((r) => r.status === "rejected")) throw results[0].reason;
      return true;
    },
  };
}
