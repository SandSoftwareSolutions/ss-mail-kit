import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TLSSocket, createServer as createTlsServer } from "node:tls";

import {
  MailError, block, createMailer, email, encodeWords, extractLinks, failoverTransport, htmlToText, isEmail, lintEmail, memoryTransport,
  parseAddress, parseAddressList, prepareMessage, preview, quotedPrintable, resendTransport, smtpTransport,
} from "./src/index.js";

const decodeQp = (text) => Buffer.from(text.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
const rawText = (m) => m.raw.toString("latin1");
const base = { from: "Prijzenwacht <noreply@prijzenwacht.nl>", to: "klant@example.nl", subject: "Hallo" };
const rejects = async (fn, code) => assert.rejects(fn, (e) => e instanceof MailError && (!code || e.code === code));
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof MailError && e.code === code);

// ---------- addresses ----------

test("accepts normal addresses and lowercases / punycodes the domain", () => {
  assert.equal(parseAddress("Jan@Example.NL").address, "Jan@example.nl");
  assert.equal(parseAddress("j@münchen.de").address, "j@xn--mnchen-3ya.de");
  assert.deepEqual(parseAddress('"Smit, Jan" <jan@x.nl>'), { name: "Smit, Jan", address: "jan@x.nl" });
  assert.deepEqual(parseAddress({ name: "A", address: "a@x.nl" }), { name: "A", address: "a@x.nl" });
  assert.equal(isEmail("a+tag@sub.example.co.uk"), true);
});

test("refuses things that are not addresses or that smuggle headers", () => {
  for (const bad of ["", "a", "a@b", "a@@b.nl", "a b@c.nl", "a@b.nl\r\nBcc: x@y.nl", "<a@b.nl", "a@b.123", ".a@b.nl", "a..b@c.nl", "a@-b.nl", "é@b.nl", "a@" + "x".repeat(70) + ".nl"]) {
    assert.equal(isEmail(bad), false, bad);
  }
  throwsCode(() => parseAddress({ name: "Evil\r\nBcc: x@y.nl", address: "a@b.nl" }), "invalid_address");
});

test("splits address lists on commas outside quotes and removes duplicates", () => {
  const list = parseAddressList('"Smit, Jan" <jan@x.nl>, b@y.nl, JAN@x.nl');
  assert.deepEqual(list.map((a) => a.address), ["jan@x.nl", "b@y.nl"]);
  assert.deepEqual(parseAddressList(["a@x.nl, b@x.nl", { address: "c@x.nl" }]).map((a) => a.address), ["a@x.nl", "b@x.nl", "c@x.nl"]);
  assert.deepEqual(parseAddressList(undefined), []);
});

test("encodes non-ASCII header text in short pieces", () => {
  const encoded = encodeWords("Héllo wereld ✓ ".repeat(8));
  for (const line of encoded.split("\r\n")) assert.ok(line.trim().length <= 75, line);
  assert.equal(encodeWords("plain text"), "plain text");
});

// ---------- body encoding ----------

test("quoted-printable round-trips, keeps lines short and protects '=' and trailing spaces", () => {
  const samples = ["simple", "a = b", "trailing space \nnext", "émoji 🎉 en ñ", "x".repeat(500), "tab\t\nend\t", "line1\r\nline2\rline3\nline4", ""];
  for (const sample of samples) {
    const qp = quotedPrintable(sample);
    for (const line of qp.split("\r\n")) assert.ok(line.length <= 76, `${line.length}`);
    assert.equal(decodeQp(qp), sample.replace(/\r\n?|\n/g, "\n").replace(/\n/g, "\r\n").replace(/\r\n/g, "\r\n").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
    assert.ok(!/[ \t]\r\n|[ \t]$/.test(qp), "trailing whitespace must be encoded");
  }
});

test("htmlToText keeps links, lists and breaks, drops styles and decodes entities", () => {
  const text = htmlToText(`<style>p{color:red}</style><h1>Titel &amp; meer</h1><p>Hoi <a href="https://x.nl/a?b=1&amp;c=2">klik hier</a>.<br>Tot ziens</p><ul><li>een</li><li>twee</li></ul><p><a href="https://y.nl">https://y.nl</a></p>`);
  assert.equal(text, "Titel & meer\n\nHoi klik hier (https://x.nl/a?b=1&c=2).\nTot ziens\n\n- een\n- twee\n\nhttps://y.nl");
});

// ---------- message ----------

test("builds a multipart/alternative mail with text first, ASCII only, CRLF everywhere", () => {
  const m = prepareMessage({ ...base, subject: "Héllo ✓", html: "<p>Hoi €</p>", to: "Jörg <j@x.nl>" });
  const raw = rawText(m);
  assert.match(raw, /^From: "Prijzenwacht" <noreply@prijzenwacht\.nl>\r\n/);
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /Content-Type: multipart\/alternative/);
  assert.ok(raw.indexOf("text/plain") < raw.indexOf("text/html"));
  assert.ok(/^[\x00-\x7f]*$/.test(raw), "all 7-bit");
  assert.ok(!/(^|[^\r])\n/.test(raw), "only CRLF line breaks");
  assert.match(raw, /^Message-ID: <[0-9a-f]{32}@prijzenwacht\.nl>$/m);
  assert.match(raw, /^Auto-Submitted: auto-generated$/m);
  assert.match(decodeQp(raw.split("text/html")[1].split("\r\n\r\n")[1]), /<p>Hoi €<\/p>/);
});

