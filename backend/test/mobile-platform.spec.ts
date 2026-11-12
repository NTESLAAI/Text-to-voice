/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// Browser/native APIs are VM mocks. Never run a native bridge, HTTP call or store.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import * as ts from 'typescript';
function load(file: string, mocks: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const source = readFileSync(resolve(__dirname, '../../frontend/src', file), 'utf8').replace('import.meta.env.VITE_API_BASE_URL', '"https://api.example.invalid"').replaceAll('import.meta.env.PROD', 'true');
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: (name: string) => { if (!(name in mocks)) throw new Error('UNMOCKED_IMPORT'); return mocks[name]; }, URL, ...globals });
  return exports as any;
}
const caps = (name: string) => ({ Capacitor: { isNativePlatform: () => name !== 'web', getPlatform: () => name } });
describe('Native token storage (mock)', () => {
  function fixture(name: string) {
    const secure = { set: jest.fn(), get: jest.fn(async () => 'mock-jwt'), remove: jest.fn() };
    const preferences = { set: jest.fn(), get: jest.fn(async () => ({ value: null })), remove: jest.fn() };
    const rmdir = jest.fn(async () => undefined);
    const module = load('services/authStorage.ts', { '@capacitor/core': caps(name), '@capacitor/preferences': { Preferences: preferences }, '@aparajita/capacitor-secure-storage': { SecureStorage: secure, KeychainAccess: { whenUnlockedThisDeviceOnly: 1 } }, '@capacitor/filesystem': { Filesystem: { rmdir }, Directory: { Cache: 'cache' } } });
    return { module, secure, preferences, rmdir };
  }
  it.each(['ios','android'])('%s stores token in secure device-only storage', async name => {
    const { module, secure, preferences } = fixture(name);
    await module.saveAuth('mock-jwt', { id: 'mock-user', role: 'USER' });
    expect(secure.set).toHaveBeenCalledWith('auth_token', 'mock-jwt', false, false, 1);
    expect(preferences.set).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'auth_token' }));
    await expect(module.getAuthToken()).resolves.toBe('mock-jwt');
    expect(preferences.get).not.toHaveBeenCalled();
  });
  it('secure storage failure never falls back to plaintext', async () => {
    const { module, secure, preferences } = fixture('ios');
    secure.get.mockRejectedValue(new Error('MOCK_KEYCHAIN_UNAVAILABLE'));
    await expect(module.getAuthToken()).rejects.toThrow();
    expect(preferences.get).not.toHaveBeenCalled();
  });
  it('logout removes secure token, legacy token, profile and only own export cache', async () => {
    const { module, secure, preferences, rmdir } = fixture('android');
    await module.clearAuth();
    expect(secure.remove).toHaveBeenCalledWith('auth_token', false);
    expect(preferences.remove).toHaveBeenCalledWith({ key: 'auth_token' });
    expect(preferences.remove).toHaveBeenCalledWith({ key: 'auth_user' });
    expect(rmdir).toHaveBeenCalledWith({ path: 'ttv-exports', directory: 'cache', recursive: true });
  });
  it('Web storage retains existing behavior without native bridge', async () => {
    const { module, secure, preferences } = fixture('web');
    await module.saveAuth('mock-jwt', { id: 'mock-user', role: 'USER' });
    expect(preferences.set).toHaveBeenCalledWith({ key: 'auth_token', value: 'mock-jwt' });
    expect(secure.set).not.toHaveBeenCalled();
  });
});

