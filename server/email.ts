import nodemailer from 'nodemailer';
import { DatabaseSync } from 'node:sqlite';
import { getSetting, setSetting, splitRecipients } from './db.js';
import type { EmailSettings } from './types.js';

export function getEmailSettings(db: DatabaseSync, includePassword = false): EmailSettings {
  const password = getSetting(db, 'smtp_password', '');
  return {
    smtp_host: getSetting(db, 'smtp_host', ''),
    smtp_port: Number(getSetting(db, 'smtp_port', '587')) || 587,
    smtp_secure: getSetting(db, 'smtp_secure', 'false') === 'true',
    smtp_user: getSetting(db, 'smtp_user', ''),
    smtp_password: includePassword ? password : undefined,
    smtp_from: getSetting(db, 'smtp_from', ''),
    subject_prefix: getSetting(db, 'subject_prefix', ''),
    default_recipients: splitRecipients(getSetting(db, 'default_recipients', '')),
    default_interval_minutes: Number(getSetting(db, 'default_interval_minutes', '30')) || 30,
    has_smtp_password: Boolean(password)
  };
}

export function saveEmailSettings(db: DatabaseSync, payload: Partial<EmailSettings> & { smtp_password?: string }): EmailSettings {
  if (payload.smtp_host !== undefined) setSetting(db, 'smtp_host', String(payload.smtp_host || '').trim());
  if (payload.smtp_port !== undefined) setSetting(db, 'smtp_port', String(Number(payload.smtp_port) || 587));
  if (payload.smtp_secure !== undefined) setSetting(db, 'smtp_secure', payload.smtp_secure ? 'true' : 'false');
  if (payload.smtp_user !== undefined) setSetting(db, 'smtp_user', String(payload.smtp_user || '').trim());
  if (payload.smtp_password !== undefined && String(payload.smtp_password).trim() !== '') {
    setSetting(db, 'smtp_password', String(payload.smtp_password));
  }
  if (payload.smtp_from !== undefined) setSetting(db, 'smtp_from', String(payload.smtp_from || '').trim());
  if (payload.subject_prefix !== undefined) setSetting(db, 'subject_prefix', String(payload.subject_prefix || '').trim());
  if (payload.default_recipients !== undefined) {
    setSetting(db, 'default_recipients', splitRecipients(payload.default_recipients).join(','));
  }
  if (payload.default_interval_minutes !== undefined) {
    setSetting(db, 'default_interval_minutes', String(Number(payload.default_interval_minutes) || 30));
  }
  return getEmailSettings(db);
}

export async function sendEmail(db: DatabaseSync, recipients: string[], subject: string, text: string): Promise<string> {
  const settings = getEmailSettings(db, true);
  const to = recipients.length ? recipients : settings.default_recipients;
  if (!settings.smtp_host || !settings.smtp_from || to.length === 0) {
    throw new Error('SMTP 主机、发件人或收件人未配置');
  }
  const transporter = nodemailer.createTransport({
    host: settings.smtp_host,
    port: settings.smtp_port,
    secure: settings.smtp_secure,
    auth: settings.smtp_user
      ? {
          user: settings.smtp_user,
          pass: settings.smtp_password || ''
        }
      : undefined
  });
  const info = await transporter.sendMail({
    from: settings.smtp_from,
    to: to.join(','),
    subject: `${settings.subject_prefix || ''}${subject}`,
    text
  });
  return String(info.messageId || 'sent');
}