test("makes the text part from the html when none is given", () => {
  const m = prepareMessage({ ...base, html: '<p>Hoi <a href="https://x.nl">link</a></p>' });
  assert.equal(m.text, "Hoi link (https://x.nl)");
});

test("text-only mail is a single text/plain part", () => {
  const raw = rawText(prepareMessage({ ...base, text: "Hallo é" }));
  assert.match(raw, /Content-Type: text\/plain; charset=utf-8/);
  assert.ok(!raw.includes("multipart"));
});

test("Bcc recipients are in the envelope but never in the headers", () => {
  const m = prepareMessage({ ...base, text: "x", cc: "cc@x.nl", bcc: "geheim@x.nl" });
  assert.deepEqual(m.envelope.to, ["klant@example.nl", "cc@x.nl", "geheim@x.nl"]);
  assert.ok(!rawText(m).includes("geheim@x.nl"));
  assert.match(rawText(m), /^Cc: cc@x\.nl$/m);
});

test("refuses header injection in subject, custom headers, message id and names", () => {
  throwsCode(() => prepareMessage({ ...base, text: "x", subject: "Hi\r\nBcc: evil@x.nl" }), "invalid_header");
  throwsCode(() => prepareMessage({ ...base, text: "x", headers: { "X-A": "1\r\nBcc: evil@x.nl" } }), "invalid_header");
  throwsCode(() => prepareMessage({ ...base, text: "x", headers: { "X-A\r\nB": "1" } }), "invalid_header");
  throwsCode(() => prepareMessage({ ...base, text: "x", headers: { Bcc: "evil@x.nl" } }), "invalid_header");
  throwsCode(() => prepareMessage({ ...base, text: "x", messageId: "<a b@c>" }), "invalid_header");
  throwsCode(() => prepareMessage({ ...base, text: "x", to: "a@b.nl\r\nBcc: x@y.nl" }), "invalid_address");
});

test("requires from, a recipient, a subject and a body; limits the number of recipients", () => {
  throwsCode(() => prepareMessage({ to: "a@b.nl", subject: "x", text: "x" }), "missing_from");
  throwsCode(() => prepareMessage({ from: "a@b.nl", subject: "x", text: "x" }), "no_recipients");
  throwsCode(() => prepareMessage({ ...base, subject: " ", text: "x" }), "missing_subject");
  throwsCode(() => prepareMessage({ ...base }), "empty_body");
  const many = Array.from({ length: 51 }, (_, i) => `u${i}@x.nl`);
  throwsCode(() => prepareMessage({ ...base, text: "x", to: many }), "too_many_recipients");
  assert.equal(prepareMessage({ ...base, text: "x", to: many, maxRecipients: 100 }).envelope.to.length, 51);
});

