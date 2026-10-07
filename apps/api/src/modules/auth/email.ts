import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

const transport = env.EMAIL_DRIVER === 'smtp' && env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;

/** Development sink keeps the last messages so tests and local users can follow links. */
export const outbox: { to: string; subject: string; text: string }[] = [];

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (transport) {
    await transport.sendMail({ from: env.EMAIL_FROM, to, subject, text });
    return;
  }
  outbox.push({ to, subject, text });
  if (outbox.length > 50) outbox.shift();
  logger.info({ to, subject, preview: text }, 'email (log driver)');
}
