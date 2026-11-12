import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { Request } from 'express';

const POLICIES = {
  login: { windowMs: 15 * 60_000, ip: 50, identity: 10 },
  register: { windowMs: 60 * 60_000, ip: 20, identity: 5 },
  forgotPassword: { windowMs: 15 * 60_000, ip: 20, identity: 3 },
} as const;

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly secret = randomBytes(32);
  private readonly buckets = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  private nextSweep = 0;
  private readonly capacity = 10000;

  canActivate(context: ExecutionContext): boolean {
    const action = context.getHandler().name as keyof typeof POLICIES;
    const policy = POLICIES[action];
    if (!policy) return true;
    const req = context.switchToHttp().getRequest<Request>();
    // Socket address deliberately ignores X-Forwarded-For and Express trust proxy.
    const ip = req.socket.remoteAddress ?? 'unavailable';
    const body = req.body as Record<string, unknown> | undefined;
    const values =
      action === 'register'
        ? [body?.email, body?.phone]
        : [action === 'login' ? body?.identifier : body?.email];
    const keys: Array<{ key: string; limit: number }> = [
      { key: `${action}:ip:${ip}`, limit: policy.ip },
    ];
    for (const value of values) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const hash = createHmac('sha256', this.secret)
        .update(value.trim().toLowerCase())
        .digest('hex');
      keys.push({ key: `${action}:identity:${hash}`, limit: policy.identity });
    }
    const now = Date.now();
    if (
      now >= this.nextSweep ||
      this.buckets.size + keys.length > this.capacity
    ) {
      for (const [key, bucket] of this.buckets) {
        if (bucket.expiresAt <= now) this.buckets.delete(key);
      }
      this.nextSweep = now + 60_000;
    }
    let blocked = false;
    for (const { key, limit } of keys) {
      const previous = this.buckets.get(key);
      const bucket =
        previous && previous.expiresAt > now
          ? previous
          : { count: 0, expiresAt: now + policy.windowMs };
      if (!previous && this.buckets.size >= this.capacity) {
        blocked = true;
        continue;
      }
      bucket.count = Math.min(bucket.count + 1, limit + 1);
      this.buckets.set(key, bucket);
      if (bucket.count > limit) blocked = true;
    }
    if (blocked) throw new HttpException('AUTH_RATE_LIMIT_EXCEEDED', 429);
    return true;
  }
}