test("one-click unsubscribe adds both headers and only accepts https", () => {
  const raw = rawText(prepareMessage({ ...base, text: "x", unsubscribe: { url: "https://x.nl/u/1", mailto: "stop@x.nl" } }));
  assert.match(raw, /^List-Unsubscribe: <https:\/\/x\.nl\/u\/1>, <mailto:stop@x\.nl>$/m);
  assert.match(raw, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
  throwsCode(() => prepareMessage({ ...base, text: "x", unsubscribe: { url: "http://x.nl/u" } }), "invalid_header");
});

test("attachments: regular ones in multipart/mixed, inline ones with cid in multipart/related", () => {
  const raw = rawText(prepareMessage({
    ...base,
    html: '<img src="cid:logo"><p>x</p>',
    attachments: [
      { filename: "factuur é.pdf", content: Buffer.from("PDFDATA"), contentType: "application/pdf" },
      { filename: "logo.png", content: Buffer.from("PNG"), contentType: "image/png", cid: "logo" },
    ],
  }));
  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Type: multipart\/related/);
  assert.match(raw, /Content-ID: <logo>/);
  assert.match(raw, /filename\*=UTF-8''factuur%20%C3%A9\.pdf/);
  assert.match(raw, /name\*=UTF-8''factuur%20%C3%A9\.pdf/);
  assert.match(raw, /UERGREFUQQ==/);
  const boundaries = [...raw.matchAll(/boundary="([^"]+)"/g)].map((m) => m[1]);
  for (const b of boundaries) {
    assert.equal(raw.split(`--${b}--`).length - 1, 1, "each multipart is closed once");
    assert.ok(raw.split(`--${b}\r\n`).length - 1 >= 2);
  }
  throwsCode(() => prepareMessage({ ...base, text: "x", attachments: [{ filename: "a.txt", content: 5 }] }), "invalid_message");
  assert.match(rawText(prepareMessage({ ...base, text: "x", attachments: [{ filename: "../../etc/passwd", content: "x" }] })), /filename="\.\._\.\._etc_passwd"/);
});

// ---------- template ----------

const brand = { name: "Prijzenwacht", url: "https://prijzenwacht.sandsoftwaresolutions.com", color: "#0f766e" };

test("email() gives subject, html and a hand-made text version", () => {
  const mail = email({
    subject: "Bevestig je mail", preheader: "Nog één stap", brand, lang: "nl",
    blocks: [block.heading("Welkom"), "Klik op de knop om **je mail** te bevestigen. [Hulp](https://x.nl/hulp)", block.button("Bevestig", "https://x.nl/v?t=1&b=2"), block.code("482913", "Geldig 24 uur"), block.table([["Plan", "Klein"], ["Totaal", "€ 9,00"]], { total: true }), block.list(["een", "twee"]), block.note("Niet jij? Negeer dit.")],
    footer: ["Prijzenwacht · KvK 123"],
  });
  assert.equal(mail.subject, "Bevestig je mail");
  assert.match(mail.html, /<html lang="nl">/);
  assert.match(mail.html, /<strong>je mail<\/strong>/);
  assert.match(mail.html, /href="https:\/\/x\.nl\/v\?t=1&amp;b=2"/);
  assert.match(mail.html, /Nog één stap/);
  assert.match(mail.html, /prefers-color-scheme:dark/);
  assert.match(mail.text, /^Prijzenwacht\n\nWELKOM\n\nKlik op de knop om je mail te bevestigen\. Hulp \(https:\/\/x\.nl\/hulp\)\n\nBevestig:\nhttps:\/\/x\.nl\/v\?t=1&b=2/);
  assert.match(mail.text, /482913\nGeldig 24 uur/);
  assert.match(mail.text, /Totaal {2}€ 9,00/);
  assert.match(mail.text, /- een\n- twee/);
  assert.match(mail.text, /--\nPrijzenwacht · KvK 123\n$/);
});

