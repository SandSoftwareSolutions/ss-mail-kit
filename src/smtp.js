import { hostname } from "node:os";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

import { MailError } from "./errors.js";
import { prepareMessage } from "./message.js";

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1)$/;

const networkError = (error, stage) => {
  const code = error?.code;
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID" || /certificate|self.signed|unable to verify/i.test(error?.message ?? "")) {
    return new MailError(`The mail server's certificate was refused: ${error.message}`, { code: "tls_failed", cause: error });
  }
  if (stage === "sent") {
    return new MailError("The connection broke after the message was sent; it may or may not have been delivered", { code: "delivery_unknown", cause: error });
  }
  return new MailError(`Could not talk to the mail server (${code ?? error?.message ?? "error"})`, { code: "connection_failed", retryable: true, cause: error });
};

class Connection {
  constructor(socket, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.stage = "connect";
    this.bind(socket);
  }

  bind(socket) {
    this.socket = socket;
    this.buffer = "";
    this.lines = [];
    this.queue = [];
    this.waiter = null;
    this.failure = null;
    socket.setTimeout(this.timeoutMs);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => this.fail(networkError(error, this.stage)));
    socket.on("close", () => this.fail(networkError(Object.assign(new Error("connection closed"), { code: "ECONNRESET" }), this.stage)));
    socket.on("timeout", () => this.fail(this.stage === "sent"
      ? new MailError("The mail server did not answer after the message was sent; it may or may not have been delivered", { code: "delivery_unknown" })
      : new MailError("The mail server did not answer in time", { code: "timeout", retryable: true })));
  }

  onData(chunk) {
    this.buffer += chunk.toString("latin1");
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.lines.push(line);
      const match = /^(\d{3})([ -]?)/.exec(line);
      if (!match) continue;
      if (match[2] !== "-") {
        this.queue.push({ code: Number(match[1]), lines: this.lines.map((l) => l.slice(4)), text: this.lines.map((l) => l.slice(4)).join("\n") });
        this.lines = [];
        this.flush();
      }
    }
  }

  flush() {
    if (this.waiter && this.queue.length) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(this.queue.shift());
    }
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(error);
    }
  }

  reply() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => (this.waiter = { resolve, reject }));
  }

  write(data) {
    if (this.failure) return;
    this.socket.write(data, "latin1");
  }

  async command(line, expect) {
    this.write(`${line}\r\n`);
    const reply = await this.reply();
    if (expect && !expect.includes(reply.code)) throw replyError(reply, line.split(" ")[0]);
    return reply;
  }

  destroy() {
    this.socket.destroy();
  }
}

function replyError(reply, command) {
  const transient = reply.code >= 400 && reply.code < 500;
  const auth = reply.code === 535 || reply.code === 534 || reply.code === 530 || reply.code === 454 || command === "AUTH";
  const code = auth ? "auth_failed" : command === "RCPT" ? "recipient_rejected" : command === "MAIL" ? "sender_rejected" : transient ? "temporary_failure" : "rejected";
  return new MailError(`Mail server answered ${reply.code} to ${command}: ${reply.text.slice(0, 200)}`, {
    code,
    retryable: transient && !auth,
    responseCode: reply.code,
    response: reply.text.slice(0, 500),
  });
}

function parseCapabilities(reply) {
  const caps = new Map();
  for (const line of reply.lines.slice(1)) {
    const [name, ...rest] = line.trim().split(/\s+/);
    caps.set(name.toUpperCase(), rest.join(" "));
  }
  return caps;
}

function openSocket(o) {
  return new Promise((resolve, reject) => {
    const socket =
      o.security === "tls"
        ? tlsConnect({ host: o.host, port: o.port, servername: o.tls.servername ?? (LOOPBACK.test(o.host) ? undefined : o.host), ...o.tls })
        : netConnect({ host: o.host, port: o.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new MailError(`Could not connect to ${o.host}:${o.port} in time`, { code: "timeout", retryable: true }));
    }, o.timeoutMs);
    socket.once(o.security === "tls" ? "secureConnect" : "connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
    const onError = (error) => {
      clearTimeout(timer);
      reject(networkError(error, "connect"));
    };
    socket.once("error", onError);
  });
}

function upgrade(connection, o) {
  return new Promise((resolve, reject) => {
    const plain = connection.socket;
    plain.removeAllListeners();
    plain.setTimeout(0);
    plain.on("error", () => {});
    const secure = tlsConnect({ socket: plain, servername: o.tls.servername ?? (LOOPBACK.test(o.host) ? undefined : o.host), ...o.tls });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", (error) => reject(networkError(error, "connect")));
  });
}

