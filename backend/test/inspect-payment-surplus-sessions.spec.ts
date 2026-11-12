import { inspectSessions } from './inspect-payment-surplus-sessions.cjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// All credentials and PostgreSQL responses below are mock data only.
const roleFor = (mode: string) =>
  mode === 'TEST_ADMIN'
    ? 'postgres'
    : mode === 'OBSERVER'
      ? 'ttv_surplus_observer'
      : 'ttv_surplus_lifecycle';

async function run(options: any = {}) {
  const mode = options.mode ?? 'OBSERVER';
  const role = roleFor(mode);
  const url = `postgresql://${role}:MOCK_SENTINEL@127.0.0.1:55432/postgres`;
  const identity: any = {
    role,
    session_role: role,
    db: 'postgres',
    host: '127.0.0.1',
    port: '55432',
    cluster: '7703979600700924132',
    directory: 'D:/text-to-voice/pg-test-cluster',
    is_superuser: 'on',
    session_ro: 'on',
    tx_ro: 'on',
    self_pid: '100',
    postmaster_start: '2026-11-04T00:00:00.123456Z',
    observed_at: '2026-11-04T01:00:00.123456Z',
    ...options.identity,
  };
  const self = {
    pid: '100',
    database_oid: '5',
    role_oid: '200',
    backend_start: '2026-11-04T00:30:00.123456Z',
    datname: 'postgres',
    usename: role,
    application_name: 'ttv-surplus-session-inspection',
    client_addr: '127.0.0.1',
    backend_type: 'client backend',
    state: 'active',
    wait_event_type: null,
    wait_event: null,
    can_observe: true,
  };
  const statements: string[] = [];
  let connected = 0,
    closed = 0;
  let onError = () => {};
  class MockClient {
    constructor(config: any) {
      expect(config.options).toContain('default_transaction_read_only=on');
      expect(config.connectionTimeoutMillis).toBe(5000);
      expect(config.query_timeout).toBe(5000);
    }
    on(_event: string, callback: () => void) {
      onError = callback;
    }
    async connect() {
      connected++;
      if (options.connectError) throw new Error(url);
    }
    async query(sql: string) {
      statements.push(sql);
      expect(sql).toMatch(/^SELECT /);
      expect(sql).not.toMatch(
        /;|\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|COPY|CALL)\b/i,
      );
      expect(sql).not.toMatch(
        /pg_terminate_backend|pg_cancel_backend|\bquery\s*(?:,|AS)/i,
      );
      if (options.errorAt === statements.length)
        throw Object.assign(new Error(url), { code: options.errorCode });
      if (sql.includes('AS self_pid')) return { rows: [identity] };
      if (sql.includes('AS stats_usage'))
        return { rows: options.visibilityRows ?? [{ stats_usage: true }] };
      if (sql.includes('pg_stat_activity')) {
        if (options.lost) onError();
        return { rows: [self, ...(options.extraRows ?? [])] };
      }
      throw new Error('UNEXPECTED_MOCK_SQL');
    }
    async end() {
      closed++;
      if (options.closeTimeout) return new Promise<void>(() => {});
      if (options.closeError) throw new Error(url);
    }
    unref() {}
  }
  const result = await inspectSessions(options.url ?? url, {
    Client: MockClient,
    ...(options.defaultMode ? {} : { mode }),
  });
  expect(JSON.stringify(result)).not.toMatch(/MOCK_SENTINEL|postgresql:\/\//);
  if (connected) expect(closed).toBe(1);
  return { result, statements, connected };
}