test("escapes everything it is given and drops unsafe links", () => {
  const evil = '<script>alert(1)</script> "quoted" & [x](javascript:alert(1)) [ok](https://ok.nl/?a=1&b=2) [bad](https://x.nl/"onmouseover="x)';
  const mail = email({ subject: "<b>Hi</b>", brand: { name: "<i>Merk</i>" }, blocks: [block.paragraph(evil), block.heading(evil), block.note(evil), block.list([evil]), block.table([[evil, evil]]), block.code(evil, evil)], footer: [evil] });
  assert.ok(!mail.html.includes("<script>"));
  assert.ok(!/href="javascript/i.test(mail.html));
  assert.ok(!mail.html.includes("<i>Merk"));
  assert.ok(!mail.html.includes("<b>Hi"));
  assert.match(mail.html, /&lt;script&gt;/);
  assert.ok(!/<[^>]*onmouseover/i.test(mail.html), "no attribute injected into a tag");
  assert.match(mail.html, /<a href="https:\/\/ok\.nl\/\?a=1&amp;b=2"/);
});

test("rejects bad template input instead of producing a broken mail", () => {
  const ok = ["x"];
  throwsCode(() => email({ subject: "", blocks: ok }), "invalid_template");
  throwsCode(() => email({ subject: "x", blocks: [] }), "invalid_template");
  throwsCode(() => email({ subject: "x", blocks: ok, brand: { color: "red; background:url(x)" } }), "invalid_template");
  throwsCode(() => email({ subject: "x", blocks: ok, brand: { font: "Arial;}</style><script>" } }), "invalid_template");
  throwsCode(() => email({ subject: "x", blocks: ok, lang: "nl\"><x" }), "invalid_template");
  throwsCode(() => email({ subject: "x", blocks: ok, brand: { logoUrl: "javascript:1" } }), "invalid_template");
  throwsCode(() => block.button("Go", "javascript:alert(1)"), "invalid_template");
  throwsCode(() => block.image("http://insecure/x.png", "alt"), "invalid_template");
  throwsCode(() => block.image("https://x.nl/x.png", ""), "invalid_template");
  throwsCode(() => email({ subject: "x", blocks: [{ type: "nope" }] }), "invalid_template");
});

test("a finished email() goes straight into a message", () => {
  const mail = email({ subject: "Test", blocks: ["Hoi"], brand });
  const m = prepareMessage({ ...base, ...mail });
  assert.equal(m.subject, "Test");
  assert.ok(m.html.startsWith("<!doctype html>"));
  assert.match(m.text, /^Prijzenwacht\n\nHoi/);
});

// ---------- memory transport and mailer ----------

test("memory transport keeps mails and finds the link inside", async () => {
  const transport = memoryTransport();
  const mailer = createMailer({ transport, from: base.from });
  const mail = email({ subject: "Bevestig", blocks: [block.button("Bevestig", "https://app.nl/verify?token=abc123")] });
  const result = await mailer.send({ to: "Klant@Example.nl", ...mail });
  assert.equal(result.attempts, 1);
  assert.equal(transport.last().links[0], "https://app.nl/verify?token=abc123");
  assert.equal(transport.to("klant@example.nl").subject, "Bevestig");
  assert.equal(transport.to("anders@example.nl"), undefined);
  transport.clear();
  assert.equal(transport.sent.length, 0);
});

test("mailer retries temporary failures, not permanent ones, and counts attempts", async () => {
  let calls = 0;
  const flaky = { name: "flaky", send: async () => { if (++calls < 3) throw new MailError("later", { retryable: true }); return { id: "1", accepted: [], rejected: [] }; } };
  const result = await createMailer({ transport: flaky, from: base.from, retryDelayMs: 1 }).send({ ...base, text: "x" });
  assert.equal(result.attempts, 3);

  calls = 0;
  const permanent = { name: "p", send: async () => { calls++; throw new MailError("nee", { code: "rejected" }); } };
  await rejects(() => createMailer({ transport: permanent, from: base.from, retryDelayMs: 1 }).send({ ...base, text: "x" }), "rejected");
  assert.equal(calls, 1);

  calls = 0;
  const always = { name: "a", send: async () => { calls++; throw new MailError("later", { retryable: true }); } };
  await assert.rejects(() => createMailer({ transport: always, from: base.from, retries: 2, retryDelayMs: 1 }).send({ ...base, text: "x" }), (e) => e.attempts === 3);
  assert.equal(calls, 3);

  const odd = { name: "o", send: async () => { throw new TypeError("boom"); } };
  await rejects(() => createMailer({ transport: odd, from: base.from }).send({ ...base, text: "x" }), "send_failed");
});

test("redirectAllTo sends staging mail to a safe address and notes the real one in the subject", async () => {
  const transport = memoryTransport();
  const mailer = createMailer({ transport, from: base.from, redirectAllTo: "dev@sand.nl" });
  await mailer.send({ ...base, to: "echte.klant@example.nl", cc: "boss@example.nl", text: "x" });
  const m = transport.last();
  assert.deepEqual(m.envelope.to, ["dev@sand.nl"]);
  assert.match(m.subject, /^\[to: e\*\*\*@example\.nl, b\*\*\*@example\.nl\] Hallo$/);
  assert.ok(!rawText(m).includes("echte.klant"));
});

test("allowDomains blocks other recipients before anything is sent", async () => {
  const transport = memoryTransport();
  const mailer = createMailer({ transport, from: base.from, allowDomains: ["sand.nl"] });
  await mailer.send({ ...base, to: "a@sand.nl", text: "x" });
  await rejects(() => mailer.send({ ...base, to: ["a@sand.nl", "klant@example.nl"], text: "x" }), "recipient_not_allowed");
  assert.equal(transport.sent.length, 1);
});

test("hooks get masked addresses and cannot break sending", async () => {
  const seen = [];
  const mailer = createMailer({ transport: memoryTransport(), from: base.from, onSent: (info) => { seen.push(info); throw new Error("logger down"); } });
  await mailer.send({ ...base, text: "x" });
  assert.deepEqual(seen[0].to, ["k***@example.nl"]);
  assert.equal(seen[0].subject, "Hallo");
});

test("createMailer validates its setup", () => {
  throwsCode(() => createMailer({}), "invalid_config");
  throwsCode(() => createMailer({ transport: memoryTransport(), from: "not an address" }), "invalid_address");
});

// ---------- failover ----------

test("failover moves on after temporary failures but never after a permanent rejection", async () => {
  const down = { name: "down", send: async () => { throw new MailError("down", { retryable: true, code: "connection_failed" }); } };
  const up = memoryTransport();
  const ft = failoverTransport([down, up]);
  const r = await ft.send(prepareMessage({ ...base, text: "x" }));
  assert.equal(r.transport, "memory");
  const rejecting = { name: "no", send: async () => { throw new MailError("spam", { code: "rejected" }); } };
  await rejects(() => failoverTransport([rejecting, up]).send(prepareMessage({ ...base, text: "x" })), "rejected");
  const unknown = { name: "u", send: async () => { throw new MailError("?", { code: "delivery_unknown" }); } };
  await rejects(() => failoverTransport([unknown, up]).send(prepareMessage({ ...base, text: "x" })), "delivery_unknown");
  assert.equal(up.sent.length, 1);
  throwsCode(() => failoverTransport([up]), "invalid_config");
});

// ---------- Resend ----------

function fakeResend(handler) {
  const calls = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const call = { headers: req.headers, url: req.url, body: JSON.parse(body || "{}") };
      calls.push(call);
      const [status, payload, delay] = handler(call, calls.length);
      setTimeout(() => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); }, delay ?? 0);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test("resend: maps the message, sends the key and an idempotency key", async () => {
  const api = await fakeResend(() => [200, { id: "re-1" }]);
  try {
    const t = resendTransport({ apiKey: "re_test123", apiUrl: api.url });
    const result = await t.send(prepareMessage({ ...base, cc: "cc@x.nl", replyTo: "hulp@x.nl", html: "<p>x</p>", unsubscribe: { url: "https://x.nl/u" }, attachments: [{ filename: "a.txt", content: "hi" }] }));
    assert.equal(result.id, "re-1");
    const c = api.calls[0];
    assert.equal(c.url, "/emails");
    assert.equal(c.headers.authorization, "Bearer re_test123");
    assert.match(c.headers["idempotency-key"], /^[0-9a-f]{32}@prijzenwacht\.nl$/);
    assert.equal(c.body.from, '"Prijzenwacht" <noreply@prijzenwacht.nl>');
    assert.deepEqual(c.body.to, ["klant@example.nl"]);
    assert.deepEqual(c.body.cc, ["cc@x.nl"]);
    assert.deepEqual(c.body.reply_to, ["hulp@x.nl"]);
    assert.equal(c.body.html, "<p>x</p>");
    assert.equal(c.body.text, "x");
    assert.equal(c.body.headers["List-Unsubscribe"], "<https://x.nl/u>");
    assert.equal(c.body.attachments[0].content, Buffer.from("hi").toString("base64"));
  } finally { api.close(); }
});

