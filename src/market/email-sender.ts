import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EmailSender {
  send(to: string, subject: string, textBody: string): Promise<void>;
}

/** DI token for the active `EmailSender` implementation — see `market.module.ts` for which one is bound, chosen by `EMAIL_PROVIDER`. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/**
 * Default sender — no real delivery, just logs the code where an operator
 * (or, for this demo build, the person testing it) can read it. This is
 * what runs whenever `EMAIL_PROVIDER`/`RESEND_API_KEY` aren't configured,
 * which is always true in this sandboxed build since there's no outbound
 * SMTP/API credential available here. Swapping in `ResendEmailSender`
 * below is the entire integration surface for real delivery — nothing else
 * in `EmailAuthService` changes.
 */
@Injectable()
export class ConsoleEmailSender implements EmailSender {
  private readonly logger = new Logger('EmailSender(console)');

  async send(to: string, subject: string, textBody: string): Promise<void> {
    this.logger.log(`Would send to ${to} — "${subject}"\n${textBody}`);
  }
}

/**
 * Real delivery via Resend's HTTP API (https://resend.com) — chosen over a
 * full SDK dependency since the entire integration is one POST. Needs
 * `RESEND_API_KEY` and a verified sending domain in a real deployment;
 * until then this class exists but is never selected (see
 * `EMAIL_SENDER_PROVIDER` in `market.module.ts`).
 */
@Injectable()
export class ResendEmailSender implements EmailSender {
  private readonly logger = new Logger('EmailSender(resend)');

  constructor(private readonly config: ConfigService) {}

  async send(to: string, subject: string, textBody: string): Promise<void> {
    const apiKey = this.config.get<string>('resendApiKey');
    const from = this.config.get<string>('emailFrom')!;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend');
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text: textBody }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`Resend send failed: ${res.status} ${body}`);
      throw new Error(`email delivery failed (${res.status})`);
    }
  }
}
