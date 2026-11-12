/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// Fake certificates, credentials, HTTP responses and transaction state only.
import { StoreBillingService } from './store-billing.service';
import { AppleStoreService } from './apple-store.service';
import { GoogleStoreService } from './google-store.service';
import { StoreSettings } from './store-settings.service';
import {
  AppStoreServerAPIClient,
  SignedDataVerifier,
  Environment,
} from '@apple/app-store-server-library';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../payment/payment.service';
jest.mock('@apple/app-store-server-library', () => ({
  AppStoreServerAPIClient: jest.fn(),
  SignedDataVerifier: jest.fn(),
  Environment: { PRODUCTION: 'Production', SANDBOX: 'Sandbox' },
}));
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn(),
  OAuth2Client: jest.fn(),
}));
const user = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const mapping = [
  { platform: 'APPLE', productId: 'mock.apple', planCode: 'BASIC' },
  {
    platform: 'GOOGLE',
    productId: 'mock.google',
    basePlanId: 'mock-monthly',
    planCode: 'BASIC',
  },
];
const settings = () =>
  new StoreSettings(
    new ConfigService({
      STORE_PRODUCT_MAPPING: JSON.stringify(mapping),
      STORE_REFERENCE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 1).toString(
        'base64',
      ),
    }),
  );
const verified = (overrides: any = {}) => ({
  platform: 'APPLE',
  reference: '100',
  chainId: '100',
  cycleId: '100',
  productId: 'mock.apple',
  accountBinding: user,
  environment: 'Sandbox',
  state: 'ACTIVE',
  expiresAt: new Date(Date.now() + 86400000),
  startedAt: new Date(Date.now() - 1000),
  initialCycle: true,
  acknowledged: false,
  autoRenew: true,
  ...overrides,
});

