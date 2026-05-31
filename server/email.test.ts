import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './db.js';
import { getEmailSettings, saveEmailSettings, sendEmail } from './email.js';

const { createTransport, sendMail } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: 'message-1' }));
  const createTransport = vi.fn(() => ({ sendMail }));
  return { createTransport, sendMail };
});

vi.mock('nodemailer', () => ({
  default: { createTransport },
  createTransport
}));

describe('email settings', () => {
  beforeEach(() => {
    createTransport.mockClear();
    sendMail.mockClear();
  });

  it('saves and applies the configured subject prefix', async () => {
    const db = createDatabase(':memory:');
    const saved = saveEmailSettings(db, {
      smtp_host: 'smtp.example.com',
      smtp_port: 465,
      smtp_secure: true,
      smtp_user: 'mailer',
      smtp_password: 'secret',
      smtp_from: 'AI <ai@example.com>',
      subject_prefix: '【abc】',
      default_recipients: ['ops@example.com'],
      default_interval_minutes: 15
    });

    expect(saved.subject_prefix).toBe('【abc】');
    expect(getEmailSettings(db).subject_prefix).toBe('【abc】');

    await expect(sendEmail(db, [], 'AI 渠道管理台测试邮件', '这是一封测试邮件。')).resolves.toBe('message-1');

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@example.com',
        subject: '【abc】AI 渠道管理台测试邮件'
      })
    );
    db.close();
  });
});
