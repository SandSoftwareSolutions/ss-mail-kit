import { MailError } from "./errors.js";
import { encodeWords, formatAddress, isEmail, normalizeAddress, parseAddress, parseAddressList } from "./address.js";
import { prepareMessage, quotedPrintable } from "./message.js";
import { escapeHtml, extractLinks, htmlToText, wrapText } from "./text.js";
import { block, email } from "./template.js";
import { smtpTransport } from "./smtp.js";
import { failoverTransport, memoryTransport, resendTransport } from "./transports.js";
import { createMailer } from "./mailer.js";
import { lintEmail } from "./lint.js";
import { preview } from "./preview.js";

export { MailError, encodeWords, formatAddress, isEmail, normalizeAddress, parseAddress, parseAddressList };
export { prepareMessage, quotedPrintable, escapeHtml, extractLinks, htmlToText, wrapText };
export { block, email, smtpTransport, failoverTransport, memoryTransport, resendTransport, createMailer, lintEmail, preview };
