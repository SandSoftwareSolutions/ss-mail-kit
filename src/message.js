import { randomBytes } from "node:crypto";

import { encodeWords, formatAddress, formatAddressList, parseAddress, parseAddressList } from "./address.js";
import { MailError } from "./errors.js";
import { htmlToText } from "./text.js";

const RESERVED = new Set(["from", "to", "cc", "bcc", "subject", "date", "message-id", "mime-version", "content-type", "content-transfer-encoding", "reply-to", "sender", "return-path"]);
const MAX_RECIPIENTS = 50;

const fail = (message, code = "invalid_message") => new MailError(message, { code });

/** Quoted-printable (RFC 2045) of a text: lines of at most 76 characters, CRLF line breaks. */
export function quotedPrintable(text) {
  const bytes = Buffer.from(String(text).replace(/\r\n?|\n/g, "\n"), "utf8");
  const lines = [];
  let line = "";
  let tokens = [];
  const flush = () => {
    if (tokens.length) {
      const last = tokens[tokens.length - 1];
      if (last === " " || last === "\t") tokens[tokens.length - 1] = "=" + last.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    }
    let width = 0;
    line = "";
    for (const t of tokens) {
      if (width + t.length > 75) {
        lines.push(line + "=");
        line = "";
        width = 0;
      }
      line += t;
      width += t.length;
    }
    lines.push(line);
    tokens = [];
  };
  for (const b of bytes) {
    if (b === 10) flush();
    else if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) tokens.push(String.fromCharCode(b));
    else tokens.push("=" + b.toString(16).toUpperCase().padStart(2, "0"));
  }
  flush();
  return lines.join("\r\n");
}

