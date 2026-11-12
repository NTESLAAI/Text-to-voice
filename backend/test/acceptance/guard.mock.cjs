'use strict';
// Synthetic packet and fake PG only. Network and subprocesses are forbidden.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const net = require('node:net');
const tls = require('node:tls');
let network = 0;
net.Socket.prototype.connect = tls.connect = () => {
  network++;
  throw new Error('NETWORK_FORBIDDEN_IN_STATIC_MOCK');
};
const g = require('./guard.cjs');
const run = '11111111-1111-4111-8111-111111111111';
function packet() {
  const m = {
    version: 1,
    runId: run,
    clusterId: '7777777777777777777',
    dataDirectory: `D:/text-to-voice-it/${run}/pgdata`,
    roles: {},
    databases: {},
  };
  const credentials = {};
  for (const [i, role] of ['owner', 'writer', 'reader'].entries()) {
    m.roles[role] = { name: `ttv_it_${role}_11111111`, oid: String(20001 + i) };
    credentials[role] =
      `postgresql://${m.roles[role].name}:synthetic-only@127.0.0.1:56432/postgres`;
  }
  for (const [i, kind] of ['cold', 'upgrade', 'restored'].entries())
    m.databases[kind] = {
      name: `ttv_it_${kind}_${run.replaceAll('-', '')}`,
      oid: String(30001 + i),
      ownerOid: m.roles.owner.oid,
      markerSha256: g.hash('SYNTHETIC_MARKER'),
    };
  return {
    manifest: m,
    credentials,
    action: 'test',
    approval: `APPROVE ${run} test`,
  };
}
function row(p, role = 'writer') {
  return {
    db: p.manifest.databases.cold.name,
    role: p.manifest.roles[role].name,
    session_role: p.manifest.roles[role].name,
    host: '127.0.0.1',
    port: '56432',
    cluster: p.manifest.clusterId,
    directory: p.manifest.dataDirectory,
    version: '170011',
    ro: 'on',
    oid: '30001',
    owner_oid: '20001',
    role_oid: p.manifest.roles[role].oid,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    marker: 'SYNTHETIC_MARKER',
  };
}
function client(p, options = {}) {
  const events = [];
  class FakeClient {
    constructor(config) {
      events.push(['constructor', config]);
    }
    async connect() {
      events.push(['connect']);
      if (options.connectError) throw new Error('SENSITIVE_SENTINEL');
    }
    async query(sql) {
      events.push(['query', sql]);
      if (options.queryError)
        throw Object.assign(new Error('SENSITIVE_SENTINEL'), { code: '57014' });
      if (sql.includes('pg_control_system'))
        return { rows: options.rows ?? [row(p, options.role)] };
      if (sql.includes('AS safe'))
        return { rows: [{ safe: options.readerSafe ?? true }] };
      return { rows: [] };
    }
    async end() {
      events.push(['end']);
    }
  }
  return { FakeClient, events };
}
test('valid synthetic packet, exact new endpoint and target derivation', () => {
  const p = packet();
  assert.equal(g.validate(p, {}), p);
  const c = g.connection(p, 'cold', 'writer');
  const u = new URL(c.connectionString);
  assert.equal(u.port, '56432');
  assert.equal(u.pathname, '/' + p.manifest.databases.cold.name);
  assert.ok(
    c.connectionTimeoutMillis > 0 && c.query_timeout > 0 && c.lock_timeout > 0,
  );
});
for (const name of [
  'DATABASE_URL',
  'database_url',
  'PGHOST',
  'PGPORT',
  'PGPASSWORD',
  'PGSERVICEFILE',
  'DIRECT_URL',
  'NODE_OPTIONS',
  'NODE_PATH',
])
  test(`inherited ${name} is refused`, () => {
    assert.throws(
      () => g.validate(packet(), { [name]: 'SYNTHETIC_SENTINEL' }),
      /INHERITED_CONFIGURATION_REFUSED/,
    );
  });
for (const replacement of [
  '127.0.0.1:5432',
  '127.0.0.1:55432',
  '127.0.0.1:56433',
  'localhost:56432',
  '127.1:56432',
  '2130706433:56432',
  'example.invalid:56432',
])
  test(`URL refuses ${replacement} before any client`, () => {
    const p = packet();
    p.credentials.writer = p.credentials.writer.replace(
      '127.0.0.1:56432',
      replacement,
    );
    assert.throws(() => g.validate(p, {}), /URL_VALIDATION_FAILED/);
  });