test("resend: retries 429 and 5xx with the same idempotency key, not 401 or 422", async () => {
  let n = 0;
  const api = await fakeResend(() => (++n < 3 ? [n === 1 ? 429 : 503, { message: "slow down" }] : [200, { id: "ok" }]));
  try {
    const mailer = createMailer({ transport: resendTransport({ apiKey: "re_x", apiUrl: api.url }), from: base.from, retryDelayMs: 1 });
    const r = await mailer.send({ ...base, text: "x" });
    assert.equal(r.attempts, 3);
    assert.equal(new Set(api.calls.map((c) => c.headers["idempotency-key"])).size, 1);
  } finally { api.close(); }
  for (const [status, code] of [[401, "auth_failed"], [422, "rejected"]]) {
    const bad = await fakeResend(() => [status, { message: "nope" }]);
    try {
      const mailer = createMailer({ transport: resendTransport({ apiKey: "re_x", apiUrl: bad.url }), from: base.from, retryDelayMs: 1 });
      await assert.rejects(() => mailer.send({ ...base, text: "x" }), (e) => e.code === code && e.attempts === 1 && !e.retryable);
    } finally { bad.close(); }
  }
});

test("resend: a slow server is a retryable timeout; the API key never shows in errors", async () => {
  const api = await fakeResend(() => [200, { id: "late" }, 300]);
  try {
    const t = resendTransport({ apiKey: "re_secretvalue", apiUrl: api.url, timeoutMs: 50 });
    await assert.rejects(() => t.send(prepareMessage({ ...base, text: "x" })), (e) => e.code === "timeout" && e.retryable && !JSON.stringify(e).includes("secretvalue") && !e.message.includes("secretvalue"));
  } finally { api.close(); }
  throwsCode(() => resendTransport({ apiKey: "nope" }), "invalid_config");
});

