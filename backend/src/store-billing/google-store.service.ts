import {
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { StoreSettings } from './store-settings.service';
import { VerifiedStorePurchase } from './store-billing.types';

interface GoogleSubscription {
  linkedPurchaseToken?: string;
  startTime?: string;
  acknowledgementState?: string;
  subscriptionState?: string;
  testPurchase?: object;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    latestSuccessfulOrderId?: string;
    offerDetails?: { basePlanId?: string; offerId?: string };
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
  }>;
}

@Injectable()
export class GoogleStoreService {
  constructor(private readonly settings: StoreSettings) {}
  async verify(purchaseToken: string): Promise<VerifiedStorePurchase> {
    const packageName = this.settings.required('GOOGLE_PLAY_PACKAGE_NAME');
    const environment = this.settings.required('GOOGLE_PLAY_ENVIRONMENT');
    if (!['Sandbox', 'Production'].includes(environment))
      throw new ServiceUnavailableException('GOOGLE_ENVIRONMENT_INVALID');
    try {
      const credentials = JSON.parse(
        Buffer.from(
          this.settings.required('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64'),
          'base64',
        ).toString('utf8'),
      ) as { type?: string; client_email?: string; private_key?: string };
      if (
        credentials.type !== 'service_account' ||
        !credentials.client_email ||
        !credentials.private_key
      )
        throw new Error();
      // Explicit credentials only: no ADC, credential-file or metadata-server fallback.
      const auth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      });
      const client = await auth.getClient();
      const result = await client.request<GoogleSubscription>({
        url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
        method: 'GET',
        timeout: 10000,
        retry: false,
        signal: AbortSignal.timeout(10000),
      });
      const data = result.data;
      if (
        (data.testPurchase ? 'Sandbox' : 'Production') !== environment ||
        data.lineItems?.length !== 1
      )
        throw new Error();
      const item = data.lineItems[0];
      const states: Record<string, VerifiedStorePurchase['state']> = {
        SUBSCRIPTION_STATE_ACTIVE: 'ACTIVE',
        SUBSCRIPTION_STATE_CANCELED: 'CANCELED',
        SUBSCRIPTION_STATE_EXPIRED: 'EXPIRED',
        SUBSCRIPTION_STATE_PENDING: 'PENDING',
        SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'GRACE',
        SUBSCRIPTION_STATE_ON_HOLD: 'ON_HOLD',
        SUBSCRIPTION_STATE_PAUSED: 'ON_HOLD',
        SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'EXPIRED',
      };
      const state = states[data.subscriptionState ?? ''];
      const expiresAt = new Date(item.expiryTime ?? '');
      if (
        !state ||
        !item.productId ||
        !item.offerDetails?.basePlanId ||
        !item.latestSuccessfulOrderId ||
        !data.externalAccountIdentifiers?.obfuscatedExternalAccountId ||
        !Number.isFinite(expiresAt.getTime()) ||
        typeof item.autoRenewingPlan?.autoRenewEnabled !== 'boolean'
      )
        throw new Error();
      const startedAt = new Date(data.startTime ?? '');
      if (
        !Number.isFinite(startedAt.getTime()) ||
        ![
          'ACKNOWLEDGEMENT_STATE_PENDING',
          'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        ].includes(data.acknowledgementState ?? '')
      )
        throw new Error();
      const order = await client.request<{
        lineItems?: Array<{
          productId?: string;
          subscriptionDetails?: {
            basePlanId?: string;
            servicePeriodStartTime?: string;
          };
        }>;
      }>({
        url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/orders/${encodeURIComponent(item.latestSuccessfulOrderId)}`,
        method: 'GET',
        timeout: 10000,
        retry: false,
        signal: AbortSignal.timeout(10000),
      });
      const lines =
        order.data.lineItems?.filter(
          (line) =>
            line.productId === item.productId &&
            line.subscriptionDetails?.basePlanId ===
              item.offerDetails?.basePlanId,
        ) ?? [];
      const initialCycle =
        !data.linkedPurchaseToken &&
        !item.offerDetails.offerId &&
        lines.length === 1 &&
        new Date(
          lines[0].subscriptionDetails?.servicePeriodStartTime ?? '',
        ).getTime() === startedAt.getTime();
      const periodStart = new Date(
        lines[0]?.subscriptionDetails?.servicePeriodStartTime ?? '',
      );
      const renewalEligible =
        !data.linkedPurchaseToken &&
        !item.offerDetails.offerId &&
        lines.length === 1 &&
        Number.isFinite(periodStart.getTime()) &&
        periodStart > startedAt &&
        periodStart < expiresAt;
      return {
        platform: 'GOOGLE',
        reference: purchaseToken,
        chainId: purchaseToken,
        cycleId: item.latestSuccessfulOrderId,
        productId: item.productId,
        basePlanId: item.offerDetails.basePlanId,
        accountBinding:
          data.externalAccountIdentifiers.obfuscatedExternalAccountId,
        environment,
        state:
          expiresAt.getTime() <= Date.now() && state !== 'PENDING'
            ? 'EXPIRED'
            : state,
        expiresAt,
        // Accounting start is accepted for renewal only after the ledger also
        // matches it to the previous store-verified expiry. Expiry remains V2.
        startedAt: renewalEligible ? periodStart : startedAt,
        initialCycle,
        renewalEligible,
        acknowledged:
          data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
        autoRenew: item.autoRenewingPlan.autoRenewEnabled,
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException('GOOGLE_PURCHASE_VERIFICATION_FAILED');
    }
  }
  async acknowledge(productId: string, purchaseToken: string): Promise<void> {
    try {
      const credentials = JSON.parse(
        Buffer.from(
          this.settings.required('GOOGLE_SERVICE_ACCOUNT_JSON_BASE64'),
          'base64',
        ).toString('utf8'),
      ) as { type: string; client_email: string; private_key: string };
      if (
        credentials.type !== 'service_account' ||
        !credentials.client_email ||
        !credentials.private_key
      )
        throw new Error();
      const client = await new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
      }).getClient();
      await client.request({
        url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.settings.required('GOOGLE_PLAY_PACKAGE_NAME'))}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
        method: 'POST',
        data: {},
        timeout: 10000,
        retry: false,
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'GOOGLE_ACKNOWLEDGEMENT_RETRY_REQUIRED',
      );
    }
  }
  async notification(
    authorization: string | undefined,
    data: string,
  ): Promise<VerifiedStorePurchase> {
    const audience = this.settings.required('GOOGLE_RTDN_AUDIENCE');
    const email = this.settings.required('GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL');
    try {
      if (!authorization?.startsWith('Bearer ')) throw new Error();
      const ticket = await new OAuth2Client().verifyIdToken({
        idToken: authorization.slice(7),
        audience,
      });
      const payload = ticket.getPayload();
      if (
        payload?.email !== email ||
        payload.email_verified !== true ||
        !['accounts.google.com', 'https://accounts.google.com'].includes(
          payload.iss,
        )
      )
        throw new Error();
      const event = JSON.parse(
        Buffer.from(data, 'base64').toString('utf8'),
      ) as {
        packageName?: string;
        subscriptionNotification?: { purchaseToken?: string };
        voidedPurchaseNotification?: { purchaseToken?: string };
      };
      if (
        event.packageName !== this.settings.required('GOOGLE_PLAY_PACKAGE_NAME')
      )
        throw new Error();
      const token =
        event.subscriptionNotification?.purchaseToken ??
        event.voidedPurchaseNotification?.purchaseToken;
      if (!token || token.length > 4096) throw new Error();
      // RTDN is a hint only. Always re-read authoritative state; never grant from its type.
      const verified = await this.verify(token);
      return {
        ...verified,
        refundReported: Boolean(event.voidedPurchaseNotification),
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new UnauthorizedException('GOOGLE_NOTIFICATION_INVALID');
    }
  }
}
