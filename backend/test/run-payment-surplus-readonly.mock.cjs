'use strict';

// Offline only: evaluate the retired source with mocked process/console.
// Never import the runner or expose a database driver, filesystem or child API.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const source = readFileSync(
  join(__dirname, 'run-payment-surplus-readonly.cjs'),
  'utf8',
);

function evaluate(asMain) {
  const messages = [];
  let exitCode;
  let forbiddenAccesses = 0;
  function forbidden() {
    forbiddenAccesses++;
    throw new Error('FORBIDDEN_MOCK_ACCESS');
  }
  const fakeProcess = new Proxy(Object.create(null), {
    get: forbidden,
    set(_target, key, value) {
      if (key !== 'exitCode') return forbidden();
      exitCode = value;
      return true;
    },
  });
  const fakeModule = {};
  const fakeRequire = new Proxy(forbidden, {
    get(_target, key) {
      if (key === 'main') return asMain ? fakeModule : {};
      return forbidden();
    },
  });
  runInNewContext(
    source,
    {
      process: fakeProcess,
      console: { error: (message) => messages.push(message), log: forbidden },
      require: fakeRequire,
      module: fakeModule,
      setTimeout: forbidden,
      setInterval: forbidden,
    },
    { timeout: 500, contextCodeGeneration: { strings: false, wasm: false } },
  );
  return { messages, exitCode, forbiddenAccesses };
}

test('retired source contains no configuration, driver, SQL or redirect path', () => {
  assert.doesNotMatch(
    source,
    /\brequire\s*\(|\bimport\s|process\s*\.\s*env|DATABASE_URL|dotenv|\.env|\bPool\b|\bClient\b|\bspawn\b|\bexec\b|\bconnect\s*\(|\bSELECT\b|\bCREATE\b|\bDROP\b/,
  );
});

for (const asMain of [true, false]) {
  test(`refuses ${asMain ? 'direct entrypoint' : 'module evaluation'} without accessing dependencies or environment`, () => {
    const result = evaluate(asMain);
    assert.equal(result.exitCode, 1);
    assert.equal(result.forbiddenAccesses, 0);
    assert.equal(result.messages.length, 1);
    assert.match(result.messages[0], /^LEGACY_READONLY_RUNNER_DISABLED:/);
    assert.match(result.messages[0], /environment safety/);
    assert.match(result.messages[0], /no automatic redirect/);
  });
}

test('diagnostic is fixed and contains no connection URL or credential prompt', () => {
  const first = evaluate(true);
  const second = evaluate(true);
  assert.deepEqual(first, second);
  assert.doesNotMatch(first.messages[0], /:\/\/|password|token|Read-Host/i);
});
