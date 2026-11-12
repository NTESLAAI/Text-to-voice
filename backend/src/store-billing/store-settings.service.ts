import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorePlatform } from './store-billing.types';

export interface StoreProductMapping {
  platform: StorePlatform;
  productId: string;
  planCode: string;
  basePlanId?: string;
}
@Injectable()
export class StoreSettings {
  constructor(private readonly config: ConfigService) {}
  required(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value)
      throw new ServiceUnavailableException('STORE_CONFIGURATION_REQUIRED');
    return value;
  }
  products(): StoreProductMapping[] {
    const raw = this.config.get<string>('STORE_PRODUCT_MAPPING');
    if (!raw) return [];
    try {
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length > 30) throw new Error();
      const seen = new Set<string>();
      return rows.map((row: unknown) => {
        if (!row || typeof row !== 'object') throw new Error();
        const r = row as Record<string, unknown>;
        if (
          Object.keys(r).some(
            (k) =>
              !['platform', 'productId', 'planCode', 'basePlanId'].includes(k),
          ) ||
          !['APPLE', 'GOOGLE'].includes(String(r.platform)) ||
          typeof r.productId !== 'string' ||
          !/^[\w.-]{1,200}$/.test(r.productId) ||
          typeof r.planCode !== 'string' ||
          !/^[A-Z][A-Z_0-9]{0,30}$/.test(r.planCode) ||
          r.planCode === 'FREE' ||
          (r.basePlanId !== undefined && typeof r.basePlanId !== 'string') ||
          (r.platform === 'GOOGLE' &&
            (typeof r.basePlanId !== 'string' ||
              !/^[a-z0-9-]{1,100}$/.test(r.basePlanId)))
        )
          throw new Error();
        const key = `${String(r.platform)}:${r.productId}:${typeof r.basePlanId === 'string' ? r.basePlanId : ''}`;
        if (seen.has(key)) throw new Error();
        seen.add(key);
        return {
          platform: r.platform as StorePlatform,
          productId: r.productId,
          planCode: r.planCode,
          ...(typeof r.basePlanId === 'string'
            ? { basePlanId: r.basePlanId }
            : {}),
        };
      });
    } catch {
      throw new ServiceUnavailableException(
        'STORE_PRODUCT_CONFIGURATION_INVALID',
      );
    }
  }
}
