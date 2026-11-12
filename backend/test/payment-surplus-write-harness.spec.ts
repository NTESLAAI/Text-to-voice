import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
const {
  createPreflightRun,
} = require('./payment-surplus-preflight-contract.cjs');
const {
  WRITE_CASES,
  testSummary,
} = require('./payment-surplus-write-contract.cjs');

// Pure source/mock tests: never import the integration suite or runner.
const spec = readFileSync(
  join(__dirname, 'payment-surplus-temp.integration.e2e-spec.ts'),
  'utf8',
);
const runner = readFileSync(
  join(__dirname, 'run-payment-surplus-temp.cjs'),
  'utf8',
);
function functionSource(name: string, source = spec) {
  const ast = ts.createSourceFile(
    'spec.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  let found = '';
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name)
      found = node.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!found) throw new Error('Missing source function');
  return ts.transpileModule(found, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
}
function summary(ids = ['401', '403', '404', '200', ...WRITE_CASES]) {
  return {
    success: true,
    numTotalTests: ids.length,
    numPassedTests: ids.length,
    numPendingTests: 0,
    testResults: [
      { assertionResults: ids.map((title) => ({ title, status: 'passed' })) },
    ],
  };
}

describe('Write harness fail-closed contract (static/mock only)', () => {
  function approvalReader() {
    return runInNewContext(
      `${runnerFunctions('requireCondition', 'readRunApproval')}\nreadRunApproval`,
      { setTimeout, clearTimeout },
    );
  }
  const approvalRequest = {
    version: 1,
    runId: '11111111-1111-4111-8111-111111111111',
    mode: 'READ_TESTS',
    target: `ttv_surplus_it_${'a'.repeat(32)}`,
    challenge: 'b'.repeat(64),
    confirmRun: true,
    confirmExclusive: true,
  };
  it('approval channel is live after one reply; EOF or extra input revokes it', async () => {
    for (const extra of ['EOF', 'EXTRA']) {
      const input = new PassThrough();
      const gate = { approve: jest.fn(), revoke: jest.fn() };
      const pending = approvalReader()(
        input,
        gate,
        new AbortController().signal,
      );
      input.write(JSON.stringify(approvalRequest) + '\n');
      const channel = await pending;
      expect(channel.isOpen()).toBe(true);
      if (extra === 'EOF') input.emit('end');
      else input.write('EXTRA');
      expect(channel.isOpen()).toBe(false);
      expect(gate.revoke).toHaveBeenCalled();
      channel.dispose();
      input.destroy();
    }
  });
  it.each([
    'EOF',
    'ERROR',
    'ABORT',
    'BAD_JSON',
    'OVERSIZE',
    'REJECTED',
    'EXTRA_LINE',
  ])('approval transport fails closed: %s', async (reason) => {
    const input = new PassThrough();
    const signal = new AbortController();
    const gate = {
      approve: () => {
        if (reason === 'REJECTED') throw Error('MOCK_ONLY');
      },
      revoke: jest.fn(),
    };
    const pending = approvalReader()(input, gate, signal.signal);
    const rejected = expect(pending).rejects.toHaveProperty('safeCode');
    if (reason === 'EOF') input.emit('end');
    if (reason === 'ERROR') input.emit('error', Error('MOCK_ONLY'));
    if (reason === 'ABORT') signal.abort();
    if (reason === 'BAD_JSON') input.write('not-json\n');
    if (reason === 'OVERSIZE') input.write('x'.repeat(2049));
    if (reason === 'REJECTED') input.write('{}\n');
    if (reason === 'EXTRA_LINE') input.write('{}\n{}\n');
    await rejected;
    input.destroy();
  });
  it('approval transport has a finite timeout without any PostgreSQL client', async () => {
    jest.useFakeTimers();
    const input = new PassThrough();
    try {
      const pending = approvalReader()(
        input,
        { approve: jest.fn(), revoke: jest.fn() },
        new AbortController().signal,
      );
      const rejected = expect(pending).rejects.toMatchObject({
        safeCode: 'PREFLIGHT_APPROVAL_TIMEOUT',
      });
      await jest.advanceTimersByTimeAsync(120000);
      await rejected;
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      input.destroy();
      jest.useRealTimers();
    }
  });
  it.each([
    'APPROVAL_WRONG',
    'APPROVAL_EOF',
    'INTERRUPT',
    'METADATA_UNKNOWN',
    'METADATA_BLOCKER',
    'SESSION_UNKNOWN',
    'SESSION_OTHER',
    'CHANNEL_LOST',
    'CLUSTER_WRONG',
    'UUID_EXISTS',
    'INTERRUPT_FINAL',
    'EVIDENCE_EXPIRED',
    'CREATE_SUBMITTED',
  ])(
    'actual main with isolated mock I/O sends zero CREATE on NO-GO: %s',
    async (scenario) => {
      const input = new PassThrough();
      const proc: any = new EventEmitter();
      proc.stdin = input;
      proc.pid = 123;
      proc.env = {
        PAYMENT_SURPLUS_TEMP_ALLOW_RUN: 'YES', // Isolated mock object, never process.env.
        PAYMENT_SURPLUS_TEST_ADMIN_URL:
          'postgresql://ttv_surplus_lifecycle:MOCK_ONLY@127.0.0.1:55432/postgres',
        PAYMENT_SURPLUS_TEST_WRITER_URL:
          'postgresql://ttv_surplus_writer:MOCK_ONLY@127.0.0.1:55432/postgres',
        PAYMENT_SURPLUS_TEST_READER_URL:
          'postgresql://ttv_surplus_reader:MOCK_ONLY@127.0.0.1:55432/postgres',
        PAYMENT_SURPLUS_TEST_OBSERVATION_URL:
          'postgresql://ttv_surplus_observer:MOCK_ONLY@127.0.0.1:55432/postgres',
        PAYMENT_SURPLUS_TEST_OBSERVATION_MODE: 'OBSERVER',
        PAYMENT_SURPLUS_TEST_CLUSTER_ID: '7703979600700924132',
        PAYMENT_SURPLUS_TEST_DATA_DIRECTORY: 'D:/text-to-voice/pg-test-cluster',
        PAYMENT_SURPLUS_TEST_PORT: '55432',
      };
      const start = '2026-11-06T01:00:00.123456Z';
      let createSent = 0,
        connected = 0,
        clusterReads = 0,
        mockTime = 0;
      const codes: string[] = [];
      const own = {
        pid: '10',
        backend_start: start,
        database_oid: '5',
        role_oid: '101',
      };
      class MockClient {
        async connect() {
          connected++;
        }
        async end() {}
        unref() {}
        async query(sql: string) {
          if (sql.startsWith('CREATE DATABASE')) {
            createSent++;
            throw new Error('MOCK_CREATE_STOP');
          }
          if (sql.includes('server_version_num')) {
            clusterReads++;
            if (clusterReads === 3 && scenario === 'INTERRUPT_FINAL')
              proc.emit('SIGINT');
            if (clusterReads === 3 && scenario === 'EVIDENCE_EXPIRED')
              mockTime = 20000;
            return {
              rows: [
                {
                  db: 'postgres',
                  version: 170011,
                  directory: proc.env.PAYMENT_SURPLUS_TEST_DATA_DIRECTORY,
                  address: '127.0.0.1',
                  port: '55432',
                  cluster:
                    scenario === 'CLUSTER_WRONG'
                      ? 'WRONG'
                      : proc.env.PAYMENT_SURPLUS_TEST_CLUSTER_ID,
                  recovery: false,
                },
              ],
            };
          }
          if (sql.includes('FROM pg_roles WHERE rolname=ANY'))
            return {
              rows: [
                'ttv_surplus_lifecycle',
                'ttv_surplus_writer',
                'ttv_surplus_reader',
              ].map((rolname, i) => ({
                rolname,
                oid: String(101 + i),
                rolcanlogin: true,
                rolcreatedb: i === 0,
                rolsuper: false,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
              })),
            };
          if (sql.includes('AS lifecycle_identity'))
            return {
              rows: [
                {
                  lifecycle_identity: true,
                  direct_writer_membership: true,
                  reverse_membership: false,
                },
              ],
            };
          if (sql.includes('AS direct_memberships_allowed'))
            return {
              rows: [
                {
                  direct_memberships_allowed: true,
                  reachable_roles_allowed: true,
                },
              ],
            };
          if (sql.includes('AS allowed')) return { rows: [{ allowed: true }] };
          if (sql.includes('AS backend_start')) return { rows: [own] };
          if (
            scenario === 'UUID_EXISTS' &&
            sql.includes('FROM pg_database WHERE datname = $1')
          )
            return { rows: [{ oid: '999' }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }
      }
      const makeRow = (pid, classification, role_oid, usename) => ({
        ...own,
        pid,
        classification,
        role_oid,
        usename,
        observation: 'VISIBLE',
        backendIdentity: `7703979600700924132|${start}|${pid}|${start}`,
      });
      const metadataProof = {
        verification: scenario === 'METADATA_UNKNOWN' ? 'UNKNOWN' : 'VERIFIED',
        scope: 'POSTGRES_ACL_AND_CLUSTER_DATABASES',
        identity: {
          host: '127.0.0.1',
          port: '55432',
          db: 'postgres',
          cluster: '7703979600700924132',
          directory: 'D:/text-to-voice/pg-test-cluster',
          postmaster_start: start,
        },
        blockers:
          scenario === 'METADATA_BLOCKER'
            ? ['TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE']
            : [],
        checks: {
          database_oid: '5',
          snapshotMatched: true,
          objects: {
            roles: ['101', '102', '103'].map((role_oid) => ({ role_oid })),
          },
        },
      };
      const context: any = {
        process: proc,
        Client: MockClient,
        URL,
        performance: { now: () => mockTime },
        AbortController,
        setTimeout,
        clearTimeout,
        backend: 'MOCK_BACKEND',
        path: { join: (...p) => p.join('/') },
        fs: {
          readdirSync: () =>
            Array.from({ length: 24 }, (_, i) => ({
              isDirectory: () => true,
              name:
                i === 23
                  ? '20261103000000_add_payment_surplus_handling'
                  : `202600${String(i).padStart(2, '0')}`,
            })),
          readFileSync: () => '',
        },
        randomUUID: () => approvalRequest.runId,
        randomBytes: () => ({ toString: () => 'b'.repeat(64) }),
        sha: () => 'MOCK_HASH',
        WRITE_CASES: [],
        normalizePath: (s: string) =>
          s.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase(),
        quote: (s: string) => '"' + s.replaceAll('"', '""') + '"',
        APPROVED_TEST: {
          host: '127.0.0.1',
          port: '55432',
          cluster: '7703979600700924132',
          directory: 'd:/text-to-voice/pg-test-cluster',
        },
        QUERY_LIMITS: {},
        SESSION_LIMITS: '',
        createPreflightRun,
        collectPreflightMetadata: async () => metadataProof,
        inspectSessions: async () => {
          if (scenario === 'CHANNEL_LOST') input.emit('end');
          return {
            status: scenario === 'SESSION_UNKNOWN' ? 'UNKNOWN' : 'PASS',
            reason: 'SESSION_SNAPSHOT_READ',
            cluster: '7703979600700924132',
            postmasterStart: start,
            observedAt: start,
            selfPid: '20',
            unclassifiedOtherBackends: 0,
            verifiedOtherClients: 1,
            verifiedOtherBackgrounds: 0,
            otherSessions: 1,
            targetSessions: 0,
            sessions: [
              makeRow('20', 'SELF', '104', 'ttv_surplus_observer'),
              makeRow(
                scenario === 'SESSION_OTHER' ? '99' : '10',
                'VERIFIED_CLIENT',
                '101',
                'ttv_surplus_lifecycle',
              ),
            ],
          };
        },
        console: {
          error: (text: string) => {
            const record = JSON.parse(text);
            if (record.code) codes.push(record.code);
          },
          log: (text: string) => {
            const request = JSON.parse(text);
            if (request.type !== 'PREFLIGHT_CHALLENGE') return;
            queueMicrotask(() => {
              if (scenario === 'APPROVAL_EOF') input.emit('end');
              else if (scenario === 'INTERRUPT') proc.emit('SIGINT');
              else
                input.write(
                  JSON.stringify({
                    version: 1,
                    runId:
                      scenario === 'APPROVAL_WRONG' ? 'WRONG' : request.runId,
                    mode: request.mode,
                    target: request.target,
                    challenge: request.challenge,
                    confirmRun: true,
                    confirmExclusive: true,
                  }) + '\n',
                );
            });
          },
        },
      };
      const main = runInNewContext(
        `${runnerFunctions('requireCondition', 'parseTestUrl', 'assertApprovedConfiguration', 'assertNoExistingDatabaseCreate', 'runnerStatus', 'readRunApproval', 'main', 'closeCleanupClient', 'cleanupDeadline')}\nmain`,
        context,
      );
      try {
        await main(false);
        expect(createSent).toBe(scenario === 'CREATE_SUBMITTED' ? 1 : 0);
        expect(proc.exitCode).toBe(1);
        const expected = {
          APPROVAL_WRONG: 'PREFLIGHT_APPROVAL_INVALID',
          APPROVAL_EOF: 'PREFLIGHT_CHANNEL_CLOSED',
          INTERRUPT: 'PREFLIGHT_INTERRUPTED',
          METADATA_UNKNOWN: 'PREFLIGHT_EVIDENCE_INVALID',
          METADATA_BLOCKER: 'PREFLIGHT_METADATA_BLOCKED',
          SESSION_UNKNOWN: 'PREFLIGHT_EVIDENCE_INVALID',
          SESSION_OTHER: 'PREFLIGHT_SESSION_UNEXPLAINED',
          CHANNEL_LOST: 'PREFLIGHT_CHANNEL_CLOSED',
          CLUSTER_WRONG: 'CLUSTER_IDENTITY_MISMATCH',
          UUID_EXISTS: 'TEMP_DATABASE_NAME_ALREADY_EXISTS',
          INTERRUPT_FINAL: 'RUN_INTERRUPTED',
          EVIDENCE_EXPIRED: 'PREFLIGHT_EVIDENCE_INVALID',
          CREATE_SUBMITTED: 'OPERATION_FAILED',
        };
        expect(codes).toContain(expected[scenario]);
        if (['APPROVAL_WRONG', 'APPROVAL_EOF', 'INTERRUPT'].includes(scenario))
          expect(connected).toBe(0);
      } finally {
        input.destroy();
      }
    },
  );
  it.each([
    ['valid', 'postgresql://ttv_surplus_writer:MOCK_ONLY@127.0.0.1:55432/'],
    ['wrong-port', 'postgresql://ttv_surplus_writer:MOCK_ONLY@127.0.0.1:5432/'],
    [
      'wrong-host',
      'postgresql://ttv_surplus_writer:MOCK_ONLY@localhost:55432/',
    ],
    ['admin-role', 'postgresql://postgres:MOCK_ONLY@127.0.0.1:55432/'],
    [
      'reader-role',
      'postgresql://ttv_surplus_reader:MOCK_ONLY@127.0.0.1:55432/',
    ],
    ['missing-password', 'postgresql://ttv_surplus_writer@127.0.0.1:55432/'],
  ])('writer URL guard: %s', (label, prefix) => {
    const name = `ttv_surplus_it_${'1'.repeat(32)}`;
    const parse = runInNewContext(
      `${functionSource('parseWriterUrl')}\nparseWriterUrl`,
      { URL, APPROVED_TEST: { host: '127.0.0.1', port: '55432' } },
    );
    if (label === 'valid') {
      expect(parse(prefix + name, name).pathname).toBe(`/${name}`);
      for (const suffix of [
        'postgres',
        'text_to_voice',
        `${name}?host=localhost`,
        `${name}#fragment`,
      ])
        expect(() => parse(prefix + suffix, name)).toThrow();
    } else expect(() => parse(prefix + name, name)).toThrow();
  });
  it('requires all 19 unique passing cases; read mode still requires four', () => {
    expect(testSummary(summary(), true).passed).toBe(true);
    expect(
      testSummary(summary(['401', '403', '404', '200']), false).passed,
    ).toBe(true);
    expect(
      testSummary(summary(['401', '403', '404', '200']), true).passed,
    ).toBe(false);
    const registered = [...spec.matchAll(/it\('(WRITE_[A-Z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(registered.sort()).toEqual([...WRITE_CASES].sort());
  });
  it.each(['failed', 'pending', 'todo', 'unknown'])(
    'rejects non-pass %s',
    (status) => {
      const data = summary();
      data.testResults[0].assertionResults[4].status = status;
      expect(testSummary(data, true).passed).toBe(false);
    },
  );
  it('rejects omitted, duplicate, extra and malformed summaries', () => {
    for (const ids of [
      WRITE_CASES,
      ['401', '403', '404', '200', ...WRITE_CASES.slice(1)],
      ['401', '403', '404', '200', ...WRITE_CASES, WRITE_CASES[0]],
    ])
      expect(testSummary(summary(ids), true).passed).toBe(false);
    expect(testSummary(null, true).passed).toBe(false);
    expect(testSummary({ ...summary(), success: false }, true).passed).toBe(
      false,
    );
    expect(testSummary({ ...summary(), numPendingTests: 1 }, true).passed).toBe(
      false,
    );
  });

  function identityHarness() {
    const name = `ttv_surplus_it_${'1'.repeat(32)}`;
    const env = {
      PAYMENT_SURPLUS_TEMP_OID: '20001',
      PAYMENT_SURPLUS_TEMP_OWNER_OID: '20002',
      PAYMENT_SURPLUS_TEMP_READER_ROLE: 'ttv_surplus_reader',
      PAYMENT_SURPLUS_TEMP_WRITER_ROLE: 'ttv_surplus_writer',
      PAYMENT_SURPLUS_TEMP_TOKEN: 'a'.repeat(64),
    };
    const row = {
      db: name,
      session_ro: 'off',
      tx_ro: 'off',
      oid: '20001',
      owner: '20002',
      role: 'ttv_surplus_writer',
      session_role: 'ttv_surplus_writer',
      address: '127.0.0.1',
      port: '55432',
      cluster: '7703979600700924132',
      directory: 'D:/text-to-voice/pg-test-cluster',
      marker: `ttv-surplus-it:${env.PAYMENT_SURPLUS_TEMP_TOKEN}`,
    };
    const context = {
      name,
      process: { env },
      APPROVED_TEST: {
        host: '127.0.0.1',
        port: '55432',
        cluster: row.cluster,
        directory: row.directory.toLowerCase(),
      },
      normalizePath: (s: string) =>
        s.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase(),
    };
    const check = runInNewContext(
      `${functionSource('assertIdentity')}\n${functionSource('assertWriter')}\nassertWriter`,
      context,
    );
    return { row, check };
  }
  it('accepts exact writer identity and Windows path normalization', () => {
    const { row, check } = identityHarness();
    expect(() => check(row)).not.toThrow();
    expect(() =>
      check({ ...row, directory: 'D:\\text-to-voice\\pg-test-cluster\\' }),
    ).not.toThrow();
  });
  it.each([
    'db',
    'oid',
    'owner',
    'marker',
    'role',
    'session_role',
    'cluster',
    'directory',
    'address',
    'port',
    'session_ro',
    'tx_ro',
  ])('rejects mismatched %s before HTTP', (field) => {
    const { row, check } = identityHarness();
    expect(() => check({ ...row, [field]: 'WRONG' })).toThrow();
  });

  async function runCompetition(
    kind: 'blocked' | 'missing' | 'query-error' | 'job-error',
  ) {
    const statements: string[] = [];
    let releaseJobs!: () => void,
      released = false;
    const releasedLock = new Promise<void>((resolve) => {
      releaseJobs = resolve;
    });
    const gate = {
      query: jest.fn(async (sql: string) => {
        statements.push(sql);
        if (sql === 'IDENTITY') return { rows: [{}] };
        if (sql.includes('pg_backend_pid')) return { rows: [{ pid: 123 }] };
        if (sql === 'ROLLBACK') {
          releaseJobs();
        }
        return { rows: [] };
      }),
      release: () => {
        released = true;
      },
    };
    let clock = 0;
    const context = {
      control: {
        connect: async () => gate,
        query: async () => {
          if (kind === 'query-error') throw new Error('SIMULATED_QUERY_ERROR');
          return {
            rows:
              kind === 'missing'
                ? []
                : [
                    { pid: 1, blockers: [123] },
                    { pid: 2, blockers: [1] },
                  ],
          };
        },
      },
      assertWriter: () => {},
      writerIdentitySql: 'IDENTITY',
      Date: {
        now: () => {
          clock += 500;
          return clock;
        },
      },
      setTimeout: (cb: () => void) => cb(),
    };
    const compete = runInNewContext(
      `${functionSource('competing')}\ncompeting`,
      context,
    );
    const job = async () => {
      await releasedLock;
      if (kind === 'job-error') throw new Error('SIMULATED_HTTP_ERROR');
      return { status: 201 };
    };
    let result: any, error: any;
    try {
      result = await compete('synthetic-payment', [job, job]);
    } catch (e) {
      error = e;
    }
    expect(statements.some((s) => s.includes('FOR UPDATE'))).toBe(true);
    expect(statements).toContain('ROLLBACK');
    expect(released).toBe(true);
    return { result, error };
  }
  it('proves two blocked API transactions before releasing the gate', async () => {
    const { result, error } = await runCompetition('blocked');
    expect(error).toBeUndefined();
    expect(result).toHaveLength(2);
  });
  it.each(['missing', 'query-error', 'job-error'] as const)(
    'fails on %s and releases gate/settles requests',
    async (kind) => {
      const { error } = await runCompetition(kind);
      expect(error).toBeDefined();
    },
  );
  function runnerFunctions(...names: string[]) {
    return names.map((name) => functionSource(name, runner)).join('\n');
  }
  it.each([
    ['absent', [], true],
    [
      'OID survives under another name',
      [{ oid: '42', datname: 'renamed' }],
      false,
    ],
    ['name reused with another OID', [{ oid: '99', datname: 'target' }], false],
  ])('DROP postcheck: %s', async (_label, databases: any, accepted) => {
    const client = {
      query: jest.fn(async (sql, args) => {
        expect(sql).toContain('datname=$1 OR oid=$2::oid');
        const rows = databases.filter(
          (r) => r.datname === args[0] || r.oid === args[1],
        );
        return { rowCount: rows.length, rows };
      }),
    };
    const check = runInNewContext(
      `${runnerFunctions('requireCondition', 'verifyDatabaseDropped')}\nverifyDatabaseDropped`,
      {},
    );
    const cluster = jest.fn(async () => undefined);
    if (accepted)
      await expect(
        check(client, 'target', '42', cluster),
      ).resolves.toBeUndefined();
    else
      await expect(
        check(client, 'target', '42', cluster),
      ).rejects.toMatchObject({ safeCode: 'DATABASE_DROP_NOT_CONFIRMED' });
    expect(cluster).toHaveBeenCalledWith(client, 'postgres');
  });
  it.each(['CLUSTER_MISMATCH', 'QUERY_TIMEOUT', 'CONNECTION_LOST'])(
    'postcheck never succeeds after %s',
    async (reason) => {
      const check = runInNewContext(
        `${runnerFunctions('requireCondition', 'verifyDatabaseDropped')}\nverifyDatabaseDropped`,
        {},
      );
      const error = new Error(reason);
      const client = {
        query: jest.fn(async () => {
          throw error;
        }),
      };
      await expect(
        check(client, 'target', '42', async () => {
          if (reason === 'CLUSTER_MISMATCH') throw error;
        }),
      ).rejects.toBe(error);
      if (reason === 'CLUSTER_MISMATCH')
        expect(client.query).not.toHaveBeenCalled();
    },
  );
  it.each([0, 1])(
    'existing database CREATE guard stays fail-closed (matches=%s)',
    async (rowCount) => {
      const check = runInNewContext(
        `${runnerFunctions('requireCondition', 'assertNoExistingDatabaseCreate')}\nassertNoExistingDatabaseCreate`,
        {},
      );
      const query = jest.fn(async (sql, args) => {
        expect(sql).toContain("has_database_privilege($1::oid,oid,'CREATE')");
        expect(sql).not.toMatch(/datname\s*(?:<>|!=)|DELETE|DROP|GRANT|REVOKE/);
        expect(args).toEqual(['writer', 'reader']);
        return { rowCount };
      });
      if (rowCount)
        await expect(
          check({ query }, 'writer', 'reader'),
        ).rejects.toMatchObject({
          safeCode: 'TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE',
        });
      else
        await expect(
          check({ query }, 'writer', 'reader'),
        ).resolves.toBeUndefined();
    },
  );
  it('cleanup deadline rejects a hanging operation and clears its timer', async () => {
    jest.useFakeTimers();
    try {
      const deadline = runInNewContext(
        `${runnerFunctions('cleanupDeadline')}\ncleanupDeadline`,
        { Promise, setTimeout, clearTimeout },
      );
      const assertion = expect(
        deadline(() => new Promise(() => {})),
      ).rejects.toMatchObject({ safeCode: 'CLEANUP_TIMEOUT' });
      await jest.advanceTimersByTimeAsync(10000);
      await assertion;
      expect(jest.getTimerCount()).toBe(0);
      await expect(deadline(async () => 123)).resolves.toBe(123);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
  it('whole-run deadline marks failure and interrupts children, never PASS', () => {
    const ast = ts.createSourceFile(
      'runner.cjs',
      runner,
      ts.ScriptTarget.Latest,
      true,
    );
    let callback = '';
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(ast) === 'workTimer' &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
      )
        callback = node.initializer.arguments[0].getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    const context: any = {
      failed: false,
      interrupted: false,
      report: jest.fn(),
      runnerStatus: jest.fn(),
    };
    context.interrupt = () => {
      context.interrupted = true;
    };
    runInNewContext(`(${callback})()`, context);
    expect(context.failed).toBe(true);
    expect(context.interrupted).toBe(true);
    expect(context.runnerStatus).toHaveBeenCalledWith('HARNESS_TIMEOUT');
    expect(context.runnerStatus).not.toHaveBeenCalledWith('HARNESS_PASS');
  });
  it.each([
    'success',
    'renamed',
    'drop-timeout',
    'drop-rejected',
    'lost-after-drop',
    'identity-unverified',
  ])('cleanup flow: %s', async (mode) => {
    const start = runner.indexOf('    if (created && adminConnected)');
    const end = runner.indexOf('    if (adminConnected)', start + 1);
    const block = runner.slice(start, end);
    const statuses: string[] = [];
    let dropSent = false;
    const admin = {
      query: async (sql: string) => {
        if (sql.startsWith('DROP DATABASE')) {
          dropSent = true;
          if (mode === 'drop-timeout') throw { safeCode: 'CLEANUP_TIMEOUT' };
          if (mode === 'drop-rejected') throw { code: '55006' };
        }
        if (sql.includes('FROM pg_catalog.pg_database')) {
          if (mode === 'lost-after-drop') throw { code: 'ECONNRESET' };
          return { rowCount: mode === 'renamed' ? 1 : 0 };
        }
        return { rowCount: 0 };
      },
    };
    const context: any = {
      created: true,
      adminConnected: true,
      admin,
      children: new Set(),
      writer: undefined,
      name: 'synthetic',
      oid: '42',
      stage: '',
      failed: false,
      cleanupPassed: false,
      quote: (s: string) => `"${s}"`,
      assertCluster: async () => {},
      assertOwned: async () => {
        if (mode === 'identity-unverified') throw Error('UNVERIFIED');
      },
      cleanupDeadline: async (fn) => fn(),
      runnerStatus: (status: string) => statuses.push(status),
      report: () => {},
      console: { log() {}, error() {} },
    };
    const code =
      runnerFunctions('requireCondition', 'verifyDatabaseDropped') +
      `\n(async()=>{${block};return{failed,cleanupPassed}})()`;
    const result = await runInNewContext(code, context);
    expect(result.cleanupPassed).toBe(mode === 'success');
    expect(result.failed).toBe(mode !== 'success');
    if (mode === 'success') expect(statuses).toContain('CLEANUP_PASS');
    else expect(statuses).not.toContain('CLEANUP_PASS');
    if (['renamed', 'drop-timeout', 'lost-after-drop'].includes(mode))
      expect(statuses).toContain('DROP_OUTCOME_UNKNOWN');
    if (mode === 'identity-unverified') expect(dropSent).toBe(false);
  });
  it('keeps identity guards and requires OID postcheck before cleanup PASS', () => {
    const drop = runner.indexOf('await cleanupClient.query(`DROP DATABASE');
    const postcheck = runner.indexOf(
      'await verifyDatabaseDropped(cleanupClient, name, oid, assertCluster)',
      drop,
    );
    const pass = runner.indexOf('cleanupPassed = true', drop);
    expect(postcheck).toBeGreaterThan(drop);
    expect(pass).toBeGreaterThan(postcheck);
    expect(runner).toContain(
      'row && row.oid === oid && row.owner === owner && row.marker === marker',
    );
    expect(runner).not.toMatch(
      /FORCE\s*DROP|WITH\s*\(\s*FORCE|pg_terminate_backend/,
    );
    expect(runner).toContain(
      "process.env.PAYMENT_SURPLUS_TEMP_ALLOW_RUN === 'YES'",
    );
    expect(runner).toContain("args[0] === '--write-tests'");
    expect(runner).toContain(
      'PAYMENT_SURPLUS_TEMP_WRITER_URL: tempUrl.toString()',
    );
    expect(spec).not.toMatch(
      /process\.env\.DATABASE_URL|AppModule|ScheduleModule/,
    );
  });
});