const base64Lines = (buffer) => (buffer.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
const boundary = () => `=_ss_${randomBytes(12).toString("hex")}`;
const needsEncoding = (name) => !/^[\x20-\x7e]*$/.test(name);
const quote = (value) => `"${value.replace(/(["\\])/g, "\\$1")}"`;

const extended = (name) => `UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
// ASCII names are plain quoted parameters; others use RFC 2231 (`name*=UTF-8''...`), which Gmail, Outlook, Apple Mail and Thunderbird read.
const param = (key, name) => (needsEncoding(name) ? `${key}*=${extended(name)}` : `${key}=${quote(name)}`);

function textPart(contentType, body) {
  return `Content-Type: ${contentType}; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(body)}\r\n`;
}

function multipart(type, parts) {
  const b = boundary();
  return { header: `Content-Type: multipart/${type}; boundary="${b}"`, body: `${parts.map((p) => `--${b}\r\n${p}`).join("")}--${b}--\r\n` };
}

// A child part is a string that starts with its own headers (it is already a full MIME entity).
const entity = (m) => `${m.header}\r\n\r\n${m.body}`;

function attachmentPart(a) {
  const disposition = a.cid ? "inline" : "attachment";
  return (
    `Content-Type: ${a.contentType}; ${param("name", a.filename)}\r\n` +
    `Content-Transfer-Encoding: base64\r\n` +
    `Content-Disposition: ${disposition}; ${param("filename", a.filename)}\r\n` +
    (a.cid ? `Content-ID: <${a.cid}>\r\n` : "") +
    `\r\n${base64Lines(a.content)}\r\n`
  );
}

function checkHeaderValue(name, value) {
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw fail(`Header ${name} must be a single line of text`, "invalid_header");
}

function normalizeAttachment(a, index) {
  if (!a || typeof a !== "object") throw fail(`attachments[${index}] must be an object`);
  const content = typeof a.content === "string" ? Buffer.from(a.content, a.encoding === "base64" ? "base64" : "utf8") : a.content;
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) throw fail(`attachments[${index}].content must be a Buffer or string`);
  const filename = String(a.filename ?? "").replace(/[\r\n\0/\\]/g, "_").trim();
  if (!filename) throw fail(`attachments[${index}].filename is required`);
  const contentType = String(a.contentType ?? "application/octet-stream");
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) throw fail(`attachments[${index}].contentType is not valid`);
  const cid = a.cid === undefined ? undefined : String(a.cid);
  if (cid !== undefined && !/^[\w.@+-]{1,200}$/.test(cid)) throw fail(`attachments[${index}].cid is not valid`);
  return { filename, content: Buffer.from(content), contentType, cid };
}

/**
 * Checks and normalizes a message. The result has everything a transport needs, and `raw` (a Buffer with the
 * complete RFC 5322 message) is built on first use.
 */
export function prepareMessage(input, defaults = {}) {
  if (!input || typeof input !== "object") throw fail("A message must be an object");
  const merged = { ...defaults, ...input, headers: { ...defaults.headers, ...input.headers } };
  const from = parseAddress(merged.from ?? (() => { throw fail("from is required", "missing_from"); })());
  const to = parseAddressList(merged.to);
  const cc = parseAddressList(merged.cc);
  const bcc = parseAddressList(merged.bcc);
  const replyTo = parseAddressList(merged.replyTo);
  const unique = new Map();
  for (const a of [...to, ...cc, ...bcc]) if (!unique.has(a.address.toLowerCase())) unique.set(a.address.toLowerCase(), a.address);
  const total = new Set(unique.values());
  if (!total.size) throw fail("At least one recipient (to, cc or bcc) is required", "no_recipients");
  if (total.size > (merged.maxRecipients ?? MAX_RECIPIENTS)) throw fail(`Too many recipients (${total.size}); send in smaller batches or raise maxRecipients`, "too_many_recipients");

  const subject = String(merged.subject ?? "").replace(/[\t ]+/g, " ").trim();
  if (!subject) throw fail("subject is required", "missing_subject");
  if (/[\r\n\0]/.test(subject)) throw fail("subject may not contain line breaks", "invalid_header");

  let html = merged.html === undefined ? undefined : String(merged.html);
  let text = merged.text === undefined ? undefined : String(merged.text);
  if (html === undefined && text === undefined) throw fail("Give the message a text or html body", "empty_body");
  if (text === undefined) text = htmlToText(html);

  const attachments = (merged.attachments ?? []).map(normalizeAttachment);
  const headers = {};
  for (const [name, value] of Object.entries(merged.headers)) {
    if (value === undefined || value === null) continue;
    if (!/^[A-Za-z0-9-]{1,60}$/.test(name)) throw fail(`Header name not allowed: ${name.slice(0, 40)}`, "invalid_header");
    if (RESERVED.has(name.toLowerCase())) throw fail(`Set ${name} with its own option, not in headers`, "invalid_header");
    checkHeaderValue(name, String(value));
    headers[name] = String(value);
  }
  if (merged.autoSubmitted !== false && !Object.keys(headers).some((n) => n.toLowerCase() === "auto-submitted")) headers["Auto-Submitted"] = "auto-generated";
  if (merged.unsubscribe) {
    const { url, mailto } = merged.unsubscribe;
    const items = [];
    if (url) {
      if (!/^https:\/\/[^\s<>]+$/.test(url)) throw fail("unsubscribe.url must be an https URL", "invalid_header");
      items.push(`<${url}>`);
      headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    if (mailto) items.push(`<mailto:${parseAddress(mailto).address}>`);
    if (!items.length) throw fail("unsubscribe needs a url or mailto", "invalid_header");
    headers["List-Unsubscribe"] = items.join(", ");
  }

  const messageId = merged.messageId ?? `<${randomBytes(16).toString("hex")}@${from.address.split("@")[1]}>`;
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId)) throw fail("messageId must look like <id@domain>", "invalid_header");
  const date = merged.date instanceof Date ? merged.date : new Date();
  const envelopeFrom = merged.envelopeFrom ? parseAddress(merged.envelopeFrom).address : from.address;
  const envelopeTo = [...total];

  const message = {
    from, to, cc, bcc, replyTo, subject, html, text, headers, attachments, messageId, date,
    envelope: { from: envelopeFrom, to: envelopeTo },
  };
  let raw;
  Object.defineProperty(message, "raw", { enumerable: false, get: () => (raw ??= buildRaw(message)) });
  return message;
}

function buildRaw(m) {
  const head = [];
  head.push(`From: ${formatAddress(m.from)}`);
  if (m.to.length) head.push(`To: ${formatAddressList(m.to)}`);
  if (m.cc.length) head.push(`Cc: ${formatAddressList(m.cc)}`);
  if (m.replyTo.length) head.push(`Reply-To: ${formatAddressList(m.replyTo)}`);
  head.push(`Subject: ${encodeWords(m.subject)}`);
  head.push(`Date: ${m.date.toUTCString().replace("GMT", "+0000")}`);
  head.push(`Message-ID: ${m.messageId}`);
  head.push("MIME-Version: 1.0");
  for (const [name, value] of Object.entries(m.headers)) head.push(`${name}: ${encodeWords(value)}`);

  const inline = m.attachments.filter((a) => a.cid);
  const regular = m.attachments.filter((a) => !a.cid);
  let body;
  if (m.html === undefined) body = { header: null, text: m.text };
  else {
    const htmlEntity = inline.length
      ? multipart("related", [textPart("text/html", m.html), ...inline.map(attachmentPart)])
      : null;
    const htmlPart = htmlEntity ? entity(htmlEntity) + "\r\n" : textPart("text/html", m.html);
    body = multipart("alternative", [textPart("text/plain", m.text), htmlPart]);
  }
  let top;
  if (regular.length) {
    const first = body.header ? entity(body) + "\r\n" : textPart("text/plain", m.text);
    top = multipart("mixed", [first, ...regular.map(attachmentPart)]);
  } else if (body.header) top = body;
  else top = { header: "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable", body: `${quotedPrintable(m.text)}\r\n` };
  return Buffer.from(`${head.join("\r\n")}\r\n${top.header}\r\n\r\n${top.body}`, "latin1");
}
