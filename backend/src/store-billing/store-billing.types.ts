export type StorePlatform = 'APPLE' | 'GOOGLE';
export interface VerifiedStorePurchase {
  platform: StorePlatform;
  reference: string;
  chainId: string;
  cycleId: string;
  productId: string;
  basePlanId?: string;
  accountBinding: string;
  environment: string;
  state:
    | 'ACTIVE'
    | 'CANCELED'
    | 'EXPIRED'
    | 'REVOKED'
    | 'PENDING'
    | 'GRACE'
    | 'ON_HOLD';
  expiresAt: Date;
  startedAt: Date;
  initialCycle: boolean;
  renewalEligible?: boolean;
  acknowledged: boolean;
  refundReported?: boolean;
  autoRenew: boolean;
}
