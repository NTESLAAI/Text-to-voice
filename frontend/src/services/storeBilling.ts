import { Capacitor } from '@capacitor/core';
import { NativePurchases, PURCHASE_TYPE, type Product, type Transaction } from '@capgo/native-purchases';
import api from './api';
export type StorePlatform = 'APPLE' | 'GOOGLE';
export interface StoreCatalog { platform: StorePlatform; accountBinding: string; products: Array<{ productId: string; basePlanId?: string; planCode: string }>; purchaseEnabled: boolean; reason: string }
export interface VerificationResult { state: string; deliveryStatus: string; reviewRequired: boolean }
export function platform(): StorePlatform {
  if (!Capacitor.isNativePlatform() || !['ios','android'].includes(Capacitor.getPlatform())) throw new Error('NATIVE_STORE_REQUIRED');
  return Capacitor.getPlatform() === 'ios' ? 'APPLE' : 'GOOGLE';
}
export async function loadStoreProducts(): Promise<{ catalog: StoreCatalog; products: Product[] }> {
  const storePlatform = platform();
  await NativePurchases.configure({ autoFinishTransactions: false });
  const { data: catalog } = await api.get<StoreCatalog>('/store-billing/catalog', { params: { platform: storePlatform } });
  if (!catalog.products.length) return { catalog, products: [] };
  const { products } = await NativePurchases.getProducts({ productIdentifiers: [...new Set(catalog.products.map(p => p.productId))], productType: PURCHASE_TYPE.SUBS });
  return { catalog, products: products.filter(p => catalog.products.some(m => catalog.platform === 'APPLE' ? m.productId === p.identifier : m.productId === p.planIdentifier && m.basePlanId === p.identifier)) };
}
async function verify(transaction: Transaction, catalog: StoreCatalog): Promise<VerificationResult> {
  const reference = catalog.platform === 'APPLE' ? transaction.transactionId : transaction.purchaseToken;
  if (!reference) throw new Error('STORE_REFERENCE_MISSING');
  const { data } = await api.post<VerificationResult>('/store-billing/verify', { platform: catalog.platform, reference });
  window.dispatchEvent(new Event('store-entitlement-updated'));
  if (catalog.platform === 'APPLE' && data.deliveryStatus === 'GRANTED' && !data.reviewRequired) await NativePurchases.finishTransaction({ transactionId: transaction.transactionId });
  return data;
}
export async function purchase(product: Product) {
  const { catalog } = await loadStoreProducts();
  if (!catalog.purchaseEnabled) throw new Error('STORE_PURCHASE_POLICY_NOT_APPROVED');
  const mapping = catalog.products.find(m => catalog.platform === 'APPLE' ? m.productId === product.identifier : m.productId === product.planIdentifier && m.basePlanId === product.identifier);
  if (!mapping) throw new Error('STORE_PRODUCT_NOT_CONFIGURED');
  const tx = await NativePurchases.purchaseProduct({ productIdentifier: mapping.productId, planIdentifier: mapping.basePlanId, offerToken: product.offerToken, productType: PURCHASE_TYPE.SUBS, appAccountToken: catalog.accountBinding, autoAcknowledgePurchases: false });
  return verify(tx, catalog);
}
export async function restore() {
  const { catalog } = await loadStoreProducts();
  await NativePurchases.restorePurchases();
  const { purchases } = await NativePurchases.getPurchases({ productType: PURCHASE_TYPE.SUBS, appAccountToken: catalog.accountBinding, onlyCurrentEntitlements: true });
  if (purchases.length > 50) throw new Error('STORE_RESTORE_LIMIT_EXCEEDED');
  const result: VerificationResult[] = [];
  for (const tx of purchases) result.push(await verify(tx, catalog));
  return result;
}
export async function manageStoreSubscriptions() { await NativePurchases.manageSubscriptions(); }