describe('Session Inspector: injected mock Client only, no database', () => {
  it.each(['OBSERVER', 'LIFECYCLE', 'TEST_ADMIN'])(
    'accepts %s without changing classification',
    async (mode) => {
      const { result, statements } = await run({ mode });
      expect(result.status).toBe('PASS');
      expect(result.sessions[0].classification).toBe('SELF');
      expect(result.sessions[0].usename).toBe(roleFor(mode));
      expect(statements).toHaveLength(mode === 'OBSERVER' ? 3 : 2);
      expect(result).not.toHaveProperty('readiness');
    },
  );
  it('keeps LIFECYCLE as default', async () => {
    expect(
      (await run({ mode: 'LIFECYCLE', defaultMode: true })).result.status,
    ).toBe('PASS');
  });
  it.each([
    'postgresql://ttv_surplus_observer:MOCK_SENTINEL@127.0.0.1:5432/postgres',
    'postgresql://ttv_surplus_observer:MOCK_SENTINEL@localhost:55432/postgres',
    'postgresql://ttv_surplus_observer:MOCK_SENTINEL@127.0.0.1:55432/text_to_voice',
    'postgresql://ttv_surplus_lifecycle:MOCK_SENTINEL@127.0.0.1:55432/postgres',
    'postgresql://postgres:MOCK_SENTINEL@127.0.0.1:55432/postgres',
    'postgresql://ttv_surplus_observer@127.0.0.1:55432/postgres',
    'postgresql://ttv_surplus_observer:MOCK_SENTINEL@127.0.0.1:55432/postgres?host=elsewhere',
  ])('rejects wrong URL before constructing a connection', async (url) => {
    const r = await run({ url });
    expect(r.connected).toBe(0);
    expect(r.result.phase).toBe('URL_VALIDATION');
  });
  it('rejects invalid mode without connecting', async () => {
    const r = await run({ mode: 'INVALID' });
    expect(r.connected).toBe(0);
    expect(r.result.fields).toEqual(['mode']);
  });
  it.each([
    'role',
    'session_role',
    'db',
    'host',
    'port',
    'cluster',
    'directory',
    'session_ro',
    'tx_ro',
    'self_pid',
  ])(
    'rejects wrong identity %s before checking rights or sessions',
    async (field) => {
      const r = await run({ identity: { [field]: 'INVALID' } });
      expect(r.result.reason).toBe('IDENTITY_MISMATCH');
      expect(r.statements).toHaveLength(1);
    },
  );
  it('retains TEST_ADMIN superuser guard', async () => {
    const r = await run({
      mode: 'TEST_ADMIN',
      identity: { is_superuser: 'off' },
    });
    expect(r.result.fields).toEqual(['admin_attribute']);
  });
  it('does not require observer to be superuser', async () => {
    expect(
      (await run({ identity: { is_superuser: 'off' } })).result.status,
    ).toBe('PASS');
  });
  it.each([false, null, 'true', undefined])(
    'fails closed on stats USAGE=%p',
    async (stats_usage) => {
      const r = await run({ visibilityRows: [{ stats_usage }] });
      expect(r.result.status).toBe('UNKNOWN');
      expect(r.result.reason).toBe(
        stats_usage === false ? 'INSUFFICIENT_PRIVILEGE' : 'INVALID_METADATA',
      );
      expect(r.statements).toHaveLength(2);
    },
  );
  it.each([
    { visibilityRows: [] },
    { visibilityRows: [{ stats_usage: true }, { stats_usage: true }] },
  ])(
    'rejects incomplete or duplicate rights rows',
    async ({ visibilityRows }) => {
      expect((await run({ visibilityRows })).result.reason).toBe(
        'INVALID_METADATA',
      );
    },
  );
  it.each([1, 2, 3])(
    'metadata privilege error at query %s stays UNKNOWN',
    async (errorAt) => {
      const r = await run({ errorAt, errorCode: '42501' });
      expect(r.result.reason).toBe('INSUFFICIENT_PRIVILEGE');
      expect(r.statements).toHaveLength(errorAt);
    },
  );
  it.each(['57014', 'ETIMEDOUT', 'ECONNRESET'])(
    'sanitizes timeout/connection error %s',
    async (errorCode) => {
      const r = await run({ errorAt: 2, errorCode });
      expect(r.result.status).toBe('UNKNOWN');
      expect(r.statements).toHaveLength(2);
    },
  );
  it.each(['connectError', 'lost', 'closeError'])(
    'fails closed on %s and closes the mock',
    async (field) => {
      expect((await run({ [field]: true })).result.status).toBe('UNKNOWN');
    },
  );
  it('bounded close timeout never reports PASS', async () => {
    jest.useFakeTimers();
    try {
      const pending = run({ closeTimeout: true });
      await jest.advanceTimersByTimeAsync(3001);
      expect((await pending).result.reason).toBe('CONNECTION_CLOSE_FAILED');
    } finally {
      jest.useRealTimers();
    }
  });
  it('global rights do not turn masked metadata into background', async () => {
    const r = await run({
      extraRows: [{ pid: '101', backend_type: null, can_observe: false }],
    });
    expect(r.result.status).toBe('UNKNOWN');
    expect(r.result.unclassifiedOtherBackends).toBe(1);
    expect(r.result.sessions[1].classification).toBe('UNCLASSIFIED');
  });
  it('classifies complete background metadata without reading query text', async () => {
    const r = await run({
      extraRows: [
        {
          pid: '101',
          database_oid: null,
          role_oid: null,
          backend_start: '2026-11-04T00:30:00.123456Z',
          datname: null,
          usename: null,
          application_name: '',
          client_addr: null,
          backend_type: 'checkpointer',
          state: null,
          wait_event_type: 'Activity',
          wait_event: 'CheckpointerMain',
          can_observe: true,
        },
      ],
    });
    expect(r.result.verifiedOtherBackgrounds).toBe(1);
    expect(r.result.sessions[1].classification).toBe('VERIFIED_BACKGROUND');
  });
  it('wrapper opts in explicitly, rejects mode conflict before prompt, and retains secret handling', () => {
    const ps = readFileSync(
      join(__dirname, 'inspect-payment-surplus-sessions.ps1'),
      'utf8',
    );
    expect(ps).toContain('param([switch]$TestAdmin, [switch]$Observer)');
    expect(ps.indexOf("throw 'MODE_CONFLICT'")).toBeLessThan(
      ps.indexOf('Read-Host'),
    );
    expect(ps).toContain("elseif($Observer){'ttv_surplus_observer'}");
    expect(ps).toContain("elseif($Observer){'OBSERVER'}");
    expect(ps).toContain('-AsSecureString');
    expect(ps).toContain('$info.EnvironmentVariables.Clear()');
    expect(ps).toContain("@('SYSTEMROOT','WINDIR','PATH','TEMP','TMP')");
    expect(ps).toContain('$info.RedirectStandardError=$true');
    expect(ps).toContain('ZeroFreeBSTR');
    expect(ps).toContain('$secret.Dispose()');
    expect(ps).toContain('$raw=$null');
    expect(ps).not.toMatch(
      /Write-Output \$raw|DATABASE_URL|ALLOW_RUN|\.env|SET ROLE/,
    );
  });
});
