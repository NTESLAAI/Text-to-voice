import {
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AppStoreServerAPIClient,
  SignedDataVerifier,
  Environment,
  JWSTransactionDecodedPayload,
} from '@apple/app-store-server-library';
import { StoreSettings } from './store-settings.service';
import { VerifiedStorePurchase } from './store-billing.types';

@Injectable()
export class AppleStoreService {
  constructor(private readonly settings: StoreSettings) {}
  private clients() {
    const name = this.settings.required('APPLE_STORE_ENVIRONMENT');
    if (!['Production', 'Sandbox'].includes(name))
      throw new ServiceUnavailableException('APPLE_ENVIRONMENT_INVALID');
    const env =
      name === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX;
    const bundle = this.settings.required('APPLE_BUNDLE_ID');
    const roots = this.settings
      .required('APPLE_ROOT_CA_DER_BASE64')
      .split(',')
      .map((s) => Buffer.from(s.trim(), 'base64'));
    const appId =
      name === 'Production'
        ? Number(this.settings.required('APPLE_APP_ID'))
        : undefined;
    if (
      roots.some((b) => !b.length) ||
      (appId !== undefined && (!Number.isSafeInteger(appId) || appId < 1))
    )
      throw new ServiceUnavailableException('APPLE_CONFIGURATION_INVALID');
    return {
      api: new AppStoreServerAPIClient(
        Buffer.from(
          this.settings.required('APPLE_PRIVATE_KEY_BASE64'),
          'base64',
        ).toString('utf8'),
        this.settings.required('APPLE_KEY_ID'),
        this.settings.required('APPLE_ISSUER_ID'),
        bundle,
        env,
      ),
      verifier: new SignedDataVerifier(roots, true, env, bundle, appId),
    };
  }
  private async bounded<T>(job: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        job,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ServiceUnavailableException('APPLE_VERIFICATION_TIMEOUT'),
              ),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async verify(transactionId: string): Promise<VerifiedStorePurchase> {
    const { api, verifier } = this.clients();
    try {
      return await this.bounded(
        (async () => {
          const info = await api.getTransactionInfo(transactionId);
          if (!info.signedTransactionInfo) throw new Error();
          const requested = await verifier.verifyAndDecodeTransaction(
            info.signedTransactionInfo,
          );
          if (
            requested.transactionId !== transactionId ||
            !requested.originalTransactionId
          )
            throw new Error();
          const status = await api.getAllSubscriptionStatuses(
            requested.originalTransactionId,
          );
          const candidates: Array<{
            data: JWSTransactionDecodedPayload;
            state: number;
            autoRenew: boolean;
          }> = [];
          for (const group of status.data ?? [])
            for (const item of group.lastTransactions ?? []) {
              if (
                item.originalTransactionId !==
                  requested.originalTransactionId ||
                !item.signedTransactionInfo ||
                !item.signedRenewalInfo
              )
                continue;
              const data = await verifier.verifyAndDecodeTransaction(
                item.signedTransactionInfo,
              );
              const renewal = await verifier.verifyAndDecodeRenewalInfo(
                item.signedRenewalInfo,
              );
              if (
                data.originalTransactionId !==
                  requested.originalTransactionId ||
                renewal.originalTransactionId !==
                  requested.originalTransactionId ||
                data.appAccountToken !== requested.appAccountToken
              )
                throw new Error();
              candidates.push({
                data,
                state: Number(item.status),
                autoRenew: renewal.autoRenewStatus === 1,
              });
            }
          if (candidates.length !== 1) throw new Error();
          const { autoRenew } = candidates[0];
          const data = requested.revocationDate
            ? requested
            : candidates[0].data;
          const state = requested.revocationDate ? 5 : candidates[0].state;
          if (
            !data.transactionId ||
            !data.productId ||
            !data.appAccountToken ||
            data.type !== 'Auto-Renewable Subscription' ||
            !data.expiresDate ||
            !Number.isFinite(data.expiresDate) ||
            !data.purchaseDate ||
            !Number.isFinite(data.purchaseDate)
          )
            throw new Error();
          const states = {
            1: 'ACTIVE',
            2: 'EXPIRED',
            3: 'ON_HOLD',
            4: 'GRACE',
            5: 'REVOKED',
          } as const;
          let normalized: VerifiedStorePurchase['state'] =
            states[state as keyof typeof states];
          if (!normalized) throw new Error();
          if (data.revocationDate) normalized = 'REVOKED';
          else if (data.expiresDate <= Date.now()) normalized = 'EXPIRED';
          else if (normalized === 'ACTIVE' && !autoRenew)
            normalized = 'CANCELED';
          return {
            platform: 'APPLE',
            reference: data.transactionId,
            chainId: requested.originalTransactionId,
            cycleId: data.transactionId,
            productId: data.productId,
            accountBinding: data.appAccountToken.toLowerCase(),
            environment: String(data.environment),
            state: normalized,
            expiresAt: new Date(data.expiresDate),
            startedAt: new Date(data.purchaseDate),
            initialCycle:
              data.transactionId === data.originalTransactionId &&
              data.offerType === undefined,
            renewalEligible:
              data.transactionReason === 'RENEWAL' &&
              data.offerType === undefined,
            acknowledged: false,
            autoRenew,
          };
        })(),
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException('APPLE_VERIFICATION_FAILED');
    }
  }
  async notification(signedPayload: string): Promise<VerifiedStorePurchase> {
    const { verifier } = this.clients();
    try {
      const event = await this.bounded(
        verifier.verifyAndDecodeNotification(signedPayload),
      );
      if (!event.data?.signedTransactionInfo) throw new Error();
      const tx = await this.bounded(
        verifier.verifyAndDecodeTransaction(event.data.signedTransactionInfo),
      );
      if (!tx.transactionId) throw new Error();
      const verified = await this.verify(tx.transactionId);
      return {
        ...verified,
        refundReported: ['REFUND', 'REVOKE'].includes(
          String(event.notificationType),
        ),
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException('APPLE_NOTIFICATION_INVALID');
    }
  }
}
