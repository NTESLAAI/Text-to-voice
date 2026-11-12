// Isolated component tests: no DOM, HTTP, storage bridge, database or credentials.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const axios = require('axios');
const i18next = require('i18next');

function load(file, mocks = {}, globals = {}) {
  const source = readFileSync(resolve(__dirname, '../src', file), 'utf8');
  const exports = {};
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  runInNewContext(output, {
    exports,
    require(name) {
      if (!Object.hasOwn(mocks, name)) throw new Error('UNMOCKED_IMPORT');
      return mocks[name];
    },
    ...globals,
  });
  return exports.default;
}

const resources = {
  vi: load('i18n/locales/vi.ts'),
  en: load('i18n/locales/en.ts'),
};
const sentinel = 'PRIVATE_ERROR_SENTINEL';
function httpError(status, code) {
  const error = new axios.AxiosError(sentinel, code);
  if (status !== undefined) error.response = { status, data: { message: sentinel } };
  return error;
}

function fixture(language = 'vi', options = {}) {
  const i18n = i18next.createInstance();
  i18n.init({ resources, lng: language, fallbackLng: 'en', initImmediate: false });
  const state = [];
  let cursor = 0;
  const calls = { login: [], save: [], success: 0, register: 0, forgot: 0, logs: [] };
  const result = { accessToken: 'synthetic-token', user: { id: 'synthetic-user' } };
  const element = (type, props) => ({ type, props });
  const log = (...args) => calls.logs.push(args);
  const Component = load('pages/LoginPage.tsx', {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], value => {
          state[index] = typeof value === 'function' ? value(state[index]) : value;
        }];
      },
    },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-i18next': { useTranslation: () => ({ t: i18n.t.bind(i18n) }) },
    axios: { __esModule: true, default: axios },
    '../services/api': { login: async (...args) => {
      calls.login.push(args);
      if (options.login) return options.login();
      return result;
    } },
    '../services/authStorage': { saveAuth: async (...args) => {
      calls.save.push(args);
      if (options.save) await options.save();
    } },
  }, { console: { log, warn: log, error: log } });
  function render() {
    cursor = 0;
    const root = Component({
      onLoginSuccess: () => { calls.success++; if (options.callback) options.callback(); },
      onSwitchToRegister: () => { calls.register++; },
      onSwitchToForgotPassword: () => { calls.forgot++; },
    });
    const nodes = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      visit(node.props?.children);
    }
    visit(root);
    return nodes;
  }
  const find = predicate => render().find(predicate);
  const input = (id, value) => find(n => n.props.id === id).props.onChange({ target: { value } });
  const submit = () => find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  const alert = () => find(n => n.props.role === 'alert')?.props.children;
  return { calls, result, i18n, render, find, input, submit, alert };
}

