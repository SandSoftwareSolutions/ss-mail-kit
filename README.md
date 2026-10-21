# @sandsoftwaresolutions/mail-kit

[![CI](https://github.com/SandSoftwareSolutions/ss-mail-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-mail-kit/actions/workflows/ci.yml)

Send good-looking email from Node without learning email. One small API for the whole job: build the mail, send it over **SMTP** (Zoho, Gmail, your own server) or **Resend**, retry temporary failures without ever sending twice, and test it without sending anything. No dependencies.

```js
import { createMailer, smtpTransport, email, block } from "@sandsoftwaresolutions/mail-kit";

const mailer = createMailer({
  from: "Prijzenwacht <noreply@prijzenwacht.sandsoftwaresolutions.com>",
  transport: smtpTransport({ host: "smtp.zoho.eu", user: "noreply@…", pass: process.env.SMTP_PASS }),
});

await mailer.send({
  to: "klant@example.nl",
  ...email({
    subject: "Bevestig je e-mailadres",
    preheader: "Nog één stap",
    lang: "nl",
    brand: { name: "Prijzenwacht", url: "https://prijzenwacht.sandsoftwaresolutions.com", color: "#0f766e" },
    blocks: [
      block.heading("Welkom!"),
      "Bevestig je e-mailadres om te beginnen. [Hulp nodig?](https://example.nl/hulp)",
      block.button("Bevestig mijn e-mailadres", verifyUrl),
      block.note("Heb jij dit niet aangevraagd? Dan kun je deze mail negeren."),
    ],
    footer: ["Prijzenwacht · KvK 12345678"],
  }),
});
```

## Install

```bash
npm install @sandsoftwaresolutions/mail-kit
```

Node 20 or newer. Works with `import` and `require()`, with TypeScript types for both.

## What you get

**Templates that work.** `email()` makes table-based HTML with inline styles (Outlook, Gmail and Apple Mail), a phone layout, a dark-mode variant, a hidden preheader, and a **hand-written plain-text version from the same blocks** (not stripped HTML). Blocks: `heading`, paragraph (a plain string), `button`, `code` (verification codes), `list`, `table` (invoice rows), `note`, `divider`, `image`. Text blocks understand `**bold**`, `` `code` `` and `[label](https://url)`. Everything is escaped; unsafe links and invalid colors are refused, not passed through.

**Transports.**

| | |
|---|---|
| `smtpTransport({ host, port, user, pass })` | Own SMTP client. Port 465 = TLS from the start; other ports **must** upgrade with STARTTLS or the send is refused (no silent downgrade). Certificates are checked. Refuses to send a password unencrypted. PLAIN and LOGIN. |
| `resendTransport({ apiKey })` | Resend HTTP API. The message id is the idempotency key, so a retry can never deliver twice. |
| `memoryTransport()` | Keeps mails in memory for tests. `transport.to("a@b.nl").links[0]` is the verification link. |
| `failoverTransport([a, b])` | Tries the next one only when the first never accepted the mail. |

**The mailer.** `createMailer({ transport, from })` then `mailer.send({ to, subject, html })`:

- Retries temporary failures (`retries: 2`, exponential backoff). Permanent rejections are not retried. If the connection breaks *after* the message was sent, the error is `delivery_unknown` and it is **not** retried, so nobody gets two mails.
- `redirectAllTo: "dev@…"` for staging: every mail goes there, with the real recipients (masked) in the subject.
- `allowDomains: ["sand.nl"]` blocks any other recipient before anything is sent.
- `onSent` / `onError` hooks get masked addresses; a hook that throws cannot break sending.
- `await mailer.verify()` at startup connects and logs in (SMTP) so wrong settings show up at boot.

**Safe by default.** Header injection (a line break in a subject, name or address) is refused. Addresses are validated (internationalized domains become punycode). `Bcc` never appears in headers. At most 50 recipients unless you raise it. Attachment names cannot contain path parts. Errors never contain your password or API key.

**Smaller things.** `unsubscribe: { url }` adds the one-click `List-Unsubscribe` headers. Attachments and inline images (`cid:`). `Auto-Submitted: auto-generated` on by default so out-of-office replies stay away. `lintEmail(mail)` warns about ALL CAPS subjects, mails over Gmail's 102 KB cut-off, `http://` links, images without alt text. `preview(mail)` returns one HTML page (wide, phone width and text) to open in a browser.

## Zoho

```js
smtpTransport({ host: "smtp.zoho.eu", port: 465, user: "noreply@yourdomain", pass: "<app password>" })
```

Use `smtp.zoho.com` for accounts in the US data centre. Create an app-specific password in the Zoho account settings. The `from` address must be the account's address or an alias of it. Zoho signs your mail (DKIM) once the domain's SPF and DKIM records are set; this package does not sign.

## Testing your own app

```js
const transport = memoryTransport();
const mailer = createMailer({ transport, from: "app@example.nl" });
await signUp("klant@example.nl");                       // your code, which calls mailer.send(...)
const link = transport.to("klant@example.nl").links[0]; // follow it in your test
```

## Errors

Everything thrown is a `MailError` with `code` and `retryable`. Examples: `invalid_address`, `auth_failed`, `recipient_rejected`, `temporary_failure`, `rate_limited`, `timeout`, `tls_failed`, `tls_unavailable`, `too_large`, `delivery_unknown`, `recipient_not_allowed`.

## Not included

No DKIM signing (your mail provider does it), no connection pool (one connection per mail; fine for transactional volumes), no bounce handling, no marketing-list management, no OAuth2 for SMTP, no `.mjml`. For mass mailing use a dedicated service.

MIT
