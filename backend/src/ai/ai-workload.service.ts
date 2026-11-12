import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AiWorkloadService {
  private active = 0;
  private readonly users = new Set<string>();
  private readonly rates = new Map<string, { count: number; until: number }>();
  private nextSweep = 0;
  private day = '';
  private characters = 0;
  private calls = 0;
  readonly timeoutMs: number;
  readonly reviewOutputTokens: number;
  private readonly maxActive: number;
  private readonly perMinute: number;
  private readonly dailyCharacters: number;
  private readonly dailyCalls: number;

  constructor(config: ConfigService) {
    const integer = (key: string, fallback: number, max: number) => {
      const value = Number(config.get<string>(key) ?? fallback);
      if (!Number.isSafeInteger(value) || value < 1 || value > max)
        throw new Error('AI_LIMIT_CONFIGURATION_INVALID');
      return value;
    };
    this.maxActive = integer('AI_MAX_CONCURRENT', 4, 64);
    this.perMinute = integer('AI_USER_REQUESTS_PER_MINUTE', 10, 100);
    this.dailyCharacters = integer(
      'AI_DAILY_INPUT_CHARACTERS',
      1000000,
      1000000000,
    );
    this.dailyCalls = integer('AI_DAILY_PROVIDER_CALLS', 1000, 1000000);
    this.timeoutMs = integer('AI_REQUEST_TIMEOUT_MS', 120000, 300000);
    this.reviewOutputTokens = integer(
      'AI_REVIEW_MAX_OUTPUT_TOKENS',
      4096,
      16384,
    );
  }

  async run<T>(
    userId: string,
    characters: number,
    providerCalls: number,
    job: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (
      !userId ||
      !Number.isSafeInteger(characters) ||
      characters < 1 ||
      characters > 10000 ||
      !Number.isSafeInteger(providerCalls) ||
      providerCalls < 1 ||
      providerCalls > 50
    ) {
      throw new BadRequestException('AI_INPUT_LIMIT_EXCEEDED');
    }
    if (this.users.has(userId) || this.active >= this.maxActive)
      throw new HttpException('AI_CONCURRENCY_LIMIT_EXCEEDED', 429);
    const now = Date.now();
    if (now >= this.nextSweep || this.rates.size >= 10000) {
      for (const [key, value] of this.rates)
        if (value.until <= now) this.rates.delete(key);
      this.nextSweep = now + 60000;
    }
    const previous = this.rates.get(userId);
    const rate =
      previous && previous.until > now
        ? previous
        : { count: 0, until: now + 60000 };
    if (
      rate.count >= this.perMinute ||
      (!this.rates.has(userId) && this.rates.size >= 10000)
    )
      throw new HttpException('AI_RATE_LIMIT_EXCEEDED', 429);
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.day !== day) {
      this.day = day;
      this.characters = 0;
      this.calls = 0;
    }
    if (
      this.characters + characters > this.dailyCharacters ||
      this.calls + providerCalls > this.dailyCalls
    )
      throw new ServiceUnavailableException('AI_DAILY_BUDGET_EXHAUSTED');
    // Reserve synchronously before any await. Errors/timeouts never refund admission budgets.
    this.characters += characters;
    this.calls += providerCalls;
    rate.count++;
    this.rates.set(userId, rate);
    this.active++;
    this.users.add(userId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // No Promise.race release: a slot stays occupied until the actual job settles.
      return await job(controller.signal);
    } finally {
      clearTimeout(timer);
      this.active--;
      this.users.delete(userId);
    }
  }
}
