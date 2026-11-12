import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';

@Injectable()
export class PasswordResetMailer {
  constructor(private readonly config: ConfigService) {}

  async sendReset(email: string, token: string): Promise<void> {
    // Validate before creating a transport. Never use a URL supplied by a request.
    const url = new URL(
      this.config.get<string>('PASSWORD_RESET_FRONTEND_URL') ?? '',
    );
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('RESET_MAIL_CONFIGURATION_INVALID');
    }
    const host = this.config.get<string>('SMTP_HOST');
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASSWORD');
    const from = this.config.get<string>('SMTP_FROM');
    const port = Number(this.config.get<string>('SMTP_PORT'));
    if (!host || !user || !pass || !from || ![465, 587].includes(port)) {
      throw new Error('RESET_MAIL_CONFIGURATION_INVALID');
    }
    const transport = createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: true,
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    url.searchParams.set('token', token);
    try {
      const result = await transport.sendMail({
        from,
        to: email,
        subject: 'Đặt lại mật khẩu Text-to-Voice',
        text: `Liên kết đặt lại mật khẩu (hết hạn sau 15 phút): ${url.toString()}\nNếu bạn không yêu cầu, hãy bỏ qua email này.`,
      });
      if (!result.accepted?.length)
        throw new Error('RESET_MAIL_DELIVERY_FAILED');
    } catch {
      throw new Error('RESET_MAIL_DELIVERY_FAILED');
    } finally {
      transport.close();
    }
  }
}