describe('Store purchase/restore bridge (mock)', () => {
  function fixture(name: string) {
    const platform = name === 'ios' ? 'APPLE' : 'GOOGLE';
    const catalog = { platform, accountBinding: 'mock-binding', purchaseEnabled: false, products: [{ productId: 'mock-product', basePlanId: 'mock-plan', planCode: 'BASIC' }] };
    const tx = { transactionId: '100', purchaseToken: 'mock-purchase-token' };
    const native = { configure: jest.fn(), getProducts: jest.fn(async () => ({ products: [{ identifier: name === 'ios' ? 'mock-product' : 'mock-plan', planIdentifier: 'mock-product', title: 'mock', priceString: 'store-price' }] })), purchaseProduct: jest.fn(async () => tx), restorePurchases: jest.fn(), getPurchases: jest.fn(async () => ({ purchases: [tx] })), finishTransaction: jest.fn(), manageSubscriptions: jest.fn() };
    const api = { get: jest.fn(async () => ({ data: catalog })), post: jest.fn(async () => ({ data: { state: 'ACTIVE', deliveryStatus: 'REVIEW_REQUIRED', reviewRequired: true } })) };
    const module = load('services/storeBilling.ts', { '@capacitor/core': caps(name), '@capgo/native-purchases': { NativePurchases: native, PURCHASE_TYPE: { SUBS: 'subs' } }, './api': { __esModule: true, default: api } }, { window: { dispatchEvent: jest.fn() }, Event: class { constructor(public type: string) {} } });
    return { module, native, api, catalog };
  }
  it.each(['ios','android'])('%s disables automatic finishing and uses store product metadata', async name => {
    const { module, native } = fixture(name);
    const result = await module.loadStoreProducts();
    expect(native.configure).toHaveBeenCalledWith({ autoFinishTransactions: false });
    expect(result.products[0].priceString).toBe('store-price');
  });
  it('unapproved policy never starts a charge', async () => {
    const { module, native } = fixture('ios');
    await expect(module.purchase({ identifier: 'mock-product' })).rejects.toThrow('STORE_PURCHASE_POLICY_NOT_APPROVED');
    expect(native.purchaseProduct).not.toHaveBeenCalled();
  });
  it.each(['ios','android'])('%s restore requires backend verification and does not finish review receipts', async name => {
    const { module, native, api } = fixture(name);
    await module.restore();
    expect(native.getPurchases).toHaveBeenCalledWith({ productType: 'subs', appAccountToken: 'mock-binding', onlyCurrentEntitlements: true });
    expect(api.post).toHaveBeenCalledWith('/store-billing/verify', { platform: name === 'ios' ? 'APPLE' : 'GOOGLE', reference: name === 'ios' ? '100' : 'mock-purchase-token' });
    expect(native.finishTransaction).not.toHaveBeenCalled();
  });
  it('verified Apple delivery can finish; backend 401 cannot finish', async () => {
    const { module, native, api } = fixture('ios');
    api.post.mockResolvedValue({ data: { state: 'ACTIVE', deliveryStatus: 'GRANTED', reviewRequired: false } });
    await module.restore();
    expect(native.finishTransaction).toHaveBeenCalledWith({ transactionId: '100' });
    native.finishTransaction.mockClear();
    api.post.mockRejectedValue({ response: { status: 401 } });
    await expect(module.restore()).rejects.toBeDefined();
    expect(native.finishTransaction).not.toHaveBeenCalled();
  });
  it('lost connection never claims delivery or finishes receipt', async () => {
    const { module, api, native } = fixture('android');
    api.post.mockRejectedValue(new Error('MOCK_OFFLINE'));
    await expect(module.restore()).rejects.toThrow('MOCK_OFFLINE');
    expect(native.finishTransaction).not.toHaveBeenCalled();
  });
  it('Web cannot initialize native billing', async () => {
    const { module, native } = fixture('web');
    await expect(module.loadStoreProducts()).rejects.toThrow('NATIVE_STORE_REQUIRED');
    expect(native.configure).not.toHaveBeenCalled();
  });
});

describe('Mobile audio and production transport (mock)', () => {
  it.each(['http://api.example.invalid','https://user:mock@api.example.invalid','https://api.example.invalid/?token=mock'])('production API rejects unsafe URL %s', url => {
    const api = { interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } } };
    const module = load('services/api.ts', { axios: { __esModule: true, default: { create: () => api } }, '@capacitor/core': caps('ios'), './authStorage': {}, './authSession': {}, '../utils/characterCount': {} });
    expect(() => module.validateApiTarget(url, true)).toThrow('API_HTTPS_CONFIGURATION_REQUIRED');
    expect(module.validateApiTarget('https://api.example.invalid', true)).toBe('https://api.example.invalid');
  });
  it('native audio export shares only an app cache file', async () => {
    const writeFile = jest.fn(async () => ({ uri: 'file:///cache/ttv-exports/mock.wav' }));
    const share = jest.fn();
    class Reader { result = 'data:audio/wav;base64,AQI='; onload?: () => void; readAsDataURL() { this.onload?.(); } }
    const fetch = jest.fn(async () => ({ blob: async () => ({ size: 2 }) }));
    const module = load('services/audioExport.ts', { '@capacitor/core': caps('ios'), '@capacitor/filesystem': { Filesystem: { writeFile, deleteFile: jest.fn() }, Directory: { Cache: 'cache' } }, '@capacitor/share': { Share: { share } } }, { fetch, FileReader: Reader, crypto: { randomUUID: () => 'mock-id' } });
    await module.exportAudio('blob:mock-audio');
    expect(writeFile).toHaveBeenCalledWith({ path: 'ttv-exports/audio-mock-id.wav', directory: 'cache', data: 'AQI=', recursive: true });
    expect(share).toHaveBeenCalledWith({ files: ['file:///cache/ttv-exports/mock.wav'] });
    await expect(module.exportAudio('http://example.invalid/private.wav')).rejects.toThrow('LOCAL_AUDIO_REQUIRED');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('native release config blocks cleartext, mixed content and auto finish', () => {
    const root = resolve(__dirname, '../../frontend');
    const config = readFileSync(resolve(root, 'capacitor.config.ts'), 'utf8');
    expect(config).toMatch(/allowMixedContent:\s*false/);
    expect(config).toMatch(/autoFinishTransactions:\s*false/);
    expect(readFileSync(resolve(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8')).toContain('usesCleartextTraffic="false"');
    expect(readFileSync(resolve(root, 'ios/App/App/Info.plist'), 'utf8')).toContain('NSAllowsArbitraryLoads');
  });
});