async function openSession(o) {
  const socket = await openSocket(o);
  const c = new Connection(socket, o.timeoutMs);
  try {
    const hello = await c.reply();
    if (hello.code !== 220) throw replyError(hello, "CONNECT");
    let ehlo = await c.command(`EHLO ${o.clientName}`);
    if (ehlo.code >= 500) ehlo = await c.command(`HELO ${o.clientName}`, [250]);
    let caps = parseCapabilities(ehlo);
    let secureNow = o.security === "tls";
    if (o.security === "starttls") {
      if (!caps.has("STARTTLS")) throw new MailError("The mail server does not offer STARTTLS, so the connection would not be encrypted. Use security: \"none\" only if you really want that.", { code: "tls_unavailable" });
      await c.command("STARTTLS", [220]);
      c.bind(await upgrade(c, o));
      secureNow = true;
      ehlo = await c.command(`EHLO ${o.clientName}`, [250]);
      caps = parseCapabilities(ehlo);
    }
    if (o.user !== undefined) {
      if (!secureNow && !o.allowInsecureAuth) throw new MailError("Refusing to send the password over an unencrypted connection", { code: "tls_unavailable" });
      await authenticate(c, caps, o);
    }
    return { c, caps };
  } catch (error) {
    c.destroy();
    throw error;
  }
}

async function authenticate(c, caps, o) {
  const offered = (caps.get("AUTH") ?? "").toUpperCase().split(/\s+/);
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  if (offered.includes("PLAIN")) {
    await c.command(`AUTH PLAIN ${b64(`\0${o.user}\0${o.pass}`)}`, [235]);
  } else if (offered.includes("LOGIN")) {
    await c.command("AUTH LOGIN", [334]);
    await c.command(b64(o.user), [334]);
    await c.command(b64(o.pass), [235]);
  } else {
    throw new MailError(`The mail server offers no login method this package supports (it offers: ${offered.join(" ") || "none"})`, { code: "auth_failed" });
  }
}

const dotStuff = (raw) => {
  const text = raw.toString("latin1").replace(/(^|\r\n)\./g, "$1..");
  return text.endsWith("\r\n") ? text : `${text}\r\n`;
};

/**
 * Sends through any SMTP server (Zoho, Gmail, your own). Encrypted by default: port 465 uses TLS right away,
 * other ports must offer STARTTLS or the send is refused. No dependencies.
 */
export function smtpTransport(options = {}) {
  const port = options.port ?? (options.security === "tls" ? 465 : 587);
  const security = options.security ?? (port === 465 ? "tls" : "starttls");
  if (!options.host || typeof options.host !== "string") throw new MailError("smtpTransport needs a host", { code: "invalid_config" });
  if (!["tls", "starttls", "none"].includes(security)) throw new MailError('security must be "tls", "starttls" or "none"', { code: "invalid_config" });
  if ((options.user === undefined) !== (options.pass === undefined)) throw new MailError("Give both user and pass, or neither", { code: "invalid_config" });
  if (security === "none" && options.user !== undefined && !options.allowInsecureAuth) {
    throw new MailError('A login over security: "none" would send the password unencrypted; set allowInsecureAuth: true to allow it', { code: "invalid_config" });
  }
  const o = {
    host: options.host,
    port,
    security,
    user: options.user,
    pass: options.pass,
    allowInsecureAuth: options.allowInsecureAuth === true,
    timeoutMs: options.timeoutMs ?? 20_000,
    clientName: String(options.clientName ?? (hostname().replace(/[^A-Za-z0-9.-]/g, "") || "localhost")),
    tls: { ...options.tls },
  };

  const withSession = async (work) => {
    const session = await openSession(o);
    try {
      return await work(session);
    } finally {
      session.c.write("QUIT\r\n");
      setTimeout(() => session.c.destroy(), 200).unref();
    }
  };

  return {
    name: "smtp",
    /** Opens a connection, encrypts it and logs in, then closes. Use it at startup to catch wrong settings early. */
    verify: () => withSession(async () => true),
    async send(input) {
      const message = input.raw ? input : prepareMessage(input);
      const raw = message.raw;
      return withSession(async ({ c, caps }) => {
        const limit = Number(caps.get("SIZE"));
        if (limit > 0 && raw.length > limit) throw new MailError(`The message is ${raw.length} bytes; the server accepts at most ${limit}`, { code: "too_large" });
        await c.command(`MAIL FROM:<${message.envelope.from}>`, [250]);
        const accepted = [];
        const rejected = [];
        let lastError;
        for (const to of message.envelope.to) {
          const reply = await c.command(`RCPT TO:<${to}>`);
          if (reply.code === 250 || reply.code === 251) accepted.push(to);
          else {
            rejected.push(to);
            lastError = replyError(reply, "RCPT");
          }
        }
        if (!accepted.length) throw lastError;
        await c.command("DATA", [354]);
        c.stage = "sent";
        c.write(`${dotStuff(raw)}.\r\n`);
        const done = await c.reply();
        c.stage = "done";
        if (done.code !== 250) throw replyError(done, "DATA");
        const queued = /queued as ([\w.@-]+)|\bid[ =:]+([\w.@-]+)/i.exec(done.text);
        return { id: queued?.[1] ?? queued?.[2] ?? message.messageId, messageId: message.messageId, accepted, rejected, response: done.text.slice(0, 500) };
      });
    },
  };
}
