/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-require-imports */
// Dynamic mock delegates intentionally model malformed inputs and transaction failures.
import 'reflect-metadata';
import { ExecutionContext, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { JwtStrategy } from './strategies/jwt.strategy/jwt.strategy';
import { RegisterDto } from './dto/register.dto/register.dto';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { PasswordResetMailer } from './password-reset-mailer.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { createTransport } from 'nodemailer';

jest.mock('bcrypt', () => ({
  hash: jest.fn(async () => 'hashed'),
  compare: jest.fn(async (plain) => plain !== 'wrong'),
}));
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('@nestjs/passport', () => ({
  PassportStrategy: () => class MockStrategy {},
  AuthGuard: () => class MockGuard {},
}));

describe('Account security (isolated mocks, no DB/SMTP)', () => {
  let prisma: any;
  let mailer: any;
  let service: AuthService;
  let jwt: any;
  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      passwordResetToken: {
        findUnique: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    prisma.$transaction = jest.fn(async (callback) => callback(prisma));
    mailer = { sendReset: jest.fn() };
    jwt = { signAsync: jest.fn(async () => 'mock-jwt') };
    service = new AuthService(
      { create: jest.fn() } as any,
      jwt,
      prisma,
      mailer,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('has no public POST /users handler, preserves named APIs', () => {
    expect((UsersController.prototype as any).create).toBeUndefined();
    for (const key of Object.getOwnPropertyNames(UsersController.prototype)) {
      const fn = (UsersController.prototype as any)[key];
      if (Reflect.getMetadata(METHOD_METADATA, fn) === 1) {
        expect(Reflect.getMetadata(PATH_METADATA, fn)).not.toBe('/');
      }
    }
    expect(UsersController.prototype.findMe).toBeDefined();
    expect(UsersController.prototype.changePassword).toBeDefined();
    expect(
      Reflect.getMetadata(PATH_METADATA, AuthController.prototype.register),
    ).toBe('register');
  });

  it.each([
    { email: 'person@example.invalid', password: 'Test123' },
    { phone: '0123456789', password: 'Test123' },
  ])('accepts valid registration DTO %#', async (body) => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    await expect(
      pipe.transform(body, { type: 'body', metatype: RegisterDto }),
    ).resolves.toBeInstanceOf(RegisterDto);
  });
  it.each([
    { email: 'invalid', password: 'Test123' },
    { email: 'person@example.invalid' },
    { email: 'person@example.invalid', password: 'weak' },
    { password: 'Test123' },
    { phone: 'invalid', password: 'Test123' },
  ])('rejects invalid registration DTO %#', async (body) => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    await expect(
      pipe.transform(body, { type: 'body', metatype: RegisterDto }),
    ).rejects.toThrow();
  });
  it('register delegates unchanged to existing creation transaction', async () => {
    const users = { create: jest.fn(async () => ({ id: 'u' })) };
    const auth = new AuthService(users as any, jwt, prisma, mailer);
    const dto = { email: 'person@example.invalid', password: 'Test123' };
    await expect(auth.register(dto)).resolves.toEqual({ id: 'u' });
    expect(users.create).toHaveBeenCalledWith(dto);
  });

  it('registration still creates User, FREE subscription and quota in one transaction', async () => {
    prisma.plan = {
      findUnique: jest.fn(async () => ({
        id: 'free',
        isActive: true,
        durationDays: 7,
        characterLimit: 100,
        currency: 'VND',
      })),
    };
    prisma.user.create = jest.fn(async () => ({ id: 'u' }));
    prisma.subscription = { create: jest.fn(async () => ({ id: 'sub' })) };
    prisma.quotaLot = { create: jest.fn() };
    await new UsersService(prisma).create({
      email: 'PERSON@example.invalid',
      password: 'Test123',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.plan.findUnique).toHaveBeenCalledWith({
      where: { code: 'FREE' },
    });
    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'person@example.invalid',
          password: 'hashed',
        }),
      }),
    );
    expect(prisma.subscription.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ planId: 'free', characterLimit: 100 }),
      }),
    );
    expect(prisma.quotaLot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        charactersGranted: 100,
        charactersRemaining: 100,
      }),
    });
  });

  it('registration retains duplicate-account conflict handling', async () => {
    const users = {
      create: jest
        .fn()
        .mockRejectedValue({ code: 'P2002', meta: { target: ['email'] } }),
    };
    await expect(
      new AuthService(users as any, jwt, prisma, mailer).register({
        email: 'person@example.invalid',
        password: 'Test123',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('sends reset email, stores only hash, never returns raw token', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u' });
    const result = await service.forgotPassword('PERSON@example.invalid');
    const [recipient, token] = mailer.sendReset.mock.calls[0];
    expect(recipient).toBe('person@example.invalid');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(
      prisma.passwordResetToken.create.mock.calls[0][0].data.tokenHash,
    ).toBe(createHash('sha256').update(token).digest('hex'));
    expect(Object.keys(result)).toEqual(['message']);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('unknown email returns same response without sending email', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u' });
    const found = await service.forgotPassword('person@example.invalid');
    mailer.sendReset.mockClear();
    prisma.user.findUnique.mockResolvedValue(null);
    expect(await service.forgotPassword('missing@example.invalid')).toEqual(
      found,
    );
    expect(mailer.sendReset).not.toHaveBeenCalled();
  });
  it('SMTP failure has generic response and fixed log', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u' });
    mailer.sendReset.mockRejectedValue(new Error('SENSITIVE_SENTINEL'));
    await expect(
      service.forgotPassword('person@example.invalid'),
    ).resolves.toEqual({ message: expect.any(String) });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      'PASSWORD_RESET_MAIL_FAILED',
    );
  });
  it.each([
    null,
    { usedAt: new Date(), expiresAt: new Date(Date.now() + 10000) },
    { usedAt: null, expiresAt: new Date(0) },
  ])('rejects invalid/used/expired token %#', async (token) => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(token);
    await expect(service.resetPassword('mock', 'Test123')).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  const valid = () => ({
    id: 'r',
    userId: 'u',
    usedAt: null,
    expiresAt: new Date(Date.now() + 10000),
  });
  it('consumes token before password and version update in same transaction', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(valid());
    await service.resetPassword('mock', 'Test123');
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'r', usedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { usedAt: expect.any(Date) },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u' },
      data: { password: 'hashed', authVersion: { increment: 1 } },
    });
    expect(
      prisma.passwordResetToken.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(prisma.user.update.mock.invocationCallOrder[0]);
  });
  it('concurrent reset consumers: only one wins conditional claim', async () => {
    prisma.passwordResetToken.findUnique.mockImplementation(async () =>
      valid(),
    );
    let claimed = false;
    prisma.passwordResetToken.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    const results = await Promise.allSettled([
      service.resetPassword('mock', 'Test123'),
      service.resetPassword('mock', 'Test123'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });
  it('reset failure propagates to transaction for rollback', async () => {
    prisma.passwordResetToken.findUnique.mockResolvedValue(valid());
    prisma.user.update.mockRejectedValue(new Error('MOCK_TX_FAILED'));
    await expect(service.resetPassword('mock', 'Test123')).rejects.toThrow(
      'MOCK_TX_FAILED',
    );
    expect(prisma.passwordResetToken.deleteMany).not.toHaveBeenCalled();
  });
  it('password change atomically increments version and invalidates reset tokens', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u', password: 'old-hash' });
    // Mock regards this marker as the same password only for current-password check.
    const bcrypt = require('bcrypt');
    bcrypt.compare.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await new UsersService(prisma).changePassword('u', 'current', 'Test123');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u', password: 'old-hash' },
      data: { password: 'hashed', authVersion: { increment: 1 } },
    });
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u' },
    });
  });
  it('password change rejects concurrent replacement', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'u', password: 'old-hash' });
    require('bcrypt')
      .compare.mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      new UsersService(prisma).changePassword('u', 'current', 'Test123'),
    ).rejects.toThrow('PASSWORD_CHANGE_CONFLICT');
    expect(prisma.passwordResetToken.deleteMany).not.toHaveBeenCalled();
  });
  it('new login JWT includes authVersion', async () => {
    const users = {
      findByIdentifierWithPassword: jest.fn(async () => ({
        id: 'u',
        email: 'person@example.invalid',
        password: 'hashed',
        authVersion: 3,
      })),
    };
    await new AuthService(users as any, jwt, prisma, mailer).login({
      identifier: 'person@example.invalid',
      password: 'Test123',
    });
    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: 'u',
      email: 'person@example.invalid',
      authVersion: 3,
    });
  });
  it.each([undefined, -1, 0.5, '0', 2])(
    'rejects absent/malformed/stale JWT version %s',
    async (version) => {
      prisma.user.findUnique.mockResolvedValue({ id: 'u', authVersion: 3 });
      const strategy = new JwtStrategy(prisma, {
        get: () => 'mock-secret',
      } as any);
      await expect(
        strategy.validate({ sub: 'u', email: '', authVersion: version as any }),
      ).resolves.toBeNull();
    },
  );
  it('valid JWT uses current role from DB, missing user rejected', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u',
      email: null,
      role: 'USER',
      authVersion: 3,
    });
    const strategy = new JwtStrategy(prisma, {
      get: () => 'mock-secret',
    } as any);
    await expect(
      strategy.validate({ sub: 'u', email: '', authVersion: 3 }),
    ).resolves.toEqual({ userId: 'u', email: null, role: 'USER' });
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(
      strategy.validate({ sub: 'u', email: '', authVersion: 3 }),
    ).resolves.toBeNull();
  });

  it('exception filter logs no URL, raw exception or token', () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url: '/?token=SENSITIVE_SENTINEL' }),
        getResponse: () => response,
      }),
    };
    new HttpExceptionFilter().catch(
      new Error('SENSITIVE_SENTINEL'),
      host as any,
    );
    expect(log).toHaveBeenCalledWith('HTTP_REQUEST_FAILED status=500');
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      'SENSITIVE_SENTINEL',
    );
  });
  it('TTS provider no longer logs customer input', () => {
    const source = readFileSync(
      resolve(__dirname, '../tts/providers/openrouter-tts.provider.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/console\.(log|error|warn)/);
  });
});

