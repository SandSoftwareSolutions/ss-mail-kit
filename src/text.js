const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", euro: "€", copy: "©", laquo: "«", raquo: "»" };

export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const decodeEntities = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

/** Plain-text version of an HTML mail: links become `label (url)`, lists get dashes, blocks get blank lines. */
export function htmlToText(html) {
  let text = String(html)
    .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_, a, b, label) => {
      const url = decodeEntities(a ?? b ?? "");
      const inner = label.replace(/<[^>]*>/g, "").trim();
      if (!inner || inner === url || /^(mailto|tel):/i.test(url) && decodeEntities(inner) === url.replace(/^\w+:/, "")) return inner || url;
      return /^(https?|mailto|tel):/i.test(url) ? `${inner} (${url})` : inner;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n----\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote)>/gi, "\n\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text)
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/** Wraps text at `width` characters on spaces. Words longer than the width (like URLs) stay whole. */
export function wrapText(text, width = 76) {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width) return line;
      const indent = /^(\s*(?:- )?)/.exec(line)[1];
      const hang = " ".repeat(indent.length);
      const out = [];
      let current = "";
      for (const word of line.slice(indent.length).split(" ")) {
        const candidate = current ? `${current} ${word}` : word;
        if (current && (out.length ? hang : indent).length + candidate.length > width) {
          out.push((out.length ? hang : indent) + current);
          current = word;
        } else current = candidate;
      }
      out.push((out.length ? hang : indent) + current);
      return out.join("\n");
    })
    .join("\n");
}

/** Every http(s) link in an HTML string (from href attributes) or in a plain text, in order, without duplicates. */
export function extractLinks(content) {
  const found = [];
  const add = (url) => {
    const clean = decodeEntities(url).replace(/[).,;:!?]+$/, "");
    if (/^https?:\/\//i.test(clean) && !found.includes(clean)) found.push(clean);
  };
  const source = String(content);
  if (/<[a-z!][^>]*>/i.test(source)) for (const m of source.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) add(m[1] ?? m[2]);
  else for (const m of source.matchAll(/https?:\/\/[^\s<>"')]+/gi)) add(m[0]);
  return found;
}
