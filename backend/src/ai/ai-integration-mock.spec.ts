/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/require-await */
// Provider, Prisma and file operations are entirely mocked; no real AI/DB/files.
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { OpenRouter } from '@openrouter/sdk';
import { promises as fs } from 'fs';
import { AiWorkloadService } from './ai-workload.service';
import { TtsService } from '../tts/tts.service';
import { OpenRouterTtsProvider } from '../tts/providers/openrouter-tts.provider';
import { TextReviewService } from '../text-review/text-review.service';
import { ReviewTextDto } from '../text-review/text-review.controller';

jest.mock('@openrouter/sdk', () => ({ OpenRouter: jest.fn() }));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  promises: { mkdir: jest.fn(), writeFile: jest.fn(), unlink: jest.fn() },
}));

describe('AI boundaries and quota preservation (mock)', () => {
  let speech: jest.Mock, chat: jest.Mock, workload: AiWorkloadService;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENROUTER_API_KEY = 'mock-only-key';
    speech = jest.fn();
    chat = jest.fn();
    (OpenRouter as jest.Mock).mockImplementation(() => ({
      tts: { createSpeech: speech },
      chat: { send: chat },
    }));
    workload = new AiWorkloadService(new ConfigService());
  });
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    jest.restoreAllMocks();
  });
  const request: any = {
    projectId: 'p',
    text: 'mock text',
    language: 'vi',
    character: 'adult_male',
    tone: 'neutral',
    emotion: 'natural',
    style: 'conversation',
    region: 'north_vietnam',
    speed: 1,
  };
  const db = () => ({
    project: { findFirst: jest.fn(async () => ({ userId: 'u' })) },
    subscription: { findFirst: jest.fn() },
    quotaLot: { findMany: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  });
  it('provider failure cannot write audio, Usage or deduct quota', async () => {
    const prisma = db();
    const provider: any = {
      synthesize: jest.fn().mockRejectedValue(new Error('MOCK_AI_FAILED')),
    };
    await expect(
      new TtsService(prisma as any, {} as any, provider, workload).synthesize(
        request,
        'u',
        'ADMIN',
      ),
    ).rejects.toThrow('MOCK_AI_FAILED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.quotaLot.update).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
  it('ordinary insufficient quota is rejected before sending AI', async () => {
    const prisma = db();
    prisma.subscription.findFirst.mockResolvedValue(null);
    const provider: any = { synthesize: jest.fn() };
    await expect(
      new TtsService(prisma as any, {} as any, provider, workload).synthesize(
        request,
        'u',
      ),
    ).rejects.toThrow();
    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('parallel TTS requests from same account start at most one provider call', async () => {
    let reject!: (e: Error) => void;
    const provider: any = {
      synthesize: jest.fn(() => new Promise((_, r) => (reject = r))),
    };
    const service = new TtsService(db() as any, {} as any, provider, workload);
    const first = service.synthesize(request, 'u', 'ADMIN');
    await Promise.resolve();
    await expect(service.synthesize(request, 'u', 'ADMIN')).rejects.toThrow(
      'AI_CONCURRENCY_LIMIT_EXCEEDED',
    );
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
    reject(new Error('MOCK_FINISH'));
    await expect(first).rejects.toThrow('MOCK_FINISH');
  });
  it('too-long TTS never calls the provider', async () => {
    const provider: any = { synthesize: jest.fn() };
    await expect(
      new TtsService(db() as any, {} as any, provider, workload).synthesize(
        { ...request, text: 'a'.repeat(5001) },
        'u',
      ),
    ).rejects.toThrow('AI_INPUT_LIMIT_EXCEEDED');
    expect(provider.synthesize).not.toHaveBeenCalled();
  });
  it('aborted synthesis returns no audio and performs no quota transaction', async () => {
    const prisma = db();
    const provider: any = {
      synthesize: jest.fn(async (_request, signal: AbortSignal) => {
        signal.throwIfAborted();
        return Buffer.alloc(2);
      }),
    };
    const aborted = new AbortController();
    aborted.abort();
    const fake: any = {
      run: (_user, _chars, _calls, fn) => fn(aborted.signal),
    };
    await expect(
      new TtsService(prisma as any, {} as any, provider, fake).synthesize(
        request,
        'u',
        'ADMIN',
      ),
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
  it.each(['', 'a'.repeat(5001)])(
    'invalid review input is rejected before AI',
    async (text) => {
      await expect(
        new TextReviewService({} as any, workload).reviewText(text, 'u'),
      ).rejects.toThrow('AI_INPUT_LIMIT_EXCEEDED');
      expect(chat).not.toHaveBeenCalled();
    },
  );
  it('review DTO has runtime validation', async () => {
    await expect(
      new ValidationPipe().transform(
        { text: 'a'.repeat(5001) },
        { type: 'body', metatype: ReviewTextDto },
      ),
    ).rejects.toThrow();
  });
  it('review has output cap, abort signal, no automatic retry and records AiUsage', async () => {
    chat.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              hasErrors: false,
              errors: [],
              correctedText: 'mock text',
              suggestion: '',
            }),
          },
        },
      ],
      usage: { totalTokens: 10, cost: 0.001 },
    });
    const prisma: any = {
      subscription: { findFirst: jest.fn(async () => null) },
      aiUsage: { create: jest.fn() },
    };
    await expect(
      new TextReviewService(prisma, workload).reviewText('mock text', 'u'),
    ).resolves.toMatchObject({ correctedText: 'mock text' });
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        chatRequest: expect.objectContaining({ maxCompletionTokens: 4096 }),
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        retries: { strategy: 'none' },
      }),
    );
    expect(prisma.aiUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        costUsd: 0.001,
        totalTokens: 10,
        feature: 'TEXT_REVIEW',
      }),
    });
  });
  it('review SDK failure does not create fake usage/quota records', async () => {
    chat.mockRejectedValue(new Error('MOCK_SDK_FAILED'));
    const prisma: any = { aiUsage: { create: jest.fn() } };
    await expect(
      new TextReviewService(prisma, workload).reviewText('mock text', 'u'),
    ).rejects.toThrow('AI_PROVIDER_FAILED');
    expect(prisma.aiUsage.create).not.toHaveBeenCalled();
  });
  it('usage storage failure emits fixed diagnostic only', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    chat.mockResolvedValue({ choices: [], usage: { cost: 0.001 } });
    const prisma: any = {
      subscription: {
        findFirst: jest.fn().mockRejectedValue(new Error('SENSITIVE_SENTINEL')),
      },
    };
    await new TextReviewService(prisma, workload).reviewText('mock', 'u');
    expect(warn).toHaveBeenCalledWith('AI_USAGE_RECORD_FAILED');
  });
  it('unknown cost is never reported as a free AI call', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    chat.mockResolvedValue({ choices: [], usage: { totalTokens: 10 } });
    const prisma: any = { aiUsage: { create: jest.fn() } };
    await new TextReviewService(prisma, workload).reviewText('mock', 'u');
    expect(prisma.aiUsage.create).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('AI_USAGE_COST_UNKNOWN');
  });
  it('speech SDK failure is replaced by a fixed safe diagnostic', async () => {
    speech.mockRejectedValue(new Error('SENSITIVE_SENTINEL'));
    await expect(
      new OpenRouterTtsProvider({
        createDirection: () => null,
      } as any).synthesize(request),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ message: 'AI_PROVIDER_FAILED' }),
    });
  });
  it('speech uses unchanged model/voice and abortable no-retry stream', async () => {
    const reader = {
      read: jest
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
        .mockResolvedValueOnce({ done: true }),
      releaseLock: jest.fn(),
      cancel: jest.fn(async () => undefined),
    };
    speech.mockResolvedValue({ getReader: () => reader });
    const provider = new OpenRouterTtsProvider({
      createDirection: () => null,
    } as any);
    await expect(provider.synthesize(request)).resolves.toEqual(
      Buffer.from([1, 2]),
    );
    expect(speech).toHaveBeenCalledWith(
      expect.objectContaining({
        speechRequest: expect.objectContaining({
          model: 'google/gemini-3.1-flash-tts-preview',
          voice: 'Charon',
          responseFormat: 'pcm',
        }),
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        retries: { strategy: 'none' },
      }),
    );
    expect(reader.releaseLock).toHaveBeenCalled();
  });
  it('stream timeout cancels reader, fails, and never returns partial audio', async () => {
    let complete!: (value: { done: boolean }) => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => (start = resolve));
    const reader = {
      read: jest.fn(() => {
        start();
        return new Promise((r) => (complete = r));
      }),
      cancel: jest.fn(async () => {
        complete({ done: true });
      }),
      releaseLock: jest.fn(),
    };
    speech.mockResolvedValue({ getReader: () => reader });
    const controller = new AbortController();
    const pending = new OpenRouterTtsProvider({
      createDirection: () => null,
    } as any).synthesize(request, controller.signal);
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalled();
  });
  it('abort between response arrival and stream listener still cancels the body', async () => {
    const controller = new AbortController();
    const reader = {
      read: jest.fn(),
      cancel: jest.fn(() => Promise.resolve()),
      releaseLock: jest.fn(),
    };
    speech.mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ getReader: () => reader });
    });
    await expect(
      new OpenRouterTtsProvider({
        createDirection: () => null,
      } as any).synthesize(request, controller.signal),
    ).rejects.toMatchObject({ status: 504 });
    expect(reader.read).not.toHaveBeenCalled();
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalled();
  });
});
