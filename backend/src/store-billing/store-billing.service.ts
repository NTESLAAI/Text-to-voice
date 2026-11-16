import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CommercialControlService } from '../commercial-control/commercial-control.service';
import { StoreSettings } from './store-settings.service';
import { AppleStoreService } from './apple-store.service';
import { GoogleStoreService } from './google-store.service';
import { StorePlatform, VerifiedStorePurchase } from './store-billing.types';

@Injectable()
export class StoreBillingService {
  private readonly busy = new Set<string>();
  private readonly rates = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly db: PrismaService,
    private readonly settings: StoreSettings,
    private readonly apple: AppleStoreService,
    private readonly google: GoogleStoreService,
    private readonly commercialControl: CommercialControlService,
  ) {}
  binding(userId: string, platform: StorePlatform) {
    if (platform === 'APPLE') {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          userId,
        )
      )
        throw new UnauthorizedException('STORE_ACCOUNT_INVALID');
      return userId.toLowerCase();
    }
    return createHash('sha256').update(`ttv-google:${userId}`).digest('hex');
  }
  async catalog(userId: string, platform: StorePlatform) {
    const accountBinding = this.binding(userId, platform);
    const paid = await this.db.subscription.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        expiresAt: { gt: new Date() },
        plan: { code: { not: 'FREE' } },
      },
      select: { id: true },
    });
    return {
      platform,
      accountBinding,
      products: this.settings.products().filter((p) => p.platform === platform),
      purchaseEnabled: false,
      reason: paid
        ? 'ACTIVE_PAID_SUBSCRIPTION_EXISTS'
        : 'MOBILE_RELEASE_CONDITIONS_UNVERIFIED',
      eligibleForNewPurchase: !paid,
    };
  }
  async verify(userId: string, platform: StorePlatform, reference: string) {
    this.commercialControl.assertPaymentsEnabled();
    if (platform === 'APPLE' && !/^\d{1,64}$/.test(reference))
      throw new BadRequestException('STORE_REFERENCE_INVALID');
    const now = Date.now();
    for (const [key, value] of this.rates)
      if (value.until <= now) this.rates.delete(key);
    const rate = this.rates.get(userId) ?? { count: 0, until: now + 60000 };
    if (
      this.busy.has(userId) ||
      rate.count >= 10 ||
      (!this.rates.has(userId) && this.rates.size >= 5000)
    )
      throw new HttpException('STORE_VERIFICATION_RATE_LIMIT', 429);
    rate.count++;
    this.rates.set(userId, rate);
    this.busy.add(userId);
    const observedAt = new Date();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const verified = await Promise.race([
        platform === 'APPLE'
          ? this.apple.verify(reference)
          : this.google.verify(reference),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ServiceUnavailableException('STORE_VERIFICATION_TIMEOUT'),
              ),
            20000,
          );
        }),
      ]);
      return await this.deliver(userId, verified, observedAt);
    } finally {
      clearTimeout(timer);
      this.busy.delete(userId);
    }
  }
  async notification(
    platform: StorePlatform,
    payload: string,
    authorization?: string,
  ) {
    const observedAt = new Date();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let verified: VerifiedStorePurchase;
    try {
      verified = await Promise.race([
        platform === 'APPLE'
          ? this.apple.notification(payload)
          : this.google.notification(authorization, payload),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ServiceUnavailableException('STORE_VERIFICATION_TIMEOUT'),
              ),
            20000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const chainKey = this.hash(`${verified.environment}:${verified.chainId}`);
    const purchase = await this.db.storePurchase.findUnique({
      where: { platform_chainKey: { platform, chainKey } },
      select: { userId: true },
    });
    // Notifications never pick an arbitrary user from untrusted request fields.
    if (!purchase)
      throw new ConflictException('STORE_NOTIFICATION_OWNER_REVIEW_REQUIRED');
    return this.deliver(purchase.userId, verified, observedAt);
  }
  private async deliver(
    userId: string,
    verified: VerifiedStorePurchase,
    observedAt: Date,
  ) {
    const result = await this.record(userId, verified, observedAt);
    if (
      verified.platform === 'GOOGLE' &&
      result.deliveryStatus === 'GRANTED' &&
      !verified.acknowledged &&
      ['ACTIVE', 'CANCELED'].includes(result.state)
    )
      await this.google.acknowledge(verified.productId, verified.reference);
    return result;
  }
  private hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
  private encrypt(reference: string) {
    const key = Buffer.from(
      this.settings.required('STORE_REFERENCE_ENCRYPTION_KEY_BASE64'),
      'base64',
    );
    if (key.length !== 32)
      throw new ServiceUnavailableException(
        'STORE_ENCRYPTION_CONFIGURATION_INVALID',
      );
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(reference, 'utf8'),
      cipher.final(),
    ]);
    return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
  }
  private async record(
    userId: string,
    v: VerifiedStorePurchase,
    observedAt: Date,
  ) {
    if (v.accountBinding !== this.binding(userId, v.platform))
      throw new UnauthorizedException('STORE_ACCOUNT_BINDING_MISMATCH');
    if (
      !Number.isFinite(v.startedAt.getTime()) ||
      !Number.isFinite(v.expiresAt.getTime()) ||
      v.expiresAt <= v.startedAt
    )
      throw new UnauthorizedException('STORE_PERIOD_INVALID');
    const mapping = this.settings
      .products()
      .find(
        (p) =>
          p.platform === v.platform &&
          p.productId === v.productId &&
          (v.platform !== 'GOOGLE' || p.basePlanId === v.basePlanId),
      );
    if (!mapping)
      throw new UnauthorizedException('STORE_PRODUCT_NOT_CONFIGURED');
    const chainKey = this.hash(`${v.environment}:${v.chainId}`),
      cycleKey = this.hash(`${v.environment}:${v.cycleId}`),
      referenceCipher = this.encrypt(v.reference);
    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        const plan = await tx.plan.findUnique({
          where: { code: mapping.planCode },
        });
        if (!plan || !plan.isActive || plan.code === 'FREE')
          throw new ConflictException('STORE_PLAN_UNAVAILABLE');
        let purchase = await tx.storePurchase.findUnique({
          where: { platform_chainKey: { platform: v.platform, chainKey } },
        });
        if (purchase && purchase.userId !== userId)
          throw new ConflictException('STORE_PURCHASE_ALREADY_BOUND');
        if (!purchase)
          purchase = await tx.storePurchase.create({
            data: { platform: v.platform, chainKey, userId, referenceCipher },
          });
        const old = await tx.storeCycle.findUnique({
          where: { platform_cycleKey: { platform: v.platform, cycleKey } },
        });
        if (old && old.purchaseId !== purchase.id)
          throw new ConflictException('STORE_CYCLE_ALREADY_BOUND');
        if (old && (old.observedAt > observedAt || old.state === 'REVOKED'))
          return this.output(old);
        let cycle = await tx.storeCycle.upsert({
          where: { platform_cycleKey: { platform: v.platform, cycleKey } },
          create: {
            platform: v.platform,
            cycleKey,
            purchaseId: purchase.id,
            planId: plan.id,
            productId: v.productId,
            environment: v.environment,
            state: v.state,
            expiresAt: v.expiresAt,
            startedAt: v.startedAt,
            autoRenew: v.autoRenew,
            observedAt,
            refundReview: Boolean(v.refundReported),
          },
          update: {
            state: v.state,
            autoRenew: v.autoRenew,
            expiresAt: v.expiresAt,
            observedAt,
            refundReview: old?.refundReview || Boolean(v.refundReported),
          },
        });
        if (
          cycle.subscriptionId &&
          ['REVOKED', 'EXPIRED', 'ON_HOLD'].includes(v.state)
        ) {
          await tx.subscription.updateMany({
            where: {
              id: cycle.subscriptionId,
              userId,
              billingSource: v.platform,
            },
            data: { status: 'EXPIRED' },
          });
          if (v.state === 'REVOKED')
            await tx.quotaLot.updateMany({
              where: { subscriptionId: cycle.subscriptionId },
              data: { charactersRemaining: 0 },
            });
        }
        if (
          cycle.subscriptionId &&
          old?.state === 'ON_HOLD' &&
          !old.refundReview &&
          ['ACTIVE', 'CANCELED'].includes(v.state) &&
          v.expiresAt > new Date()
        ) {
          this.commercialControl.assertPaymentsEnabled();
          const otherPaid = await tx.subscription.findFirst({
            where: {
              userId,
              status: 'ACTIVE',
              id: { not: cycle.subscriptionId },
              expiresAt: { gt: new Date() },
              plan: { code: { not: 'FREE' } },
            },
          });
          if (otherPaid) return { ...this.output(cycle), reviewRequired: true };
          await tx.subscription.updateMany({
            where: {
              id: cycle.subscriptionId,
              userId,
              billingSource: v.platform,
            },
            data: { status: 'ACTIVE', expiresAt: v.expiresAt },
          });
          await tx.quotaLot.updateMany({
            where: { subscriptionId: cycle.subscriptionId },
            data: { expiresAt: v.expiresAt },
          });
        }
        if (
          (!old ||
            (old.state === 'PENDING' &&
              old.deliveryStatus === 'REVIEW_REQUIRED' &&
              !old.subscriptionId &&
              old.productId === v.productId &&
              old.planId === plan.id &&
              old.environment === v.environment &&
              old.startedAt.getTime() === v.startedAt.getTime())) &&
          !v.refundReported &&
          ['ACTIVE', 'CANCELED'].includes(v.state) &&
          v.startedAt <= new Date() &&
          v.expiresAt > new Date()
        ) {
          const now = new Date();
          const previous = await tx.storeCycle.findFirst({
            where: { purchaseId: purchase.id, deliveryStatus: 'GRANTED' },
            orderBy: { expiresAt: 'desc' },
            include: { subscription: { include: { quotaLots: true } } },
          });
          const renewal =
            !v.initialCycle &&
            v.renewalEligible === true &&
            previous &&
            !previous.refundReview &&
            previous.state !== 'REVOKED' &&
            previous.productId === v.productId &&
            previous.planId === plan.id &&
            previous.environment === v.environment &&
            previous.expiresAt.getTime() === v.startedAt.getTime() &&
            previous.subscription?.userId === userId &&
            previous.subscription.billingSource === v.platform &&
            previous.subscription.planId === plan.id;
          const paid = await tx.subscription.findFirst({
            where: {
              userId,
              status: 'ACTIVE',
              expiresAt: { gt: now },
              plan: { code: { not: 'FREE' } },
            },
          });
          // Charged conflicts remain recorded for review, never replace benefits.
          if (!paid && (v.initialCycle || renewal)) {
            this.commercialControl.assertPaymentsEnabled();
            const free = await tx.subscription.findFirst({
              where: { userId, status: 'ACTIVE', plan: { code: 'FREE' } },
            });
            if (free)
              await tx.subscription.update({
                where: { id: free.id },
                data: { status: 'EXPIRED' },
              });
            const subscription = await tx.subscription.create({
              data: {
                userId,
                planId: plan.id,
                billingSource: v.platform,
                status: 'ACTIVE',
                startedAt: v.startedAt,
                expiresAt: v.expiresAt,
                characterLimit: plan.characterLimit,
                rolloverCharacters: 0,
                pricePaid: null,
                currency: plan.currency,
              },
            });
            await tx.quotaLot.create({
              data: {
                subscriptionId: subscription.id,
                charactersGranted: plan.characterLimit,
                charactersRemaining: plan.characterLimit,
                rolloverCount: 0,
                expiresAt: v.expiresAt,
              },
            });
            if (renewal && previous?.subscription) {
              await tx.subscription.updateMany({
                where: {
                  id: previous.subscription.id,
                  userId,
                  billingSource: v.platform,
                },
                data: { status: 'EXPIRED' },
              });
              // Existing renewal policy: original positive lots, once, within 24h.
              // User is locked and sourceLotId has a unique constraint.
              if (
                now.getTime() - previous.expiresAt.getTime() <=
                24 * 60 * 60 * 1000
              ) {
                for (const lot of previous.subscription.quotaLots) {
                  if (
                    lot.charactersRemaining <= 0 ||
                    lot.rolloverCount !== 0 ||
                    lot.expiresAt > now
                  )
                    continue;
                  await tx.quotaLot.create({
                    data: {
                      subscriptionId: subscription.id,
                      sourceLotId: lot.id,
                      charactersGranted: lot.charactersRemaining,
                      charactersRemaining: lot.charactersRemaining,
                      rolloverCount: 1,
                      expiresAt: v.expiresAt,
                    },
                  });
                  await tx.quotaLot.update({
                    where: { id: lot.id },
                    data: {
                      charactersRemaining: 0,
                      rolloverCount: lot.rolloverCount + 1,
                    },
                  });
                }
              }
            }
            cycle = await tx.storeCycle.update({
              where: { id: cycle.id },
              data: {
                subscriptionId: subscription.id,
                deliveryStatus: 'GRANTED',
              },
            });
          }
        }
        return this.output(cycle);
      });
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      )
        throw new ConflictException(
          'STORE_CONCURRENT_VERIFICATION_RETRY_REQUIRED',
        );
      throw error;
    }
  }
  private output(cycle: {
    id: string;
    state: string;
    deliveryStatus: string;
    expiresAt: Date;
    autoRenew: boolean;
    refundReview?: boolean;
  }) {
    return {
      id: cycle.id,
      state: cycle.state,
      deliveryStatus: cycle.deliveryStatus,
      expiresAt: cycle.expiresAt,
      autoRenew: cycle.autoRenew,
      refundReview: Boolean(cycle.refundReview),
      reviewRequired:
        cycle.deliveryStatus !== 'GRANTED' ||
        Boolean(cycle.refundReview) ||
        ['GRACE', 'ON_HOLD'].includes(cycle.state),
    };
  }
}