// ---------- SMTP ----------

const dir = mkdtempSync(join(tmpdir(), "mailkit-"));
let cert;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=localhost", "-days", "2", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  cert = { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
} catch { cert = null; }
test.after(() => rmSync(dir, { recursive: true, force: true }));

function fakeSmtp(o = {}) {
  const log = [];
  const messages = [];
  const serve = (socket, secure) => {
    let buffer = "";
    let data = null;
    const send = (line) => socket.write(`${line}\r\n`);
    if (!secure && !o.startedSecure) send("220 fake ESMTP");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const body = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          data = null;
          messages.push({ body: body.replace(/^\.\./gm, "."), mail: log.filter((l) => l.startsWith("MAIL") || l.startsWith("RCPT")) });
          if (o.dropAfterData) return socket.destroy();
          send(o.dataReply ?? "250 2.0.0 Ok: queued as QID123");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const cmd = line.toUpperCase();
        log.push(o.step ? "<auth step>" : line.startsWith("AUTH PLAIN") ? "AUTH PLAIN <hidden>" : line);
        if (cmd.startsWith("EHLO")) {
          const caps = ["250-fake", ...(o.size ? [`250-SIZE ${o.size}`] : []), ...(o.starttls && !secure ? ["250-STARTTLS"] : []), ...(o.auth ? [`250-AUTH ${o.auth}`] : []), "250 8BITMIME"];
          caps.forEach(send);
        } else if (cmd === "STARTTLS") {
          send("220 go ahead");
          socket.removeAllListeners("data");
          serve(new TLSSocket(socket, { isServer: true, ...cert }), true);
          return;
        } else if (cmd.startsWith("AUTH PLAIN")) {
          const [, user, pass] = Buffer.from(line.split(" ")[2], "base64").toString().split("\0");
          log.push(`PLAIN ${user}:${pass}`);
          send(user === "u@x.nl" && pass === "pw" ? "235 ok" : "535 5.7.8 bad credentials");
        } else if (cmd === "AUTH LOGIN") { o.step = 1; send("334 VXNlcm5hbWU6"); }
        else if (o.step === 1) { o.user = Buffer.from(line, "base64").toString(); o.step = 2; send("334 UGFzc3dvcmQ6"); }
        else if (o.step === 2) { o.step = 0; send(o.user === "u@x.nl" && Buffer.from(line, "base64").toString() === "pw" ? "235 ok" : "535 bad"); }
        else if (cmd.startsWith("MAIL FROM")) send("250 ok");
        else if (cmd.startsWith("RCPT TO")) {
          const to = /<(.+)>/.exec(line)[1];
          send(o.rejectRcpt?.includes(to) ? (o.rcptCode ?? "550 5.1.1 no such user") : "250 ok");
        } else if (cmd === "DATA") { data = ""; send("354 go"); }
        else if (cmd === "QUIT") { send("221 bye"); socket.end(); return; }
        else send("502 unknown");
      }
    });
  };
  const server = o.implicit ? createTlsServer({ ...cert }, (s) => { s.write("220 fake ESMTP\r\n"); serve(s, true); }) : createNetServer((s) => serve(s, false));
  if (o.implicit) { o.startedSecure = true; }
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ log, messages, port: server.address().port, close: () => server.close() })));
}
const tlsTest = cert ? test : test.skip;
const insecure = { rejectUnauthorized: false };

