import MailComposer from "nodemailer/lib/mail-composer";
import type { SendMailOptions } from "nodemailer";
import type { LocalFile } from "./files.ts";

export interface Draft {
  from: string;
  to: string;
  cc?: string | undefined;
  bcc?: string | undefined;
  subject: string;
  text: string;
  html?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  attachments?: LocalFile[] | undefined;
}

/** The nodemailer form of a draft, used both to build it and to send it. */
export function mailOptions(draft: Draft): SendMailOptions {
  const options: SendMailOptions = {
    from: draft.from,
    to: draft.to,
    subject: draft.subject,
    text: draft.text
  };
  if (draft.cc) options.cc = draft.cc;
  if (draft.bcc) options.bcc = draft.bcc;
  if (draft.html) options.html = draft.html;
  if (draft.inReplyTo) options.inReplyTo = draft.inReplyTo;
  if (draft.references?.length) options.references = draft.references;
  if (draft.attachments?.length) {
    options.attachments = draft.attachments.map((file) => ({ filename: file.filename, content: file.content }));
  }
  return options;
}

/** Build the raw RFC 5322 message, ready to store in Drafts. */
export function buildMessage(draft: Draft): Promise<Buffer> {
  // Bcc is normally dropped when building a message for delivery. A draft
  // has to keep it, or the recipient is lost when the user sends it.
  const composer = new MailComposer(mailOptions(draft));
  const node = composer.compile();
  node.keepBcc = true;
  return new Promise((resolveMessage, reject) => {
    node.build((error, message) => (error ? reject(error) : resolveMessage(message)));
  });
}