describe('SMTP transport isolated mock', () => {
  const values: Record<string, string> = {
    PASSWORD_RESET_FRONTEND_URL: 'https://app.example.invalid/',
    SMTP_HOST: 'smtp.example.invalid',
    SMTP_PORT: '587',
    SMTP_USER: 'mock-user',
    SMTP_PASSWORD: 'mock-only',
    SMTP_FROM: 'support@example.invalid',
  };
  let transport: any;
  beforeEach(() => {
    transport = {
      sendMail: jest.fn(async () => ({ accepted: ['person@example.invalid'] })),
      close: jest.fn(),
    };
    (createTransport as jest.Mock).mockReturnValue(transport);
  });
  it('uses trusted URL, TLS, finite timeouts, no transport logging', async () => {
    await new PasswordResetMailer({
      get: (key) => values[key],
    } as ConfigService).sendReset('person@example.invalid', 'mock-token');
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTLS: true,
        logger: false,
        debug: false,
        connectionTimeout: 10000,
      }),
    );
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'https://app.example.invalid/?token=mock-token',
        ),
      }),
    );
    expect(transport.close).toHaveBeenCalled();
  });
  it.each([
    'http://app.example.invalid',
    'https://user:mock@app.example.invalid',
    'https://app.example.invalid/?redirect=x',
    '',
  ])('rejects untrusted URL %s before transport', async (url) => {
    (createTransport as jest.Mock).mockClear();
    await expect(
      new PasswordResetMailer({
        get: (key) =>
          key === 'PASSWORD_RESET_FRONTEND_URL' ? url : values[key],
      } as ConfigService).sendReset('person@example.invalid', 'mock'),
    ).rejects.toThrow();
    expect(createTransport).not.toHaveBeenCalled();
  });
  it('SMTP exception is replaced, transport always closed', async () => {
    transport.sendMail.mockRejectedValue(new Error('SENSITIVE_SENTINEL'));
    await expect(
      new PasswordResetMailer({
        get: (key) => values[key],
      } as ConfigService).sendReset('person@example.invalid', 'mock'),
    ).rejects.toThrow('RESET_MAIL_DELIVERY_FAILED');
    expect(transport.close).toHaveBeenCalled();
  });
  it('missing SMTP credential fails before creating transport', async () => {
    (createTransport as jest.Mock).mockClear();
    await expect(
      new PasswordResetMailer({
        get: (key) => (key === 'SMTP_PASSWORD' ? undefined : values[key]),
      } as ConfigService).sendReset('person@example.invalid', 'mock'),
    ).rejects.toThrow('RESET_MAIL_CONFIGURATION_INVALID');
    expect(createTransport).not.toHaveBeenCalled();
  });
  it('port 465 uses direct TLS and rejected recipients fail safely', async () => {
    transport.sendMail.mockResolvedValue({ accepted: [] });
    await expect(
      new PasswordResetMailer({
        get: (key) => (key === 'SMTP_PORT' ? '465' : values[key]),
      } as ConfigService).sendReset('person@example.invalid', 'mock'),
    ).rejects.toThrow('RESET_MAIL_DELIVERY_FAILED');
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true, port: 465 }),
    );
    expect(transport.close).toHaveBeenCalled();
  });
});