test("smtp: plain delivery without encryption only when explicitly allowed; dot-stuffing and CRLF intact", async () => {
  const s = await fakeSmtp();
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port, security: "none" });
    const result = await t.send({ ...base, text: "regel een\n.begint met punt\n..twee punten\nlaatste", to: "a@x.nl, b@x.nl" });
    assert.deepEqual(result.accepted, ["a@x.nl", "b@x.nl"]);
    assert.equal(result.id, "QID123");
    assert.ok(s.log.includes("MAIL FROM:<noreply@prijzenwacht.nl>"));
    assert.equal(decodeQp(s.messages[0].body.split("\r\n\r\n").slice(1).join("\r\n\r\n")), "regel een\r\n.begint met punt\r\n..twee punten\r\nlaatste\r\n");
  } finally { s.close(); }
});

test("smtp: refuses to log in over an unencrypted connection unless told otherwise", async () => {
  throwsCode(() => smtpTransport({ host: "h", security: "none", user: "u", pass: "p" }), "invalid_config");
  throwsCode(() => smtpTransport({ host: "h", user: "u" }), "invalid_config");
  throwsCode(() => smtpTransport({}), "invalid_config");
  const s = await fakeSmtp({ auth: "PLAIN" });
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port, security: "none", user: "u@x.nl", pass: "pw", allowInsecureAuth: true });
    await t.send({ ...base, text: "x" });
    assert.ok(s.log.includes("PLAIN u@x.nl:pw"));
  } finally { s.close(); }
});

test("smtp: when STARTTLS is required but not offered, nothing is sent", async () => {
  const s = await fakeSmtp();
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port });
    await rejects(() => t.send({ ...base, text: "x" }), "tls_unavailable");
    assert.equal(s.messages.length, 0);
    assert.ok(!s.log.some((l) => l.startsWith("MAIL")));
  } finally { s.close(); }
});

tlsTest("smtp: STARTTLS upgrade, then login with PLAIN and send", async () => {
  const s = await fakeSmtp({ starttls: true, auth: "PLAIN LOGIN" });
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port, user: "u@x.nl", pass: "pw", tls: insecure });
    await t.send({ ...base, text: "versleuteld" });
    const order = s.log.filter((l) => /^(EHLO|STARTTLS|PLAIN|MAIL)/.test(l)).map((l) => l.split(" ")[0]);
    assert.deepEqual(order, ["EHLO", "STARTTLS", "EHLO", "PLAIN", "MAIL"]);
    assert.equal(s.messages.length, 1);
    await t.verify();
  } finally { s.close(); }
});

tlsTest("smtp: implicit TLS (port 465 style) and AUTH LOGIN", async () => {
  const s = await fakeSmtp({ implicit: true, auth: "LOGIN" });
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port, security: "tls", user: "u@x.nl", pass: "pw", tls: insecure });
    const r = await t.send({ ...base, text: "x" });
    assert.equal(r.id, "QID123");
  } finally { s.close(); }
});

tlsTest("smtp: a wrong password is a permanent auth_failed and the password is not in the error", async () => {
  const s = await fakeSmtp({ implicit: true, auth: "PLAIN" });
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port, security: "tls", user: "u@x.nl", pass: "verygeheim", tls: insecure });
    await assert.rejects(() => t.send({ ...base, text: "x" }), (e) => e.code === "auth_failed" && !e.retryable && !JSON.stringify([e.message, e.response]).includes("verygeheim"));
  } finally { s.close(); }
});

tlsTest("smtp: certificate is checked by default and trusted through `ca`", async () => {
  const s = await fakeSmtp({ implicit: true });
  try {
    await rejects(() => smtpTransport({ host: "127.0.0.1", port: s.port, security: "tls" }).send({ ...base, text: "x" }), "tls_failed");
    const ok = smtpTransport({ host: "127.0.0.1", port: s.port, security: "tls", tls: { ca: cert.cert } });
    await ok.send({ ...base, text: "x" });
    assert.equal(s.messages.length, 1);
  } finally { s.close(); }
});