for (const suffix of [
  '/text_to_voice',
  '/text_to_voice_test',
  '/other',
  '/postgres?host=elsewhere',
  '/postgres#token',
])
  test(`URL refuses path ${suffix}`, () => {
    const p = packet();
    p.credentials.writer = p.credentials.writer.replace('/postgres', suffix);
    assert.throws(() => g.validate(p, {}));
  });
for (const change of [
  (p) => (p.approval = ''),
  (p) => (p.action = 'bypass'),
  (p) => (p.manifest.runId = '../escape'),
  (p) => (p.manifest.clusterId = '7703979600700924132'),
  (p) => (p.manifest.dataDirectory = 'C:/Program Files/PostgreSQL/17/data'),
  (p) => (p.manifest.databases.cold.oid = '16393x'),
  (p) => (p.manifest.databases.cold.ownerOid = '10'),
  (p) => (p.manifest.roles.writer.oid = p.manifest.roles.reader.oid),
  (p) => (p.manifest.databases.cold.name = 'text_to_voice'),
  (p) => (p.manifest.extra = 'SENSITIVE_SENTINEL'),
])
  test(`invalid manifest/approval ${change.toString()}`, () => {
    const p = packet();
    change(p);
    assert.throws(() => g.validate(p, {}));
  });
for (const [field, bad] of Object.entries({
  db: 'other',
  role: 'postgres',
  session_role: 'postgres',
  host: '127.0.0.2',
  port: '5432',
  cluster: '1',
  directory: 'D:/text-to-voice/pg-test-cluster',
  version: '180000',
  ro: 'off',
  oid: '16393',
  owner_oid: '10',
  role_oid: '10',
  marker: null,
  rolsuper: true,
  rolcreatedb: true,
  rolcreaterole: true,
  rolreplication: true,
  rolbypassrls: true,
}))
  test(`identity ${field} mismatch fails closed`, () => {
    const p = packet();
    assert.throws(
      () => g.compare({ ...row(p), [field]: bad }, p, 'cold', 'writer'),
      /IDENTITY_UNVERIFIED/,
    );
  });
test('guard begins read-only, verifies identity before returning a client', async () => {
  const p = packet(),
    f = client(p);
  const c = await g.verifiedClient(p, 'cold', 'writer', f.FakeClient);
  await c.end();
  const queries = f.events.filter((e) => e[0] === 'query').map((e) => e[1]);
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.match(queries[1], /pg_control_system/);
  assert.equal(queries[2], 'ROLLBACK');
});
for (const options of [
  { connectError: true },
  { queryError: true },
  { rows: [] },
  { rows: [{ ...row(packet()), marker: 'WRONG' }] },
])
  test('connection/query/timeout/incomplete identity closes and refuses', async () => {
    const p = packet(),
      f = client(p, options);
    await assert.rejects(g.verifiedClient(p, 'cold', 'writer', f.FakeClient));
    assert.equal(f.events.at(-1)[0], 'end');
  });
test('reader privilege missing or UNKNOWN is never accepted', async () => {
  for (const safe of [false, null, 'true', 0]) {
    const p = packet(),
      f = client(p, { role: 'reader', readerSafe: safe });
    // null is explicitly modeled as UNKNOWN rather than substituted by the fake.
    if (safe === null)
      f.FakeClient.prototype.query = async function (sql) {
        if (sql.includes('pg_control_system'))
          return { rows: [row(p, 'reader')] };
        return { rows: [{ safe: null }] };
      };
    await assert.rejects(g.verifiedClient(p, 'cold', 'reader', f.FakeClient));
  }
});
function runner(fakeSpawn, timers = {}) {
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    __dirname,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    ...timers,
    process: { execPath: process.execPath, env: {} },
    require: (name) =>
      name === 'node:child_process' ? { spawn: fakeSpawn } : require(name),
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8'),
    context,
  );
  return module.exports;
}
function fakeProcess(output, code = 0, startFailure = false) {
  const cp = new EventEmitter();
  cp.stdout = new PassThrough();
  cp.stderr = new PassThrough();
  cp.stdin = new PassThrough();
  cp.stdio = [cp.stdin, cp.stdout, cp.stderr, new PassThrough()];
  cp.kill = () => cp.emit('close', 1);
  process.nextTick(() => {
    if (startFailure) return cp.emit('error', new Error('SENSITIVE_SENTINEL'));
    cp.stdout.end(output);
    cp.stderr.end('SENSITIVE_SENTINEL');
    cp.emit('close', code);
  });
  return cp;
}
test('child drains raw stderr without returning it and keeps valid count-only report', async () => {
  const r = {
    status: 'VERIFIED',
    readiness: 'NOT_READY',
    code: 'ACCEPTANCE_TEST_PASS',
    total: 14,
    passed: 14,
    failed: 0,
    skipped: 0,
    failedCases: [],
  };
  const result = await runner(() => fakeProcess(JSON.stringify(r))).child(
    'synthetic-node',
    [path.join(__dirname, 'test-worker.cjs')],
    packet(),
  );
  assert.equal(result.total, 14);
  assert.ok(!JSON.stringify(result).includes('SENSITIVE_SENTINEL'));
});
for (const bad of [
  { total: 0 },
  { skipped: 1 },
  { extra: 'SENSITIVE_SENTINEL' },
  { passed: '12' },
  { readiness: 'READY' },
])
  test(`child refuses invalid result ${JSON.stringify(bad)}`, async () => {
    const r = {
      status: 'VERIFIED',
      readiness: 'NOT_READY',
      code: 'ACCEPTANCE_TEST_PASS',
      total: 14,
      passed: 14,
      failed: 0,
      skipped: 0,
      failedCases: [],
      ...bad,
    };
    await assert.rejects(
      runner(() => fakeProcess(JSON.stringify(r))).child(
        'synthetic-node',
        [path.join(__dirname, 'test-worker.cjs')],
        packet(),
      ),
      /TEST_REPORT_UNVERIFIED/,
    );
  });
