/**
 * SendGrid delivery.
 *
 * This is the only file in the system that talks to the email provider. The
 * backend publishes; the worker sends.
 */

import sgMail from '@sendgrid/mail';
import { config } from './config.js';
import type { Rendered } from './render.js';

if (config.SENDGRID_API_KEY) sgMail.setApiKey(config.SENDGRID_API_KEY);

export interface SendResult {
  delivered: boolean;
  messageId?: string;
  redirectedFrom?: string;
  skipped?: string;
}

/** SendGrid errors that will never succeed on retry. */
const PERMANENT_STATUS = new Set([400, 401, 403, 413]);

export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSendError';
  }
}

export async function send(to: string, toName: string | undefined, email: Rendered): Promise<SendResult> {
  if (!config.EMAIL_SEND_ENABLED) {
    return { delivered: false, skipped: 'EMAIL_SEND_ENABLED=false' };
  }

  // In staging this stops a copied production database from emailing real
  // families. The original recipient is preserved in the subject for clarity.
  const redirected = config.EMAIL_REDIRECT_TO?.trim() || undefined;
  const recipient = (redirected ?? to).trim();
  if (!recipient) {
    // Never hand SendGrid an empty address: it fails with an opaque
    // "Does not contain a valid address" that points at the payload, not the
    // config that produced it.
    throw new PermanentSendError('no recipient address — refusing to send');
  }
  const subject = redirected ? `[to: ${to}] ${email.subject}` : email.subject;

  try {
    const [response] = await sgMail.send({
      to: toName && !redirected ? { email: recipient, name: toName } : recipient,
      from: { email: config.EMAIL_FROM, name: config.EMAIL_FROM_NAME },
      subject,
      text: email.text,
      html: email.html,
      trackingSettings: { clickTracking: { enable: true, enableText: false } },
    });

    return {
      delivered: true,
      ...(response.headers['x-message-id']
        ? { messageId: String(response.headers['x-message-id']) }
        : {}),
      ...(redirected ? { redirectedFrom: to } : {}),
    };
  } catch (err) {
    const status = (err as { code?: number })?.code;
    const body = (err as { response?: { body?: unknown } })?.response?.body;
    const detail = `${status ?? 'unknown'} ${JSON.stringify(body ?? {}).slice(0, 400)}`;

    // A bad address or a rejected payload will fail identically on every retry;
    // marking it permanent stops five pointless attempts over an hour.
    if (status && PERMANENT_STATUS.has(status)) {
      throw new PermanentSendError(`SendGrid rejected the message: ${detail}`);
    }
    throw new Error(`SendGrid send failed: ${detail}`);
  }
}