test("smtp: some recipients rejected is reported, all rejected is an error, 4xx is retryable", async () => {
  const s = await fakeSmtp({ rejectRcpt: ["slecht@x.nl"] });
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: s.port, security: "none" });
    const r = await t.send({ ...base, to: "goed@x.nl, slecht@x.nl", text: "x" });
    assert.deepEqual([r.accepted, r.rejected], [["goed@x.nl"], ["slecht@x.nl"]]);
    await assert.rejects(() => t.send({ ...base, to: "slecht@x.nl", text: "x" }), (e) => e.code === "recipient_rejected" && !e.retryable && e.responseCode === 550);
  } finally { s.close(); }
  const later = await fakeSmtp({ rejectRcpt: ["a@x.nl"], rcptCode: "451 4.7.1 greylisted" });
  try {
    const t = smtpTransport({ host: "127.0.0.1", port: later.port, security: "none" });
    await assert.rejects(() => t.send({ ...base, to: "a@x.nl", text: "x" }), (e) => e.retryable && e.responseCode === 451);
  } finally { later.close(); }
});

test("smtp: a 4xx after the data is retryable; a drop right after the data is delivery_unknown and not retried", async () => {
  const busy = await fakeSmtp({ dataReply: "452 4.3.1 insufficient storage" });
  try {
    await assert.rejects(() => smtpTransport({ host: "127.0.0.1", port: busy.port, security: "none" }).send({ ...base, text: "x" }), (e) => e.retryable && e.code === "temporary_failure");
  } finally { busy.close(); }
  const drop = await fakeSmtp({ dropAfterData: true });
  try {
    const mailer = createMailer({ transport: smtpTransport({ host: "127.0.0.1", port: drop.port, security: "none" }), from: base.from, retryDelayMs: 1 });
    await assert.rejects(() => mailer.send({ ...base, text: "x" }), (e) => e.code === "delivery_unknown" && !e.retryable && e.attempts === 1);
    assert.equal(drop.messages.length, 1, "must not be sent a second time");
  } finally { drop.close(); }
});

test("smtp: refuses a message above the server's SIZE limit before sending it; an unreachable server is retryable", async () => {
  const s = await fakeSmtp({ size: 500 });
  try {
    await rejects(() => smtpTransport({ host: "127.0.0.1", port: s.port, security: "none" }).send({ ...base, text: "x".repeat(2000) }), "too_large");
    assert.ok(!s.log.some((l) => l.startsWith("MAIL")));
  } finally { s.close(); }
  await assert.rejects(() => smtpTransport({ host: "127.0.0.1", port: 1, security: "none", timeoutMs: 500 }).send({ ...base, text: "x" }), (e) => e.code === "connection_failed" && e.retryable);
});

// ---------- lint, preview, links ----------

test("lintEmail warns about the usual deliverability mistakes", () => {
  const messages = lintEmail({ subject: "GRATIS!!! KOOP NU", html: '<img src="https://x.nl/a.png"><a href="http://x.nl">hier</a>' }).map((w) => w.message).join("\n");
  assert.match(messages, /ALL CAPS/);
  assert.match(messages, /exclamation/);
  assert.match(messages, /alt text/);
  assert.match(messages, /http:\/\//);
  assert.match(messages, /only images/i);
  assert.deepEqual(lintEmail(email({ subject: "Bevestig je mail", blocks: ["Hoi, bevestig je account via de knop hieronder."] })), []);
  assert.match(lintEmail({ subject: "x", html: "<p>" + "a".repeat(120_000) + "</p>" }).map((w) => w.message).join(), /102 KB/);
});

test("preview() is one page with subject, both widths and the text version, all escaped", () => {
  const page = preview(email({ subject: "<Hoi>", blocks: ["x"] }));
  assert.match(page, /<h1>&lt;Hoi&gt;<\/h1>/);
  assert.equal((page.match(/<iframe/g) ?? []).length, 2);
  assert.ok(!page.includes("<html lang"), "the mail's own html must be inside srcdoc, escaped");
});

test("extractLinks reads hrefs from html and urls from text", () => {
  assert.deepEqual(extractLinks('<a href="https://a.nl/?x=1&amp;y=2">a</a><a href="mailto:x@y.nl">m</a>'), ["https://a.nl/?x=1&y=2"]);
  assert.deepEqual(extractLinks("zie https://b.nl/p, en (https://c.nl)."), ["https://b.nl/p", "https://c.nl"]);
});
