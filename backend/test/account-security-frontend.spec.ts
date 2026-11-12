/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
// VM exports and fake transport responses are deliberately dynamic test fixtures.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import * as ts from 'typescript';

// Transpile only the specific frontend modules; every transport/storage is fake.
function load(
  file: string,
  mocks: Record<string, unknown>,
  globals: Record<string, unknown> = {},
) {
  const source = readFileSync(
    resolve(__dirname, '../../frontend/src', file),
    'utf8',
  ).replaceAll('import.meta.env.PROD', 'false').replace(
    'import.meta.env.VITE_API_BASE_URL',
    '"https://api.example.invalid"',
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports = {};
  runInNewContext(output, {
    exports,
    require: (name: string) => {
      if (!(name in mocks)) throw new Error('UNMOCKED_IMPORT');
      return mocks[name];
    },
    ...globals,
  });
  return exports as any;
}

describe('Frontend session security, mocked storage and HTTP only', () => {
  it('clears authentication and dispatches expiry event', async () => {
    const clearAuth = jest.fn(async () => undefined);
    const dispatchEvent = jest.fn();
    const module = load(
      'services/authSession.ts',
      { './authStorage': { clearAuth, getAuthToken: async () => 'old' } },
      {
        window: { dispatchEvent },
        Event: class {
          constructor(public type: string) {}
        },
      },
    );
    await module.expireSession('old');
    expect(clearAuth).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auth-session-expired' }),
    );
  });
  it('stale 401 must not clear a newer login', async () => {
    const clearAuth = jest.fn();
    const dispatchEvent = jest.fn();
    const module = load(
      'services/authSession.ts',
      { './authStorage': { clearAuth, getAuthToken: async () => 'new' } },
      { window: { dispatchEvent } },
    );
    await module.expireSession('old');
    expect(clearAuth).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
  function apiMock(status = 401, native = true) {
    const handlers: any = {};
    const expireSession = jest.fn(async () => undefined);
    const post = jest.fn(async () => ({ status, data: 'AQI=' }));
    const get = jest.fn(async () => ({ status, data: 'AQI=' }));
    const client = {
      interceptors: {
        request: { use: jest.fn((fn) => (handlers.request = fn)) },
        response: {
          use: jest.fn((ok, fail) => {
            handlers.ok = ok;
            handlers.fail = fail;
          }),
        },
      },
    };
    const axios = {
      create: () => client,
      isAxiosError: (err: any) => err?.isAxiosError === true,
    };
    const atob = jest.fn(() => {
      if (status !== 200) throw new Error('AUDIO_MUST_NOT_BE_DECODED');
      return '\u0001\u0002';
    });
    const fetch = jest.fn(async () => ({ status: 401, ok: false }));
    const module = load(
      'services/api.ts',
      {
        axios: { __esModule: true, default: axios },
        '@capacitor/core': {
          Capacitor: {
            getPlatform: () => (native ? 'android' : 'web'),
            isNativePlatform: () => native,
          },
          CapacitorHttp: { post, get },
        },
        '../utils/characterCount': { countBillableCharacters: () => 1 },
        './authStorage': { getAuthToken: async () => 'old' },
        './authSession': { expireSession },
      },
      {
        atob,
        fetch,
        Uint8Array,
        Blob,
        URL: class extends URL { static createObjectURL() { return 'blob:mock-audio'; } },
      },
    );
    return { handlers, expireSession, module, atob };
  }
  it('Axios 401 expires matching session; other errors do not', async () => {
    const { handlers, expireSession } = apiMock();
    const error = {
      isAxiosError: true,
      response: { status: 401 },
      config: { headers: { Authorization: 'Bearer old' } },
    };
    await expect(handlers.fail(error)).rejects.toBe(error);
    expect(expireSession).toHaveBeenCalledWith('old');
    expireSession.mockClear();
    await expect(
      handlers.fail({ ...error, response: { status: 429 } }),
    ).rejects.toBeDefined();
    expect(expireSession).not.toHaveBeenCalled();
  });
  it.each([
    'synthesizeSpeech',
    'synthesizeDialogue',
    'getProtectedAudioBlob',
    'getProtectedDialogueBlob',
  ])('native %s handles 401 before audio decoding', async (method) => {
    const { module, expireSession, atob } = apiMock();
    await expect(module[method]({})).rejects.toThrow('HTTP_REQUEST_FAILED_401');
    expect(expireSession).toHaveBeenCalledWith('old');
    expect(atob).not.toHaveBeenCalled();
  });
  it.each(['getProtectedAudioBlob', 'getProtectedDialogueBlob'])(
    'web fetch %s expires on 401',
    async (method) => {
      const { module, expireSession } = apiMock(401, false);
      await expect(module[method]('mock-id')).rejects.toThrow();
      expect(expireSession).toHaveBeenCalledWith('old');
    },
  );
  it.each(['synthesizeSpeech', 'synthesizeDialogue'])(
    'native %s still returns audio on success',
    async (method) => {
      const { module, expireSession, atob } = apiMock(200);
      await expect(
        module[method]({
          projectId: 'mock-project',
          text: 'mock text',
          language: 'vi',
        }),
      ).resolves.toEqual(
        expect.objectContaining({ fileUrl: 'blob:mock-audio' }),
      );
      expect(atob).toHaveBeenCalledTimes(1);
      expect(expireSession).not.toHaveBeenCalled();
    },
  );
  it('sensitive frontend paths contain no console calls', () => {
    for (const file of [
      'services/api.ts',
      'pages/LoginPage.tsx',
      'pages/ForgotPasswordPage.tsx',
      'pages/ResetPasswordPage.tsx',
      'pages/AccountPage.tsx',
      'pages/RegisterPage.tsx',
    ]) {
      expect(
        readFileSync(resolve(__dirname, '../../frontend/src', file), 'utf8'),
      ).not.toMatch(/console\.(log|error|warn)\(/);
    }
  });
  it('successful password change/reset expires session; App listens for expiry', () => {
    for (const file of [
      'pages/AccountPage.tsx',
      'pages/ResetPasswordPage.tsx',
    ]) {
      expect(
        readFileSync(resolve(__dirname, '../../frontend/src', file), 'utf8'),
      ).toContain('await expireSession()');
    }
    expect(
      readFileSync(resolve(__dirname, '../../frontend/src/App.tsx'), 'utf8'),
    ).toContain('auth-session-expired');
  });
});
