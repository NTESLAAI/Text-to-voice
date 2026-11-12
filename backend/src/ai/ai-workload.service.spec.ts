import { ConfigService } from '@nestjs/config';
import { AiWorkloadService } from './ai-workload.service';
import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AiWorkloadModule } from './ai-workload.module';

const make = (values: Record<string, string> = {}) =>
  new AiWorkloadService(new ConfigService(values));
describe('Single-instance AI admission budgets (no network)', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  it('two feature modules share one workload singleton', async () => {
    @Global()
    @Module({
      providers: [
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
      exports: [ConfigService],
    })
    class Settings {}
    @Injectable()
    class Left {
      constructor(readonly workload: AiWorkloadService) {}
    }
    @Injectable()
    class Right {
      constructor(readonly workload: AiWorkloadService) {}
    }
    @Module({ imports: [AiWorkloadModule], providers: [Left], exports: [Left] })
    class LeftFeature {}
    @Module({
      imports: [AiWorkloadModule],
      providers: [Right],
      exports: [Right],
    })
    class RightFeature {}
    const module = await Test.createTestingModule({
      imports: [Settings, LeftFeature, RightFeature],
    }).compile();
    expect(module.get(Left).workload).toBe(module.get(Right).workload);
    await module.close();
  });
  it('same account cannot start a second AI job, including another feature', async () => {
    const service = make();
    let finish!: () => void;
    const first = service.run(
      'u',
      10,
      1,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const other = jest.fn();
    await expect(service.run('u', 10, 1, other)).rejects.toThrow(
      'AI_CONCURRENCY_LIMIT_EXCEEDED',
    );
    expect(other).not.toHaveBeenCalled();
    finish();
    await first;
    await expect(
      service.run('u', 10, 1, () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });
  it('global concurrency is bounded across different accounts', async () => {
    const service = make({ AI_MAX_CONCURRENT: '1' });
    let finish!: () => void;
    const first = service.run(
      'u',
      1,
      1,
      () => new Promise<void>((r) => (finish = r)),
    );
    await expect(
      service.run('v', 1, 1, () => Promise.resolve()),
    ).rejects.toThrow('AI_CONCURRENCY_LIMIT_EXCEEDED');
    finish();
    await first;
  });
  it('rate limit expires after one minute', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const service = make({ AI_USER_REQUESTS_PER_MINUTE: '1' });
    await service.run('u', 1, 1, () => Promise.resolve());
    await expect(
      service.run('u', 1, 1, () => Promise.resolve()),
    ).rejects.toThrow('AI_RATE_LIMIT_EXCEEDED');
    clock.mockReturnValue(61000);
    await expect(
      service.run('u', 1, 1, () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });
  it('daily input budget reserves atomically and does not refund failures', async () => {
    const service = make({ AI_DAILY_INPUT_CHARACTERS: '5' });
    await expect(
      service.run('u', 4, 1, () => Promise.reject(new Error('MOCK_AI_FAILED'))),
    ).rejects.toThrow('MOCK_AI_FAILED');
    const job = jest.fn();
    await expect(service.run('v', 2, 1, job)).rejects.toThrow(
      'AI_DAILY_BUDGET_EXHAUSTED',
    );
    expect(job).not.toHaveBeenCalled();
    await expect(
      service.run('u', 1, 1, () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });
  it('dialogue reserves each physical turn, not just one HTTP request', async () => {
    const service = make({ AI_DAILY_PROVIDER_CALLS: '3' });
    await service.run('u', 3, 3, () => Promise.resolve());
    await expect(
      service.run('v', 1, 1, () => Promise.resolve()),
    ).rejects.toThrow('AI_DAILY_BUDGET_EXHAUSTED');
  });
  it('parallel admissions cannot overspend the shared provider-call budget', async () => {
    const service = make({
      AI_DAILY_PROVIDER_CALLS: '3',
      AI_MAX_CONCURRENT: '4',
    });
    const job = jest.fn(() => Promise.resolve());
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => service.run(`u${i}`, 1, 1, job)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(job).toHaveBeenCalledTimes(3);
  });
  it('rate-map capacity is bounded and fails closed without starting AI', async () => {
    const service = make();
    const state = service as unknown as {
      rates: Map<string, { count: number; until: number }>;
    };
    for (let i = 0; i < 10000; i++)
      state.rates.set(`u${i}`, { count: 1, until: Date.now() + 60000 });
    const job = jest.fn();
    await expect(service.run('new-user', 1, 1, job)).rejects.toThrow(
      'AI_RATE_LIMIT_EXCEEDED',
    );
    expect(job).not.toHaveBeenCalled();
    expect(state.rates.size).toBe(10000);
  });
  it('UTC daily budget rolls over only at new admission day', async () => {
    const clock = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-11-06T23:59:59Z'));
    const service = make({ AI_DAILY_PROVIDER_CALLS: '1' });
    await service.run('u', 1, 1, () => Promise.resolve());
    clock.mockReturnValue(Date.parse('2026-11-07T00:00:00Z'));
    await expect(
      service.run('v', 1, 1, () => Promise.resolve()),
    ).resolves.toBeUndefined();
  });
  it('timeout aborts the signal but does not release a still-running job', async () => {
    jest.useFakeTimers();
    const service = make({ AI_REQUEST_TIMEOUT_MS: '10' });
    let finish!: () => void;
    let observed: AbortSignal | undefined;
    const first = service.run('u', 1, 1, (signal) => {
      observed = signal;
      return new Promise<void>((r) => (finish = r));
    });
    jest.advanceTimersByTime(10);
    expect(observed?.aborted).toBe(true);
    await expect(
      service.run('u', 1, 1, () => Promise.resolve()),
    ).rejects.toThrow('AI_CONCURRENCY_LIMIT_EXCEEDED');
    finish();
    await first;
    expect(jest.getTimerCount()).toBe(0);
  });
  it('cooperative timeout fails and clears slot/timer without refunding budget', async () => {
    jest.useFakeTimers();
    const service = make({
      AI_REQUEST_TIMEOUT_MS: '10',
      AI_DAILY_PROVIDER_CALLS: '1',
    });
    const work = service.run(
      'u',
      1,
      1,
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new Error('MOCK_TIMEOUT')),
            { once: true },
          ),
        ),
    );
    const expected = expect(work).rejects.toThrow('MOCK_TIMEOUT');
    jest.advanceTimersByTime(10);
    await expected;
    expect(jest.getTimerCount()).toBe(0);
    await expect(
      service.run('u', 1, 1, () => Promise.resolve()),
    ).rejects.toThrow('AI_DAILY_BUDGET_EXHAUSTED');
  });
  it.each([0, -1, 10001, NaN])(
    'invalid raw character count %s never starts job',
    async (chars) => {
      const job = jest.fn();
      await expect(make().run('u', chars, 1, job)).rejects.toThrow(
        'AI_INPUT_LIMIT_EXCEEDED',
      );
      expect(job).not.toHaveBeenCalled();
    },
  );
  it.each(['0', '-1', 'NaN', '1000000000000'])(
    'invalid configuration %s fails closed',
    (value) => {
      expect(() => make({ AI_MAX_CONCURRENT: value })).toThrow(
        'AI_LIMIT_CONFIGURATION_INVALID',
      );
    },
  );
});