describe('Store ledger and delivery transaction (mock only)', () => {
  let tx: any,
    db: any,
    apple: any,
    google: any,
    service: StoreBillingService,
    cycle: any,
    purchase: any;
  let events: string[];
  beforeEach(() => {
    cycle = undefined;
    purchase = undefined;
    events = [];
    tx = {
      $queryRaw: jest.fn(),
      plan: {
        findUnique: jest.fn(async () => ({
          id: 'plan',
          code: 'BASIC',
          isActive: true,
          characterLimit: 173,
          currency: 'VND',
        })),
      },
      storePurchase: {
        findUnique: jest.fn(async () => purchase),
        create: jest.fn(
          async ({ data }) => (purchase = { ...data, id: 'purchase' }),
        ),
      },
      storeCycle: {
        findUnique: jest.fn(async () => cycle),
        findFirst: jest.fn(async () => null),
        upsert: jest.fn(
          async ({ create, update }) =>
            (cycle = cycle
              ? { ...cycle, ...update }
              : {
                  ...create,
                  id: 'cycle',
                  deliveryStatus: 'REVIEW_REQUIRED',
                  subscriptionId: null,
                }),
        ),
        update: jest.fn(async ({ data }) => (cycle = { ...cycle, ...data })),
      },
      subscription: {
        count: jest.fn(async () => 0),
        findFirst: jest.fn(async () => null),
        update: jest.fn(),
        create: jest.fn(async ({ data }) => ({ ...data, id: 'sub' })),
        updateMany: jest.fn(),
      },
      quotaLot: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    };
    db = {
      ...tx,
      $transaction: jest.fn(async (fn) => {
        const result = await fn(tx);
        events.push('COMMIT');
        return result;
      }),
    };
    apple = {
      verify: jest.fn(async () => verified()),
      notification: jest.fn(async () => verified()),
    };
    google = {
      verify: jest.fn(),
      notification: jest.fn(),
      acknowledge: jest.fn(async () => events.push('ACK')),
    };
    service = new StoreBillingService(db, settings(), apple, google);
  });
  it('catalog never enables purchases before release checks are complete', async () => {
    expect(await service.catalog(user, 'APPLE')).toMatchObject({
      purchaseEnabled: false,
      accountBinding: user,
    });
  });
  it('first verified Apple cycle uses store dates and Plan quota, exactly once', async () => {
    const v = verified();
    apple.verify.mockResolvedValue(v);
    await expect(service.verify(user, 'APPLE', '100')).resolves.toMatchObject({
      deliveryStatus: 'GRANTED',
      state: 'ACTIVE',
    });
    expect(tx.subscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        billingSource: 'APPLE',
        startedAt: v.startedAt,
        expiresAt: v.expiresAt,
        characterLimit: 173,
      }),
    });
    await service.verify(user, 'APPLE', '100');
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][0].join(' ')).toContain('FOR UPDATE');
  });
  it('expired FREE may be replaced without FREE rollover', async () => {
    tx.subscription.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'free-expired' });
    await service.verify(user, 'APPLE', '100');
    expect(tx.subscription.update).toHaveBeenCalledWith({
      where: { id: 'free-expired' },
      data: { status: 'EXPIRED' },
    });
    expect(tx.quotaLot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        charactersRemaining: 173,
        rolloverCount: 0,
      }),
    });
  });
  it('first Google cycle is acknowledged only after committed grant', async () => {
    google.verify.mockResolvedValue(
      verified({
        platform: 'GOOGLE',
        productId: 'mock.google',
        basePlanId: 'mock-monthly',
        accountBinding: service.binding(user, 'GOOGLE'),
        reference: 'mock-token',
      }),
    );
    await service.verify(user, 'GOOGLE', 'mock-token');
    expect(events).toEqual(['COMMIT', 'ACK']);
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
  });
  it('unproven Google initial cycle remains review and is not acknowledged', async () => {
    google.verify.mockResolvedValue(
      verified({
        platform: 'GOOGLE',
        productId: 'mock.google',
        basePlanId: 'mock-monthly',
        accountBinding: service.binding(user, 'GOOGLE'),
        initialCycle: false,
      }),
    );
    await expect(service.verify(user, 'GOOGLE', 'mock')).resolves.toMatchObject(
      { deliveryStatus: 'REVIEW_REQUIRED' },
    );
    expect(google.acknowledge).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
  });
  it('cross-platform paid history requires review and never replaces benefits', async () => {
    tx.subscription.findFirst.mockResolvedValue({ id: 'web-paid' });
    await expect(service.verify(user, 'APPLE', '100')).resolves.toMatchObject({
      reviewRequired: true,
    });
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
    expect(cycle.deliveryStatus).toBe('REVIEW_REQUIRED');
    expect(cycle.subscriptionId).toBeNull();
  });
  it.each(['APPLE', 'GOOGLE'])(
    '%s charged initial purchase is retained for review when any paid entitlement exists',
    async (platform) => {
      const v = verified({
        platform,
        productId: platform === 'APPLE' ? 'mock.apple' : 'mock.google',
        basePlanId: platform === 'GOOGLE' ? 'mock-monthly' : undefined,
        accountBinding: service.binding(user, platform as 'APPLE' | 'GOOGLE'),
      });
      if (platform === 'APPLE') apple.verify.mockResolvedValue(v);
      else google.verify.mockResolvedValue(v);
      tx.subscription.findFirst.mockResolvedValue({ id: 'existing-paid' });
      await expect(
        service.verify(user, platform as 'APPLE' | 'GOOGLE', '100'),
      ).resolves.toMatchObject({ deliveryStatus: 'REVIEW_REQUIRED' });
      expect(tx.storeCycle.upsert).toHaveBeenCalled();
      expect(tx.subscription.create).not.toHaveBeenCalled();
      expect(tx.quotaLot.create).not.toHaveBeenCalled();
      expect(google.acknowledge).not.toHaveBeenCalled();
    },
  );
  it.each(['WEB', 'APPLE', 'GOOGLE'])(
    'catalog blocks a new purchase while %s is active',
    async (billingSource) => {
      tx.subscription.findFirst.mockResolvedValue({
        id: 'active-paid',
        billingSource,
      });
      await expect(service.catalog(user, 'GOOGLE')).resolves.toMatchObject({
        purchaseEnabled: false,
        eligibleForNewPurchase: false,
        reason: 'ACTIVE_PAID_SUBSCRIPTION_EXISTS',
      });
      expect(tx.subscription.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ACTIVE',
            expiresAt: { gt: expect.any(Date) },
            plan: { code: { not: 'FREE' } },
          }),
        }),
      );
    },
  );
  it('expired paid history does not prevent a verified new initial cycle', async () => {
    // The database predicate excludes historical rows, regardless of platform.
    await service.verify(user, 'APPLE', '100');
    expect(tx.subscription.findFirst.mock.calls[0][0].where).toMatchObject({
      status: 'ACTIVE',
      expiresAt: { gt: expect.any(Date) },
      plan: { code: { not: 'FREE' } },
    });
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
  });
  it('a verified pending initial cycle can become paid, without duplicate delivery', async () => {
    const v = verified({ state: 'PENDING' });
    apple.verify.mockResolvedValue(v);
    await service.verify(user, 'APPLE', '100');
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
    v.state = 'ACTIVE';
    await service.verify(user, 'APPLE', '100');
    await service.verify(user, 'APPLE', '100');
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
  });
  function renewalFixture(platform = 'APPLE') {
    const boundary = new Date(Date.now() - 1000);
    purchase = { id: 'purchase', userId: user };
    const previous = {
      id: 'previous',
      purchaseId: purchase.id,
      deliveryStatus: 'GRANTED',
      productId: platform === 'APPLE' ? 'mock.apple' : 'mock.google',
      planId: 'plan',
      environment: 'Sandbox',
      state: 'EXPIRED',
      expiresAt: boundary,
      refundReview: false,
      subscription: {
        id: 'previous-sub',
        userId: user,
        billingSource: platform,
        planId: 'plan',
        quotaLots: [] as any[],
      },
    };
    tx.storeCycle.findFirst.mockResolvedValue(previous);
    const v = verified({
      platform,
      productId: previous.productId,
      basePlanId: platform === 'GOOGLE' ? 'mock-monthly' : undefined,
      accountBinding: service.binding(user, platform as 'APPLE' | 'GOOGLE'),
      cycleId: '101',
      reference: '101',
      startedAt: boundary,
      initialCycle: false,
      renewalEligible: true,
    });
    if (platform === 'APPLE') apple.verify.mockResolvedValue(v);
    else google.verify.mockResolvedValue(v);
    return { previous, v };
  }
  it.each(['APPLE', 'GOOGLE'])(
    '%s renewal grants one verified cycle, including duplicate notification/restore',
    async (platform) => {
      const { v } = renewalFixture(platform);
      await service.verify(user, platform as 'APPLE' | 'GOOGLE', '101');
      await service.verify(user, platform as 'APPLE' | 'GOOGLE', '101');
      expect(tx.subscription.create).toHaveBeenCalledTimes(1);
      expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
      expect(tx.subscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          billingSource: platform,
          startedAt: v.startedAt,
          expiresAt: v.expiresAt,
          characterLimit: 173,
        }),
      });
    },
  );
  it('renewal preserves the existing one-time rollover policy', async () => {
    const { previous } = renewalFixture();
    previous.subscription.quotaLots = [
      {
        id: 'eligible',
        charactersRemaining: 23,
        rolloverCount: 0,
        expiresAt: previous.expiresAt,
      },
      {
        id: 'already-carried',
        charactersRemaining: 91,
        rolloverCount: 1,
        expiresAt: previous.expiresAt,
      },
      {
        id: 'empty',
        charactersRemaining: 0,
        rolloverCount: 0,
        expiresAt: previous.expiresAt,
      },
    ];
    await service.verify(user, 'APPLE', '101');
    await service.verify(user, 'APPLE', '101');
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(2);
    expect(tx.quotaLot.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceLotId: 'eligible',
        charactersRemaining: 23,
        rolloverCount: 1,
      }),
    });
    expect(tx.quotaLot.update).toHaveBeenCalledTimes(1);
  });
  it('late renewal grants the current cycle but does not roll quota after 24h', async () => {
    const { previous, v } = renewalFixture();
    previous.expiresAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    v.startedAt = previous.expiresAt;
    previous.subscription.quotaLots = [
      {
        id: 'late',
        charactersRemaining: 23,
        rolloverCount: 0,
        expiresAt: previous.expiresAt,
      },
    ];
    await service.verify(user, 'APPLE', '101');
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
    expect(tx.quotaLot.update).not.toHaveBeenCalled();
  });
  it.each([
    'different-product',
    'different-plan',
    'different-period',
    'different-environment',
    'unproven-renewal',
    'revoked',
    'refund',
  ])('renewal %s is recorded but not granted', async (reason) => {
    const { previous, v } = renewalFixture();
    if (reason === 'different-product') previous.productId = 'other-product';
    if (reason === 'different-plan') previous.planId = 'other-plan';
    if (reason === 'different-period') previous.expiresAt = new Date(0);
    if (reason === 'different-environment') previous.environment = 'Production';
    if (reason === 'unproven-renewal') v.renewalEligible = false;
    if (reason === 'revoked') previous.state = 'REVOKED';
    if (reason === 'refund') previous.refundReview = true;
    await expect(service.verify(user, 'APPLE', '101')).resolves.toMatchObject({
      deliveryStatus: 'REVIEW_REQUIRED',
    });
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
    expect(cycle).toBeDefined();
  });
  it('charged renewal conflicting with another active subscription stays review, even on replay', async () => {
    renewalFixture();
    tx.subscription.findFirst.mockResolvedValue({ id: 'web-paid' });
    await service.verify(user, 'APPLE', '101');
    tx.subscription.findFirst.mockResolvedValue(null);
    await expect(service.verify(user, 'APPLE', '101')).resolves.toMatchObject({
      deliveryStatus: 'REVIEW_REQUIRED',
    });
    expect(tx.subscription.create).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
  });
  it('notification and client restore of the same renewal share one ledger gate', async () => {
    const { v } = renewalFixture();
    apple.notification.mockResolvedValue(v);
    await service.notification('APPLE', 'mock-notification');
    await service.verify(user, 'APPLE', '101');
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
  });
  it('two worker instances under a simulated User lock deliver only one competing purchase', async () => {
    // Models transaction serialization only; it does not prove PostgreSQL locks.
    let tail = Promise.resolve();
    db.$transaction.mockImplementation((fn) => {
      const next = tail.then(() => fn(tx));
      tail = next.then(() => undefined);
      return next;
    });
    const cycles = new Map<string, any>();
    let active: any = null;
    tx.storeCycle.findUnique.mockImplementation(async ({ where }) =>
      cycles.get(where.platform_cycleKey.cycleKey),
    );
    tx.storeCycle.upsert.mockImplementation(async ({ create }) => {
      const row = {
        ...create,
        id: create.cycleKey,
        subscriptionId: null,
        deliveryStatus: 'REVIEW_REQUIRED',
      };
      cycles.set(create.cycleKey, row);
      return row;
    });
    tx.storeCycle.update.mockImplementation(async ({ where, data }) => {
      const row = { ...cycles.get(where.id), ...data };
      cycles.set(where.id, row);
      return row;
    });
    tx.subscription.findFirst.mockImplementation(async ({ where }) =>
      where.plan.code.not ? active : null,
    );
    tx.subscription.create.mockImplementation(
      async ({ data }) => (active = { ...data, id: 'only-sub' }),
    );
    apple.verify.mockImplementation(async (ref) =>
      verified({ cycleId: ref, chainId: ref }),
    );
    const worker = new StoreBillingService(db, settings(), apple, google);
    const result = await Promise.all([
      service.verify(user, 'APPLE', '100'),
      worker.verify(user, 'APPLE', '101'),
    ]);
    expect(result.map((r) => r.deliveryStatus)).toEqual([
      'GRANTED',
      'REVIEW_REQUIRED',
    ]);
    expect(tx.subscription.create).toHaveBeenCalledTimes(1);
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
    expect(cycles.size).toBe(2);
  });
  it('new renewal cycle remains review; never grants quota automatically', async () => {
    apple.verify.mockResolvedValue(
      verified({ cycleId: '101', reference: '101', initialCycle: false }),
    );
    await expect(service.verify(user, 'APPLE', '101')).resolves.toMatchObject({
      reviewRequired: true,
    });
    expect(tx.quotaLot.create).not.toHaveBeenCalled();
  });
  it('receipt from another account is refused before transaction', async () => {
    await expect(service.verify(other, 'APPLE', '100')).rejects.toThrow(
      'STORE_ACCOUNT_BINDING_MISMATCH',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('chain ownership cannot be reassigned even with conflicting provider binding', async () => {
    purchase = { id: 'purchase', userId: other };
    await expect(service.verify(user, 'APPLE', '100')).rejects.toThrow(
      'STORE_PURCHASE_ALREADY_BOUND',
    );
    expect(tx.subscription.create).not.toHaveBeenCalled();
  });
  it('unmapped product does not touch database', async () => {
    apple.verify.mockResolvedValue(verified({ productId: 'not-configured' }));
    await expect(service.verify(user, 'APPLE', '100')).rejects.toThrow(
      'STORE_PRODUCT_NOT_CONFIGURED',
    );
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('cancel keeps current-cycle access until expiration; no extra quota', async () => {
    await service.verify(user, 'APPLE', '100');
    apple.verify.mockResolvedValue(
      verified({ state: 'CANCELED', autoRenew: false }),
    );
    await service.verify(user, 'APPLE', '100');
    expect(tx.subscription.updateMany).not.toHaveBeenCalled();
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
  });
  it.each(['EXPIRED', 'REVOKED', 'ON_HOLD'])(
    '%s affects only linked store entitlement',
    async (state) => {
      await service.verify(user, 'APPLE', '100');
      apple.verify.mockResolvedValue(verified({ state }));
      await service.verify(user, 'APPLE', '100');
      expect(tx.subscription.updateMany).toHaveBeenCalledWith({
        where: { id: 'sub', userId: user, billingSource: 'APPLE' },
        data: { status: 'EXPIRED' },
      });
      expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
    },
  );
  it('older observation does not overwrite a newer state', async () => {
    await service.verify(user, 'APPLE', '100');
    cycle.observedAt = new Date(Date.now() + 100000);
    tx.storeCycle.upsert.mockClear();
    apple.verify.mockResolvedValue(verified({ state: 'ACTIVE' }));
    await service.verify(user, 'APPLE', '100');
    expect(tx.storeCycle.upsert).not.toHaveBeenCalled();
  });
  it('provider failure grants nothing and raw reference is never returned/stored', async () => {
    const v = verified({ reference: 'SENSITIVE_SENTINEL' });
    apple.verify.mockResolvedValue(v);
    const result = await service.verify(user, 'APPLE', '100');
    expect(JSON.stringify(result)).not.toContain('SENSITIVE_SENTINEL');
    expect(purchase.referenceCipher).not.toContain('SENSITIVE_SENTINEL');
    apple.verify.mockRejectedValue(new Error('MOCK_INVALID_SIGNATURE'));
    await expect(service.verify(user, 'APPLE', '100')).rejects.toThrow(
      'MOCK_INVALID_SIGNATURE',
    );
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
  });
  it('transaction failure never acknowledges undelivered Google purchase', async () => {
    google.verify.mockResolvedValue(
      verified({
        platform: 'GOOGLE',
        productId: 'mock.google',
        basePlanId: 'mock-monthly',
        accountBinding: service.binding(user, 'GOOGLE'),
      }),
    );
    tx.quotaLot.create.mockRejectedValue(new Error('MOCK_TX_FAILED'));
    await expect(service.verify(user, 'GOOGLE', 'mock')).rejects.toThrow(
      'MOCK_TX_FAILED',
    );
    expect(google.acknowledge).not.toHaveBeenCalled();
  });
  it('acknowledgement failure after commit retries without granting a second quota lot', async () => {
    google.verify.mockResolvedValue(
      verified({
        platform: 'GOOGLE',
        productId: 'mock.google',
        basePlanId: 'mock-monthly',
        accountBinding: service.binding(user, 'GOOGLE'),
      }),
    );
    google.acknowledge.mockRejectedValueOnce(new Error('MOCK_ACK_FAILED'));
    await expect(service.verify(user, 'GOOGLE', 'mock')).rejects.toThrow(
      'MOCK_ACK_FAILED',
    );
    await service.verify(user, 'GOOGLE', 'mock');
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
    expect(google.acknowledge).toHaveBeenCalledTimes(2);
  });
  it('a revoked cycle cannot be restored by a later stale active response', async () => {
    await service.verify(user, 'APPLE', '100');
    apple.verify.mockResolvedValue(verified({ state: 'REVOKED' }));
    await service.verify(user, 'APPLE', '100');
    apple.verify.mockResolvedValue(verified({ state: 'ACTIVE' }));
    await expect(service.verify(user, 'APPLE', '100')).resolves.toMatchObject({
      state: 'REVOKED',
    });
    expect(tx.quotaLot.create).toHaveBeenCalledTimes(1);
  });
  it('refund without authoritative revocation remains review, not automatic confiscation', async () => {
    await service.verify(user, 'APPLE', '100');
    apple.verify.mockResolvedValue(verified({ refundReported: true }));
    await expect(service.verify(user, 'APPLE', '100')).resolves.toMatchObject({
      refundReview: true,
      reviewRequired: true,
    });
    expect(tx.subscription.updateMany).not.toHaveBeenCalled();
  });
  it('existing mobile entitlement cannot be replaced by a new SePay order', async () => {
    db.promotion = { findFirst: jest.fn(async () => null) };
    db.payment = { create: jest.fn() };
    tx.subscription.findFirst.mockResolvedValue({
      billingSource: 'APPLE',
      plan: { code: 'BASIC' },
    });
    await expect(
      new PaymentService(db).createPayment(user, 'PRO'),
    ).rejects.toThrow('ACTIVE_PAID_SUBSCRIPTION_EXISTS');
    expect(db.payment.create).not.toHaveBeenCalled();
  });
});

describe('Official Apple SDK verification orchestration (mock SDK)', () => {
  let api: any, verifier: any, provider: AppleStoreService, payload: any;
  beforeEach(() => {
    payload = {
      transactionId: '100',
      originalTransactionId: '100',
      productId: 'mock.apple',
      appAccountToken: user,
      type: 'Auto-Renewable Subscription',
      expiresDate: Date.now() + 86400000,
      purchaseDate: Date.now() - 1000,
      environment: 'Sandbox',
    };
    api = {
      getTransactionInfo: jest.fn(async () => ({
        signedTransactionInfo: 'mock-signed',
      })),
      getAllSubscriptionStatuses: jest.fn(async () => ({
        data: [
          {
            lastTransactions: [
              {
                originalTransactionId: '100',
                status: 1,
                signedTransactionInfo: 'mock-signed',
                signedRenewalInfo: 'mock-renewal',
              },
            ],
          },
        ],
      })),
    };
    verifier = {
      verifyAndDecodeTransaction: jest.fn(async () => payload),
      verifyAndDecodeRenewalInfo: jest.fn(async () => ({
        originalTransactionId: '100',
        autoRenewStatus: 1,
      })),
      verifyAndDecodeNotification: jest.fn(async () => ({
        data: { signedTransactionInfo: 'mock-signed' },
      })),
    };
    (AppStoreServerAPIClient as unknown as jest.Mock).mockImplementation(
      () => api,
    );
    (SignedDataVerifier as unknown as jest.Mock).mockImplementation(
      () => verifier,
    );
    const values: any = {
      APPLE_STORE_ENVIRONMENT: 'Sandbox',
      APPLE_BUNDLE_ID: 'mock.bundle',
      APPLE_ROOT_CA_DER_BASE64: 'bW9jaw==',
      APPLE_PRIVATE_KEY_BASE64: 'bW9jaw==',
      APPLE_KEY_ID: 'mock',
      APPLE_ISSUER_ID: 'mock',
    };
    provider = new AppleStoreService({ required: (key) => values[key] } as any);
  });
  it('uses server API plus signed transaction/renewal verification', async () => {
    await expect(provider.verify('100')).resolves.toMatchObject({
      initialCycle: true,
      platform: 'APPLE',
      state: 'ACTIVE',
    });
    expect(SignedDataVerifier).toHaveBeenCalledWith(
      expect.any(Array),
      true,
      Environment.SANDBOX,
      'mock.bundle',
      undefined,
    );
    expect(verifier.verifyAndDecodeTransaction).toHaveBeenCalled();
  });
  it('invalid signature produces fixed error', async () => {
    verifier.verifyAndDecodeTransaction.mockRejectedValue(
      new Error('SENSITIVE_SENTINEL'),
    );
    await expect(provider.verify('100')).rejects.toThrow(
      'APPLE_VERIFICATION_FAILED',
    );
  });
  it('missing account token fails closed', async () => {
    delete payload.appAccountToken;
    await expect(provider.verify('100')).rejects.toThrow(
      'APPLE_VERIFICATION_FAILED',
    );
  });
  it('notification must be verified before fresh server lookup', async () => {
    await provider.notification('mock-notification');
    expect(verifier.verifyAndDecodeNotification).toHaveBeenCalledWith(
      'mock-notification',
    );
    expect(api.getAllSubscriptionStatuses).toHaveBeenCalledTimes(1);
  });
  it('revocation is recognized without trusting frontend state', async () => {
    payload.revocationDate = Date.now();
    await expect(provider.verify('100')).resolves.toMatchObject({
      state: 'REVOKED',
    });
  });
});

describe('Google subscriptionsv2, Orders and RTDN (mock HTTP/OIDC)', () => {
  let request: jest.Mock,
    subscription: any,
    order: any,
    oidc: any,
    provider: GoogleStoreService;
  beforeEach(() => {
    const start = new Date(Date.now() - 1000).toISOString();
    subscription = {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      startTime: start,
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      testPurchase: {},
      externalAccountIdentifiers: {
        obfuscatedExternalAccountId: createHash('sha256')
          .update(`ttv-google:${user}`)
          .digest('hex'),
      },
      lineItems: [
        {
          productId: 'mock.google',
          expiryTime: new Date(Date.now() + 86400000).toISOString(),
          latestSuccessfulOrderId: 'mock-order',
          offerDetails: { basePlanId: 'mock-monthly' },
          autoRenewingPlan: { autoRenewEnabled: true },
        },
      ],
    };
    order = {
      lineItems: [
        {
          productId: 'mock.google',
          subscriptionDetails: {
            basePlanId: 'mock-monthly',
            servicePeriodStartTime: start,
          },
        },
      ],
    };
    request = jest.fn(async ({ url }) => ({
      data: url.includes('/orders/') ? order : subscription,
    }));
    (GoogleAuth as unknown as jest.Mock).mockImplementation(() => ({
      getClient: async () => ({ request }),
    }));
    oidc = {
      email: 'mock@example.invalid',
      email_verified: true,
      iss: 'https://accounts.google.com',
    };
    (OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({
      verifyIdToken: async () => ({ getPayload: () => oidc }),
    }));
    const values: any = {
      GOOGLE_PLAY_PACKAGE_NAME: 'mock.package',
      GOOGLE_PLAY_ENVIRONMENT: 'Sandbox',
      GOOGLE_RTDN_AUDIENCE:
        'https://api.example.invalid/store-billing/notifications/google',
      GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL: 'mock@example.invalid',
      GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: Buffer.from(
        JSON.stringify({
          type: 'service_account',
          client_email: 'mock@example.invalid',
          private_key: 'mock-only',
        }),
      ).toString('base64'),
    };
    provider = new GoogleStoreService({
      required: (key) => values[key],
    } as any);
  });
  it('verifies account, product, base plan and initial accounting period', async () => {
    await expect(provider.verify('mock-token')).resolves.toMatchObject({
      platform: 'GOOGLE',
      initialCycle: true,
      state: 'ACTIVE',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', retry: false, timeout: 10000 }),
    );
  });
  it('renewal period differs from original subscription start', async () => {
    order.lineItems[0].subscriptionDetails.servicePeriodStartTime =
      new Date().toISOString();
    await expect(provider.verify('mock-token')).resolves.toMatchObject({
      initialCycle: false,
      renewalEligible: true,
    });
  });
  it('linked replacement token is not treated as a renewal of the existing chain', async () => {
    subscription.linkedPurchaseToken = 'mock-old-token';
    order.lineItems[0].subscriptionDetails.servicePeriodStartTime =
      new Date().toISOString();
    await expect(provider.verify('mock-token')).resolves.toMatchObject({
      initialCycle: false,
      renewalEligible: false,
    });
  });
  it.each([
    'SUBSCRIPTION_STATE_CANCELED',
    'SUBSCRIPTION_STATE_EXPIRED',
    'SUBSCRIPTION_STATE_ON_HOLD',
  ])('handles %s from server', async (state) => {
    subscription.subscriptionState = state;
    expect((await provider.verify('mock-token')).state).not.toBe('ACTIVE');
  });
  it('wrong environment or masked owner fails closed', async () => {
    delete subscription.testPurchase;
    await expect(provider.verify('mock-token')).rejects.toThrow(
      'GOOGLE_PURCHASE_VERIFICATION_FAILED',
    );
    subscription.testPurchase = {};
    delete subscription.externalAccountIdentifiers;
    await expect(provider.verify('mock-token')).rejects.toThrow(
      'GOOGLE_PURCHASE_VERIFICATION_FAILED',
    );
  });
  it('untrusted RTDN identity cannot reach publisher API', async () => {
    oidc.email = 'other@example.invalid';
    await expect(provider.notification('Bearer mock', 'e30=')).rejects.toThrow(
      'GOOGLE_NOTIFICATION_INVALID',
    );
    expect(request).not.toHaveBeenCalled();
  });
  it('RTDN notification type is never enough; fresh publisher API is required', async () => {
    const data = Buffer.from(
      JSON.stringify({
        packageName: 'mock.package',
        subscriptionNotification: {
          notificationType: 13,
          purchaseToken: 'mock-token',
        },
      }),
    ).toString('base64');
    await expect(
      provider.notification('Bearer mock', data),
    ).resolves.toMatchObject({ state: 'ACTIVE' });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('connection failure returns fixed error without token/exception details', async () => {
    request.mockRejectedValue(new Error('SENSITIVE_SENTINEL'));
    await expect(provider.verify('mock-token')).rejects.toThrow(
      'GOOGLE_PURCHASE_VERIFICATION_FAILED',
    );
  });
});
