export interface Address { name: string; address: string }
export type AddressInput = string | { name?: string; address: string };
export type AddressesInput = AddressInput | AddressInput[];

export class MailError extends Error {
  /** invalid_address, invalid_header, invalid_message, invalid_template, invalid_config, no_recipients, auth_failed,
   *  recipient_rejected, rejected, temporary_failure, rate_limited, timeout, connection_failed, tls_failed,
   *  tls_unavailable, too_large, delivery_unknown, recipient_not_allowed, send_failed, ... */
  code: string;
  /** True when sending the same message again is safe and may work. */
  retryable: boolean;
  /** Set by the mailer: how many tries were made. */
  attempts?: number;
  responseCode?: number;
  response?: string;
}

export interface Attachment {
  filename: string;
  content: Buffer | Uint8Array | string;
  /** "base64" when `content` is a base64 string. */
  encoding?: "base64" | "utf8";
  contentType?: string;
  /** Makes it an inline image: use `<img src="cid:logo">` with `cid: "logo"`. */
  cid?: string;
}

export interface MessageInput {
  from?: AddressInput;
  to?: AddressesInput;
  cc?: AddressesInput;
  bcc?: AddressesInput;
  replyTo?: AddressesInput;
  subject: string;
  html?: string;
  /** Made from the html when left out. */
  text?: string;
  headers?: Record<string, string>;
  attachments?: Attachment[];
  /** Adds List-Unsubscribe and the one-click header. */
  unsubscribe?: { url?: string; mailto?: string };
  /** Default true: adds `Auto-Submitted: auto-generated`, which stops out-of-office replies. */
  autoSubmitted?: boolean;
  messageId?: string;
  date?: Date;
  /** Bounce address, if different from `from`. */
  envelopeFrom?: string;
  /** Default 50. */
  maxRecipients?: number;
}

export interface PreparedMessage {
  from: Address; to: Address[]; cc: Address[]; bcc: Address[]; replyTo: Address[];
  subject: string; html?: string; text: string;
  headers: Record<string, string>;
  attachments: { filename: string; content: Buffer; contentType: string; cid?: string }[];
  messageId: string; date: Date;
  envelope: { from: string; to: string[] };
  /** The complete RFC 5322 message, all CRLF, 7-bit. */
  readonly raw: Buffer;
}

export interface SendResult {
  id: string; messageId: string; accepted: string[]; rejected: string[]; response?: string;
  attempts?: number; transport?: string;
}

export interface Transport {
  name: string;
  send(message: PreparedMessage | MessageInput): Promise<SendResult>;
  verify?(): Promise<unknown>;
}

export function isEmail(value: unknown): boolean;
export function normalizeAddress(address: string): string;
export function parseAddress(input: AddressInput): Address;
export function parseAddressList(input?: AddressesInput): Address[];
export function encodeWords(text: string): string;
export function formatAddress(address: Address): string;
export function prepareMessage(input: MessageInput, defaults?: Partial<MessageInput>): PreparedMessage;
export function quotedPrintable(text: string): string;

export function escapeHtml(value: unknown): string;
export function htmlToText(html: string): string;
export function wrapText(text: string, width?: number): string;
export function extractLinks(content: string): string[];

export type Block =
  | { type: "heading"; text: string; level: 1 | 2 }
  | { type: "paragraph" | "note"; text: string }
  | { type: "button"; label: string; url: string }
  | { type: "code"; value: string; caption?: string }
  | { type: "list"; items: string[]; ordered: boolean }
  | { type: "table"; rows: [string, string][]; total: boolean }
  | { type: "divider" }
  | { type: "image"; src: string; alt: string; width?: number };

export const block: {
  heading(text: string, level?: 1 | 2): Block;
  paragraph(text: string): Block;
  button(label: string, url: string): Block;
  code(value: string, caption?: string): Block;
  list(items: string[], options?: { ordered?: boolean }): Block;
  table(rows: [string, string][], options?: { total?: boolean }): Block;
  note(text: string): Block;
  divider(): Block;
  image(src: string, alt: string, options?: { width?: number }): Block;
};

export interface EmailOptions {
  subject: string;
  /** Preview text shown next to the subject in the inbox. */
  preheader?: string;
  /** Strings are paragraphs. Text blocks understand **bold**, `code` and [label](https://url). */
  blocks: (Block | string)[];
  footer?: string | string[];
  lang?: string;
  brand?: { name?: string; url?: string; logoUrl?: string; color?: string; buttonTextColor?: string; textColor?: string; background?: string; font?: string };
}
export interface Mail { subject: string; html: string; text: string }
export function email(options: EmailOptions): Mail;
/** Escape a name or any outside text before putting it in a block, so it cannot turn into a link, bold text or code. */
export function escapeMarkup(value: unknown): string;
export function preview(mail: Mail): string;
export function lintEmail(mail: MessageInput | PreparedMessage): { level: "warning" | "info"; message: string }[];

export interface SmtpOptions {
  host: string;
  /** Default 587 (465 when security is "tls"). */
  port?: number;
  /** "tls" = encrypted from the start (port 465), "starttls" = must upgrade or fail (default), "none" = no encryption. */
  security?: "tls" | "starttls" | "none";
  user?: string;
  pass?: string;
  allowInsecureAuth?: boolean;
  timeoutMs?: number;
  clientName?: string;
  tls?: { rejectUnauthorized?: boolean; ca?: string | Buffer | (string | Buffer)[]; servername?: string; minVersion?: string };
}
export function smtpTransport(options: SmtpOptions): Transport & { verify(): Promise<true> };
export function resendTransport(options: { apiKey: string; apiUrl?: string; fetch?: typeof fetch; timeoutMs?: number }): Transport;
export function memoryTransport(): Transport & {
  sent: (PreparedMessage & { links: string[] })[];
  last(): (PreparedMessage & { links: string[] }) | undefined;
  to(address: string): (PreparedMessage & { links: string[] }) | undefined;
  clear(): void;
};
export function failoverTransport(transports: Transport[]): Transport & { verify(): Promise<boolean> };

export interface MailerOptions extends Partial<MessageInput> {
  transport: Transport;
  /** Extra tries for temporary failures. Default 2. */
  retries?: number;
  retryDelayMs?: number;
  /** Every mail goes here instead (staging); the real recipients are noted in the subject. */
  redirectAllTo?: AddressesInput;
  /** Only these recipient domains may get mail. */
  allowDomains?: string[];
  onSent?: (info: SendResult & { to: string[]; subject: string }) => void;
  onError?: (error: MailError, info: { to: string[]; subject: string }) => void;
}
export function createMailer(options: MailerOptions): {
  send(message: MessageInput): Promise<SendResult>;
  verify(): Promise<unknown>;
  transport: Transport;
};
