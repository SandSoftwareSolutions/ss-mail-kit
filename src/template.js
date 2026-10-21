import { MailError } from "./errors.js";
import { escapeHtml, wrapText } from "./text.js";

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT = /^[\w\s,'"-]{1,200}$/;
const HTTPS_OR_HTTP = /^https?:\/\/[^\s<>"']+$/i;
const LINKABLE = /^(?:https?:\/\/|mailto:|tel:)[^\s<>"']+$/i;

const fail = (message) => new MailError(message, { code: "invalid_template" });
const color = (value, fallback, name) => {
  if (value === undefined) return fallback;
  if (!COLOR.test(value)) throw fail(`${name} must be a hex color like #2563eb`);
  return value;
};

// Inline markup used in every text block: **bold**, `code`, [label](https://url). Everything else is plain text.
// A backslash makes the next markup character literal; escapeMarkup() does that for text you did not write yourself.
const INLINE = /\\([\\*`[\]()])|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

/** Makes a name, address or any other outside text safe to put inside a block: it can no longer become a link or bold text. */
export const escapeMarkup = (value) => String(value).replace(/([\\*`[\]()])/g, "\\$1");

function inlineHtml(text, theme) {
  let out = "";
  let last = 0;
  for (const m of String(text).matchAll(INLINE)) {
    out += escapeHtml(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out += escapeHtml(m[1]);
    else if (m[2] !== undefined) {
      out += LINKABLE.test(m[3]) ? `<a href="${escapeHtml(m[3])}" style="color:${theme.accent};text-decoration:underline;">${escapeHtml(m[2])}</a>` : escapeHtml(m[2]);
    } else if (m[4] !== undefined) out += `<strong>${escapeHtml(m[4])}</strong>`;
    else out += `<code class="ss-soft" style="font-family:Menlo,Consolas,monospace;font-size:0.95em;background:${theme.soft};padding:1px 5px;border-radius:4px;">${escapeHtml(m[5])}</code>`;
  }
  return (out + escapeHtml(text.slice(last))).replace(/\n/g, "<br>");
}

function inlineText(text) {
  return String(text).replace(INLINE, (_, escaped, label, url, bold, code) => {
    if (escaped !== undefined) return escaped;
    if (label !== undefined) return LINKABLE.test(url) && label !== url ? `${label} (${url})` : label;
    return bold ?? code;
  });
}

/** Building blocks for `email({ blocks })`. A plain string in the list means `paragraph(string)`. */
export const block = {
  heading: (text, level = 1) => ({ type: "heading", text: String(text), level: level === 2 ? 2 : 1 }),
  paragraph: (text) => ({ type: "paragraph", text: String(text) }),
  /** A call-to-action button. The text version prints the label and the full URL on separate lines. */
  button: (label, url) => {
    if (!HTTPS_OR_HTTP.test(url ?? "")) throw fail(`Button URL must be an http(s) URL: ${String(url).slice(0, 80)}`);
    return { type: "button", label: String(label), url };
  },
  /** A big monospaced value, like a verification code. */
  code: (value, caption) => ({ type: "code", value: String(value), caption }),
  list: (items, { ordered = false } = {}) => ({ type: "list", items: items.map(String), ordered }),
  /** Label/value rows, for an invoice or an order summary: `table([["Plan", "Klein"], ["Total", "€ 9,00"]])`. */
  table: (rows, { total = false } = {}) => ({ type: "table", rows: rows.map(([a, b]) => [String(a), String(b)]), total }),
  /** A highlighted note (warnings, "you did not request this"). */
  note: (text) => ({ type: "note", text: String(text) }),
  divider: () => ({ type: "divider" }),
  /** An image. Use `cid:name` as src for an inline attachment. Alt text is required. */
  image: (src, alt, { width } = {}) => {
    if (!/^(https:\/\/[^\s<>"']+|cid:[\w.@+-]+)$/.test(src ?? "")) throw fail("Image src must be an https URL or cid:name");
    if (!alt) throw fail("Images need alt text, many mail clients block images");
    return { type: "image", src, alt: String(alt), width };
  },
};

function renderBlockHtml(b, theme) {
  const text = `color:${theme.text};font-family:${theme.font};`;
  switch (b.type) {
    case "heading":
      return `<h${b.level} style="margin:0 0 16px;${text}font-size:${b.level === 1 ? 24 : 18}px;line-height:1.3;font-weight:700;">${inlineHtml(b.text, theme)}</h${b.level}>`;
    case "paragraph":
      return `<p style="margin:0 0 16px;${text}font-size:16px;line-height:1.55;">${inlineHtml(b.text, theme)}</p>`;
    case "button":
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td align="center" bgcolor="${theme.accent}" style="border-radius:8px;"><a class="ss-btn" href="${escapeHtml(b.url)}" style="display:inline-block;padding:13px 26px;font-family:${theme.font};font-size:16px;font-weight:700;line-height:1.2;color:${theme.accentText};text-decoration:none;border-radius:8px;">${escapeHtml(b.label)}</a></td></tr></table>`;
    case "code":
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td class="ss-soft" style="background:${theme.soft};border-radius:8px;padding:14px 22px;font-family:Menlo,Consolas,monospace;font-size:28px;letter-spacing:6px;font-weight:700;color:${theme.text};">${escapeHtml(b.value)}</td></tr></table>${b.caption ? `<p style="margin:-12px 0 16px;${text}font-size:14px;color:${theme.muted};">${inlineHtml(b.caption, theme)}</p>` : ""}`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      return `<${tag} style="margin:0 0 16px;padding-left:22px;${text}font-size:16px;line-height:1.55;">${b.items.map((i) => `<li style="margin:0 0 6px;">${inlineHtml(i, theme)}</li>`).join("")}</${tag}>`;
    }
    case "table":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">${b.rows
        .map(([k, v], i) => {
          const last = b.total && i === b.rows.length - 1;
          const cell = `padding:9px 0;border-bottom:1px solid ${theme.line};${text}font-size:15px;${last ? "font-weight:700;" : ""}`;
          return `<tr><td style="${cell}">${inlineHtml(k, theme)}</td><td align="right" style="${cell}">${inlineHtml(v, theme)}</td></tr>`;
        })
        .join("")}</table>`;
    case "note":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td class="ss-soft" style="background:${theme.soft};border-left:4px solid ${theme.accent};border-radius:4px;padding:12px 16px;${text}font-size:14px;line-height:1.5;">${inlineHtml(b.text, theme)}</td></tr></table>`;
    case "divider":
      return `<hr style="border:0;border-top:1px solid ${theme.line};margin:24px 0;">`;
    case "image":
      return `<img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt)}"${b.width ? ` width="${Number(b.width) | 0}"` : ""} style="display:block;max-width:100%;height:auto;border:0;margin:0 0 16px;">`;
    default:
      throw fail(`Unknown block type: ${b.type}`);
  }
}

function renderBlockText(b) {
  switch (b.type) {
    case "heading":
      return b.level === 1 ? `${inlineText(b.text).toUpperCase()}` : inlineText(b.text);
    case "paragraph":
    case "note":
      return wrapText(inlineText(b.text));
    case "button":
      return `${b.label}:\n${b.url}`;
    case "code":
      return `${b.value}${b.caption ? `\n${inlineText(b.caption)}` : ""}`;
    case "list":
      return b.items.map((i, n) => wrapText(`${b.ordered ? `${n + 1}.` : "-"} ${inlineText(i)}`)).join("\n");
    case "table": {
      const width = Math.max(...b.rows.map(([k]) => inlineText(k).length));
      return b.rows.map(([k, v]) => `${inlineText(k).padEnd(width)}  ${inlineText(v)}`).join("\n");
    }
    case "divider":
      return "----";
    case "image":
      return `[${b.alt}]`;
    default:
      throw fail(`Unknown block type: ${b.type}`);
  }
}

/**
 * Makes a finished mail: `{ subject, html, text }`. The HTML is table-based with inline styles (works in Outlook, Gmail
 * and Apple Mail, with a dark-mode variant), the text version is written from the same blocks, and all text is escaped.
 */
export function email(options = {}) {
  const { subject, preheader = "", blocks = [], footer = [], lang = "en", brand = {} } = options;
  if (typeof subject !== "string" || !subject.trim()) throw fail("email needs a subject");
  if (!Array.isArray(blocks) || !blocks.length) throw fail("email needs at least one block");
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw fail("lang must be a language tag like nl or en-GB");
  const font = brand.font ?? "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  if (!FONT.test(font)) throw fail("brand.font may only contain letters, digits, spaces, commas, quotes and dashes");
  const accent = color(brand.color, "#2563eb", "brand.color");
  const theme = {
    font,
    accent,
    accentText: color(brand.buttonTextColor, "#ffffff", "brand.buttonTextColor"),
    text: color(brand.textColor, "#1f2933", "brand.textColor"),
    muted: "#6b7785",
    soft: "#f1f4f8",
    line: "#e1e6ec",
    page: color(brand.background, "#f4f6f9", "brand.background"),
    card: "#ffffff",
  };
  if (brand.logoUrl !== undefined && !/^https:\/\/[^\s<>"']+$/.test(brand.logoUrl) && !/^cid:[\w.@+-]+$/.test(brand.logoUrl)) throw fail("brand.logoUrl must be an https URL or cid:name");
  const items = blocks.map((b) => (typeof b === "string" ? block.paragraph(b) : b));
  const footerLines = (Array.isArray(footer) ? footer : [footer]).map(String);

  const header = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name ?? "")}" height="32" style="display:block;border:0;height:32px;width:auto;">`
    : brand.name
      ? `<span style="font-family:${font};font-size:20px;font-weight:700;color:${theme.text};">${escapeHtml(brand.name)}</span>`
      : "";
  const headerHtml = header && brand.url && HTTPS_OR_HTTP.test(brand.url) ? `<a href="${escapeHtml(brand.url)}" style="text-decoration:none;">${header}</a>` : header;

  const hiddenPreheader = preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`
    : "";

  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(subject)}</title>
<style>
@media (max-width:620px){.ss-card{width:100%!important;border-radius:0!important}.ss-pad{padding:24px 20px!important}}
@media (prefers-color-scheme:dark){.ss-page{background:#12161b!important}.ss-card{background:#1b2128!important}.ss-card h1,.ss-card h2,.ss-card p,.ss-card li,.ss-card td,.ss-card span{color:#e8edf2!important}.ss-card a:not(.ss-btn){color:#8db4ff!important}.ss-card .ss-soft{background:#2a333d!important}}
</style>
</head>
<body class="ss-page" style="margin:0;padding:0;background:${theme.page};">
${hiddenPreheader}
<table role="presentation" class="ss-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${theme.page};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="ss-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${theme.card};border-radius:12px;">
<tr><td class="ss-pad" style="padding:32px 36px 8px;">${headerHtml}</td></tr>
<tr><td class="ss-pad" style="padding:16px 36px 28px;">
${items.map((b) => renderBlockHtml(b, theme)).join("\n")}
</td></tr>
${footerLines.length ? `<tr><td class="ss-pad" style="padding:0 36px 28px;border-top:1px solid ${theme.line};"><p style="margin:18px 0 0;font-family:${font};font-size:12px;line-height:1.6;color:${theme.muted};">${footerLines.map((l) => inlineHtml(l, theme)).join("<br>")}</p></td></tr>` : ""}
</table>
</td></tr></table>
</body>
</html>`;

  const parts = items.map(renderBlockText);
  if (brand.name) parts.unshift(brand.name);
  if (footerLines.length) parts.push(`--\n${footerLines.map(inlineText).join("\n")}`);
  return { subject: subject.trim(), html, text: parts.join("\n\n") + "\n" };
}