test('startup/nonzero child errors are fixed codes', async () => {
  await assert.rejects(
    runner(() => fakeProcess('', 1)).child('synthetic-node', [], packet()),
    /CHILD_FAILED/,
  );
  await assert.rejects(
    runner(() => fakeProcess('', 1, true)).child(
      'synthetic-node',
      [],
      packet(),
    ),
    /CHILD_START_FAILED/,
  );
});
test('failed integration report preserves only counts and allowlisted case IDs', async () => {
  const result = await runner(() =>
    fakeProcess(
      JSON.stringify({
        status: 'UNKNOWN',
        readiness: 'NOT_READY',
        code: 'ACCEPTANCE_TEST_FAILED',
        total: 14,
        passed: 13,
        failed: 1,
        skipped: 0,
        failedCases: ['A10'],
      }),
      1,
    ),
  ).child(
    'synthetic-node',
    [path.join(__dirname, 'test-worker.cjs')],
    packet(),
  );
  assert.equal(result.failed, 1);
  assert.equal(result.failedCases[0], 'A10');
});
test('timeout is UNKNOWN, sends no follow-up action and never retries', async () => {
  let spawns = 0,
    killed = 0;
  const fake = () => {
    spawns++;
    const cp = new EventEmitter();
    cp.stdout = new PassThrough();
    cp.stderr = new PassThrough();
    cp.stdin = new PassThrough();
    cp.stdio = [cp.stdin, cp.stdout, cp.stderr, new PassThrough()];
    cp.kill = () => {
      killed++;
      cp.emit('close', null);
    };
    return cp;
  };
  const r = runner(fake, {
    setTimeout: (fn) => {
      queueMicrotask(fn);
      return 0;
    },
    clearTimeout: () => {},
  });
  await assert.rejects(
    r.child('synthetic-node', [], packet()),
    /CHILD_TIMEOUT_OUTCOME_UNKNOWN/,
  );
  assert.equal(spawns, 1);
  assert.equal(killed, 1);
});
test('network fence allows only approved DB and registered local HTTP port', () => {
  let delegated = 0;
  class Socket {
    connect() {
      delegated++;
    }
  }
  const fakeGlobal = {};
  const context = {
    global: fakeGlobal,
    require: (name) => {
      if (name === './guard.cjs') return { readPacket: () => packet() };
      if (name === 'node:net') return { Socket };
      if (name === 'node:module') return { _load: () => {} };
      throw new Error('UNEXPECTED_REQUIRE');
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'setup.cjs'), 'utf8'),
    context,
  );
  for (const port of [5432, 55432, 80, 443])
    assert.throws(() => new Socket().connect({ host: '127.0.0.1', port }));
  assert.throws(() =>
    new Socket().connect({ host: 'example.invalid', port: 56432 }),
  );
  assert.throws(() => fakeGlobal.__allowAcceptanceHttpPort(5432));
  fakeGlobal.__allowAcceptanceHttpPort(62000);
  new Socket().connect({ host: '127.0.0.1', port: 62000 });
  new Socket().connect({ host: '127.0.0.1', port: 56432 });
  assert.equal(delegated, 2); // Fake socket only, no real network.
});
test('integration case inventory is exactly 14 without evaluating the spec', () => {
  const ts = require('typescript');
  const file = fs.readFileSync(
    path.join(__dirname, 'integration.acceptance.ts'),
    'utf8',
  );
  const ast = ts.createSourceFile(
    'integration.ts',
    file,
    ts.ScriptTarget.Latest,
    true,
  );
  let cases = 0;
  function visit(n) {
    if (ts.isCallExpression(n) && n.expression.getText(ast) === 'it') cases++;
    if (
      ts.isCallExpression(n) &&
      ts.isCallExpression(n.expression) &&
      n.expression.expression.getText(ast) === 'it.each'
    )
      cases += 2;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.equal(cases, 14);
});
test('explicit Jest selection does not map JWT/Passport to mocks or discover old tests', () => {
  const config = require('./jest.config.cjs');
  assert.deepEqual(config.testMatch, [
    '<rootDir>/test/acceptance/integration.acceptance.ts',
  ]);
  assert.ok(
    !Object.keys(config.moduleNameMapper).some((k) => /jwt|passport/.test(k)),
  );
  const source = fs.readFileSync(
    path.join(__dirname, 'integration.acceptance.ts'),
    'utf8',
  );
  assert.ok(!/jest\.mock\(['"][^'"]*(?:prisma|jwt|passport)/.test(source));
  assert.ok(
    source.indexOf('await guard.verifiedClient') <
      source.indexOf("await import('../../generated/prisma/client.js')"),
  );
  assert.match(source, /pg_blocking_pids/);
});
test('tool contains no provisioning or old Harness import, application config remains untouched', () => {
  const source = fs.readFileSync(path.join(__dirname, 'run.cjs'), 'utf8');
  assert.ok(
    !/query\([^\n]*(?:DROP DATABASE|CREATE DATABASE|CREATE ROLE|GRANT |REVOKE )/.test(
      source,
    ),
  );
  assert.ok(!/require\([^\n]*payment-surplus/.test(source));
  const prisma = fs.readFileSync(
    path.join(__dirname, '../../prisma.acceptance.config.ts'),
    'utf8',
  );
  assert.ok(!/import ['"]dotenv/.test(prisma));
  assert.match(prisma, /IDENTITY_VERIFIED/);
});
test('all static/mock cases made zero network attempts', () =>
  assert.equal(network, 0));
test('bootstrap diagnostics never return source text or sensitive sentinels', () => {
  for (const [input, expected] of [
    [
      'APPLICATION_BOOTSTRAP_REFUSED SENSITIVE_SENTINEL',
      'JEST_DOTENV_IMPORT_REFUSED',
    ],
    ['EBADF SENSITIVE_SENTINEL', 'JEST_FD_READ_FAILED'],
    ['Cannot find module SENSITIVE_SENTINEL', 'JEST_MODULE_NOT_FOUND'],
    ['ERR_REQUIRE_ESM SENSITIVE_SENTINEL', 'JEST_ESM_REQUIRE_FAILED'],
    ['TS1234: SENSITIVE_SENTINEL', 'JEST_TRANSFORM_FAILED'],
    ['SENSITIVE_SENTINEL', 'JEST_UNCLASSIFIED_BOOTSTRAP_FAILURE'],
  ])
    assert.equal(g.safeTestFailure(input), expected);
});
test('safe worker bootstrap error is preserved through the runner', async () => {
  await assert.rejects(
    runner(() =>
      fakeProcess(
        JSON.stringify({
          status: 'UNKNOWN',
          readiness: 'NOT_READY',
          code: 'JEST_MODULE_NOT_FOUND',
        }),
        1,
      ),
    ).child(
      'synthetic-node',
      [path.join(__dirname, 'test-worker.cjs')],
      packet(),
    ),
    /JEST_MODULE_NOT_FOUND/,
  );
});
test('explicit acceptance config lists safely from an unrelated cwd, without evaluating tests', async () => {
  const cwd = process.cwd(),
    config = path.join(__dirname, 'jest.config.cjs');
  try {
    process.chdir(require('node:os').tmpdir());
    await require('jest').runCLI(
      { config, runInBand: true, silent: true, listTests: true },
      [config],
    );
  } finally {
    process.chdir(cwd);
  }
  assert.equal(network, 0);
});
