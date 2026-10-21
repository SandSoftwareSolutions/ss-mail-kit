import { domainToASCII } from "node:url";

import { MailError } from "./errors.js";

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const bad = (message, value) => new MailError(message, { code: "invalid_address", value: typeof value === "string" ? value.slice(0, 200) : value });

/** Checks one bare address and returns it with a lowercased, ASCII (punycode) domain. Throws MailError. */
export function normalizeAddress(address) {
  if (typeof address !== "string") throw bad("Email address must be a string", address);
  const value = address.trim();
  const at = value.lastIndexOf("@");
  if (at < 1 || value.length > 254) throw bad(`Not a valid email address: ${value.slice(0, 80)}`, value);
  const local = value.slice(0, at);
  const domain = domainToASCII(value.slice(at + 1)).toLowerCase();
  const labels = domain.split(".");
  if (local.length > 64 || !LOCAL.test(local)) throw bad(`Not a valid email address: ${value.slice(0, 80)}`, value);
  if (labels.length < 2 || domain.length > 253 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) {
    throw bad(`Not a valid email address: ${value.slice(0, 80)}`, value);
  }
  return `${local}@${domain}`;
}

export function isEmail(value) {
  try {
    normalizeAddress(value);
    return true;
  } catch {
    return false;
  }
}

/** Accepts `"a@b.nl"`, `"Name <a@b.nl>"` or `{ name, address }` and returns `{ name, address }`. */
export function parseAddress(input) {
  let name = "";
  let address;
  if (input && typeof input === "object") {
    name = input.name ?? "";
    address = input.address;
  } else if (typeof input === "string") {
    const angle = /^([\s\S]*?)<([^<>]*)>\s*$/.exec(input.trim());
    if (angle) {
      name = angle[1].trim().replace(/^"([\s\S]*)"$/, (_, inner) => inner.replace(/\\(.)/g, "$1"));
      address = angle[2];
    } else address = input;
  } else throw bad("Email address must be a string or { name, address }", input);
  if (typeof name !== "string" || CONTROL.test(name)) throw bad("Display name may not contain control characters or line breaks", name);
  return { name: name.trim(), address: normalizeAddress(address) };
}

/** Splits `"A <a@x.nl>, b@y.nl"` on commas outside quotes and angle brackets. */
function splitList(text) {
  const parts = [];
  let current = "";
  let quoted = false;
  let angle = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quoted) {
      current += ch + (text[++i] ?? "");
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle = true;
    else if (!quoted && ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A string, an object, or an array of those; always returns an array of `{ name, address }` without duplicates. */
export function parseAddressList(input) {
  if (input === undefined || input === null || input === "") return [];
  const items = Array.isArray(input) ? input.flatMap((i) => (typeof i === "string" ? splitList(i) : [i])) : typeof input === "string" ? splitList(input) : [input];
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const parsed = parseAddress(item);
    const key = parsed.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/** Encodes non-ASCII text for a header (RFC 2047), in pieces that stay under 75 characters. ASCII is returned as is. */
export function encodeWords(text) {
  if (PRINTABLE_ASCII.test(text)) return text;
  const words = [];
  let current = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > 45) {
      words.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  if (current) words.push(current);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

export function formatAddress({ name, address }) {
  if (!name) return address;
  if (PRINTABLE_ASCII.test(name)) return `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  return `${encodeWords(name)} <${address}>`;
}

export function formatAddressList(list) {
  return list.map(formatAddress).join(",\r\n ");
}
