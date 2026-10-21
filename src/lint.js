import { prepareMessage } from "./message.js";
import { extractLinks } from "./text.js";

/**
 * Looks at a mail the way a spam filter and an inbox would, and returns a list of `{ level, message }` hints.
 * It is advice, not a guarantee of delivery.
 */
export function lintEmail(input) {
  const m = input.raw ? input : prepareMessage({ from: "lint@example.com", to: "lint@example.com", ...input });
  const out = [];
  const warn = (message) => out.push({ level: "warning", message });
  const info = (message) => out.push({ level: "info", message });
  if (m.subject.length > 78) warn(`Subject is ${m.subject.length} characters; inboxes cut it off around 60-78.`);
  if (m.subject.length > 3 && m.subject === m.subject.toUpperCase() && /[A-Z]/.test(m.subject)) warn("Subject is ALL CAPS, which spam filters dislike.");
  if (/!{2,}/.test(m.subject)) warn("Subject has repeated exclamation marks.");
  if (m.html !== undefined) {
    const size = Buffer.byteLength(m.html);
    if (size > 100_000) warn(`HTML is ${Math.round(size / 1000)} KB; Gmail cuts messages off at about 102 KB.`);
    if (/<img\b/i.test(m.html) && !/<img\b[^>]*\balt=/i.test(m.html)) warn("An image has no alt text.");
    if (/<script\b|\son\w+\s*=|javascript:/i.test(m.html)) warn("HTML contains script or event handlers; mail clients strip them.");
    if (/<link\b[^>]*stylesheet|@import/i.test(m.html)) warn("External stylesheets are ignored by most mail clients; use inline styles.");
    const textLength = m.text.replace(/\s+/g, "").length;
    if (textLength < 40 && /<img\b/i.test(m.html)) warn("Almost only images; add real text, it helps delivery and accessibility.");
  }
  const links = [...new Set([...extractLinks(m.html ?? ""), ...extractLinks(m.text)])];
  if (links.some((l) => l.startsWith("http://"))) warn("Contains an http:// link; use https://.");
  if (links.length > 10) info(`Contains ${links.length} links; fewer is safer for delivery.`);
  const hasUnsub = Object.keys(m.headers).some((h) => h.toLowerCase() === "list-unsubscribe");
  if (!hasUnsub && !/^auto-generated$/i.test(m.headers["Auto-Submitted"] ?? "")) info("No List-Unsubscribe header; add one if this is not a transactional mail.");
  return out;
}