describe('Auth limiter (no HTTP server)', () => {
  const context = (
    action: string,
    ip = '127.0.0.1',
    body: any = { identifier: 'person@example.invalid' },
    forwarded = '',
  ) =>
    ({
      getHandler: () => ({ name: action }),
      switchToHttp: () => ({
        getRequest: () => ({
          socket: { remoteAddress: ip },
          body,
          headers: { 'x-forwarded-for': forwarded },
        }),
      }),
    }) as unknown as ExecutionContext;
  afterEach(() => jest.restoreAllMocks());
  it.each([
    ['login', 10, { identifier: 'person@example.invalid' }],
    ['register', 5, { email: 'person@example.invalid' }],
    ['forgotPassword', 3, { email: 'person@example.invalid' }],
  ])('limits %s by normalized identity across IPs', (action, limit, body) => {
    const guard = new AuthRateLimitGuard();
    for (let i = 0; i < Number(limit); i++)
      expect(guard.canActivate(context(String(action), `ip${i}`, body))).toBe(
        true,
      );
    expect(() =>
      guard.canActivate(context(String(action), 'other', body)),
    ).toThrow('AUTH_RATE_LIMIT_EXCEEDED');
  });
  it('limits shared IP even with distinct identities, ignores forwarded header', () => {
    const guard = new AuthRateLimitGuard();
    for (let i = 0; i < 20; i++)
      guard.canActivate(
        context(
          'forgotPassword',
          'same',
          { email: `p${i}@example.invalid` },
          `spoof${i}`,
        ),
      );
    expect(() =>
      guard.canActivate(
        context(
          'forgotPassword',
          'same',
          { email: 'new@example.invalid' },
          'new',
        ),
      ),
    ).toThrow();
  });
  it('expires buckets and never retains plaintext identities', () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const guard = new AuthRateLimitGuard();
    const ctx = context('forgotPassword', 'same', {
      email: 'PERSON@example.invalid ',
    });
    for (let i = 0; i < 3; i++) guard.canActivate(ctx);
    expect(() => guard.canActivate(ctx)).toThrow();
    expect(JSON.stringify([...(guard as any).buckets.keys()])).not.toContain(
      'example.invalid',
    );
    clock.mockReturnValue(1000 + 15 * 60000);
    expect(guard.canActivate(ctx)).toBe(true);
  });
  it('capacity is bounded, fails closed without eviction of live counters', () => {
    const guard = new AuthRateLimitGuard();
    (guard as any).capacity = 2;
    guard.canActivate(context('login'));
    expect(() =>
      guard.canActivate(
        context('login', 'other', { identifier: 'new@example.invalid' }),
      ),
    ).toThrow();
    expect((guard as any).buckets.size).toBe(2);
  });
  it.each(['synthesize', 'createPayment', 'resetPassword'])(
    'does not limit unrelated handler %s',
    (action) => {
      const guard = new AuthRateLimitGuard();
      for (let i = 0; i < 60; i++)
        expect(guard.canActivate(context(action))).toBe(true);
      expect((guard as any).buckets.size).toBe(0);
    },
  );
  it('guard is attached only to the three approved auth routes', () => {
    for (const name of ['login', 'register', 'forgotPassword'] as const) {
      expect(
        Reflect.getMetadata('__guards__', AuthController.prototype[name]),
      ).toContain(AuthRateLimitGuard);
    }
    expect(
      Reflect.getMetadata('__guards__', AuthController.prototype.resetPassword),
    ).toBeUndefined();
  });
});
