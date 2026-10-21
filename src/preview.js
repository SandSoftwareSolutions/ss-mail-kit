import { escapeHtml } from "./text.js";

/**
 * One HTML page that shows a mail the way you want to review it: subject, the rendered mail (narrow and wide) and
 * the plain-text version. Write it to a file and open it in a browser: `writeFileSync("mail.html", preview(mail))`.
 */
export function preview(mail) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview: ${escapeHtml(mail.subject)}</title>
<style>body{font:15px system-ui,sans-serif;margin:0;padding:24px;background:#e7eaee;color:#1f2933}h1{font-size:18px;margin:0 0 4px}.meta{color:#6b7785;margin:0 0 20px}.row{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}iframe{border:0;background:#fff;box-shadow:0 1px 4px #0003;height:760px}pre{background:#fff;padding:16px;white-space:pre-wrap;max-width:560px;box-shadow:0 1px 4px #0003}</style></head><body>
<h1>${escapeHtml(mail.subject)}</h1><p class="meta">HTML (wide and phone width) and the text version</p>
<div class="row"><iframe style="width:680px" srcdoc="${escapeHtml(mail.html ?? "")}"></iframe><iframe style="width:380px" srcdoc="${escapeHtml(mail.html ?? "")}"></iframe><pre>${escapeHtml(mail.text)}</pre></div></body></html>`;
}