const cases = [
  ['400', () => httpError(400), 'invalidRequest'],
  ['401', () => httpError(401), 'invalidCredentials'],
  ['403', () => httpError(403), 'forbidden'],
  ['429', () => httpError(429), 'rateLimited'],
  ['500', () => httpError(500), 'serverError'],
  ['503', () => httpError(503), 'serverError'],
  ['599', () => httpError(599), 'serverError'],
  ['network', () => httpError(undefined, 'ERR_NETWORK'), 'connectionError'],
  ['timeout', () => httpError(undefined, 'ECONNABORTED'), 'timeout'],
  ['timeout alternative', () => httpError(undefined, 'ETIMEDOUT'), 'timeout'],
  ['unknown Axios error', () => httpError(undefined, 'OTHER'), 'unexpected'],
  ['404', () => httpError(404), 'unexpected'],
  ['cancellation', () => httpError(undefined, 'ERR_CANCELED'), 'unexpected'],
  ['non-Axios network-like error', () => ({ code: 'ERR_NETWORK', message: sentinel }), 'unexpected'],
  ['unknown exception', () => new Error(sentinel), 'unexpected'],
  ['HTTP status takes precedence over timeout code', () => httpError(500, 'ETIMEDOUT'), 'serverError'],
];
for (const language of ['vi', 'en']) {
  for (const [name, error, key] of cases) {
    test(`${language}: ${name} is translated without raw errors or retry`, async () => {
      const f = fixture(language, { login: () => { throw error(); } });
      f.input('login-identifier', 'synthetic@example.invalid');
      f.input('login-password', 'Synthetic123');
      await f.submit();
      assert.equal(f.alert(), resources[language].translation.auth.login.errors[key]);
      assert.ok(!f.alert().includes(sentinel));
      assert.equal(f.calls.login.length, 1);
      assert.equal(f.calls.save.length, 0);
      assert.equal(f.calls.success, 0);
      assert.equal(f.find(n => n.type === 'button' && n.props.type === 'submit').props.disabled, false);
      assert.equal(f.calls.logs.length, 0);
    });
  }
  for (const [name, fail] of [
    ['storage error', () => { throw new Error(sentinel); }],
    ['Axios-shaped storage failure', () => { throw httpError(401); }],
  ]) test(`${language}: ${name} is not incorrect credentials`, async () => {
    const f = fixture(language, { save: fail });
    f.input('login-identifier', 'synthetic@example.invalid');
    f.input('login-password', 'Synthetic123');
    await f.submit();
    assert.equal(f.alert(), resources[language].translation.auth.login.errors.sessionStorage);
    assert.equal(f.calls.save.length, 1);
    assert.equal(f.calls.success, 0);
    assert.equal(f.calls.logs.length, 0);
    assert.equal(f.find(n => n.props.id === 'login-password').props.disabled, false);
  });
  test(`${language}: missing details never calls login`, async () => {
    const f = fixture(language);
    f.input('login-identifier', '   ');
    f.input('login-password', 'Synthetic123');
    await f.submit();
    assert.equal(f.alert(), resources[language].translation.auth.login.errors.required);
    assert.equal(f.calls.login.length, 0);
  });
}

test('success preserves trimmed identifier, unmodified password, storage and callback', async () => {
  const f = fixture();
  f.input('login-identifier', '  synthetic@example.invalid  ');
  f.input('login-password', ' Synthetic123 ');
  await f.submit();
  assert.deepEqual(f.calls.login, [['synthetic@example.invalid', ' Synthetic123 ']]);
  assert.deepEqual(f.calls.save, [[f.result.accessToken, f.result.user]]);
  assert.equal(f.calls.success, 1);
  assert.equal(f.alert(), undefined);
});

test('in-flight request clears previous error, disables controls, and permits retry after failure', async () => {
  let reject;
  const f = fixture('vi', { login: () => new Promise((_, fail) => { reject = fail; }) });
  await f.submit();
  assert.ok(f.alert());
  f.input('login-identifier', 'synthetic@example.invalid');
  f.input('login-password', 'Synthetic123');
  const pending = f.submit();
  assert.equal(f.alert(), undefined);
  assert.equal(f.find(n => n.type === 'button' && n.props.type === 'submit').props.disabled, true);
  reject(httpError(429));
  await pending;
  assert.equal(f.find(n => n.props.id === 'login-identifier').props.disabled, false);
  assert.equal(f.calls.login.length, 1);
});

test('existing error switches language without another request', async () => {
  const f = fixture('vi', { login: () => { throw httpError(401); } });
  f.input('login-identifier', 'synthetic@example.invalid');
  f.input('login-password', 'Synthetic123');
  await f.submit();
  assert.equal(f.alert(), resources.vi.translation.auth.login.errors.invalidCredentials);
  await f.i18n.changeLanguage('en');
  assert.equal(f.alert(), resources.en.translation.auth.login.errors.invalidCredentials);
  assert.equal(f.calls.login.length, 1);
});

test('callback failure stays generic even when shaped like an authentication error', async () => {
  const f = fixture('en', { callback: () => { throw httpError(401); } });
  f.input('login-identifier', 'synthetic@example.invalid');
  f.input('login-password', 'Synthetic123');
  await f.submit();
  assert.equal(f.calls.save.length, 1);
  assert.equal(f.calls.success, 1);
  assert.equal(f.alert(), resources.en.translation.auth.login.errors.unexpected);
});

test('both languages have the same complete nonempty error keys', () => {
  const vi = resources.vi.translation.auth.login.errors;
  const en = resources.en.translation.auth.login.errors;
  assert.deepEqual(Object.keys(vi).sort(), Object.keys(en).sort());
  assert.equal(Object.keys(vi).length, 10);
  for (const value of [...Object.values(vi), ...Object.values(en)])
    assert.ok(typeof value === 'string' && value.trim() && !value.includes(sentinel));
});
