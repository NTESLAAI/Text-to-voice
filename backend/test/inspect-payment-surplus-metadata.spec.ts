import { inspectMetadata } from './inspect-payment-surplus-metadata.cjs';
import {
  inspectSessions,
  compareSessionSnapshots,
} from './inspect-payment-surplus-sessions.cjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw =
  'postgresql://ttv_surplus_lifecycle:MOCK_ONLY@127.0.0.1:55432/postgres';
function fixtures() {
  return {
    identity: {
      role: 'ttv_surplus_lifecycle',
      session_role: 'ttv_surplus_lifecycle',
      db: 'postgres',
      host: '127.0.0.1',
      port: '55432',
      cluster: '7703979600700924132',
      directory: 'D:/text-to-voice/pg-test-cluster',
      session_ro: 'on',
      tx_ro: 'on',
      self_pid: '100',
      postmaster_start: '2026-11-04T00:00:00.123456Z',
      observed_at: '2026-11-04T01:00:00.123456Z',
    },
    roles: [
      'ttv_surplus_lifecycle',
      'ttv_surplus_writer',
      'ttv_surplus_reader',
    ].map((rolname, i) => ({
      oid: String(200 + i),
      rolname,
      rolcanlogin: true,
      rolcreatedb: i === 0,
      rolsuper: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolinherit: i !== 2,
      ...Object.fromEntries(
        ['stats', 'monitor', 'settings'].flatMap((prefix) =>
          ['member', 'usage', 'set'].map((option) => [
            `${prefix}_${option}`,
            false,
          ]),
        ),
      ),
    })),
    databases: [
      {
        datname: 'postgres',
        oid: '5',
        owner_oid: '10',
        owner: 'postgres',
        acl_default: true,
        writer_create: false,
        reader_create: false,
        marker: null,
      },
    ],
    acl: [
      {
        database_oid: '5',
        grantor_oid: '10',
        grantor: 'postgres',
        grantee_oid: '0',
        grantee: null,
        privilege_type: 'CONNECT',
        is_grantable: false,
      },
    ],
    sessions: [
      {
        pid: '100',
        database_oid: '5',
        role_oid: '200',
        backend_start: '2026-11-04T00:30:00.123456Z',
        datname: 'postgres',
        usename: 'ttv_surplus_lifecycle',
        application_name: 'ttv-surplus-session-inspection',
        client_addr: '127.0.0.1',
        backend_type: 'client backend',
        state: 'active',
        wait_event_type: null,
        wait_event: null,
        can_observe: true,
      },
    ],
  };
}
async function run(options: any = {}) {
  const data = fixtures();
  options.mutate?.(data);
  const statements: string[] = [];
  let connected = 0,
    closed = 0;
  class MockClient {
    errorHandler: () => void;
    handlers: any[] = [];
    constructor(config) {
      expect(config.connectionString).toBe(raw);
      expect(config.options).toContain('default_transaction_read_only=on');
      expect(config.query_timeout).toBe(5000);
    }
    on(_event, callback) {
      this.handlers.push(callback);
      this.errorHandler = () => this.handlers.forEach((cb) => cb());
    }
    async connect() {
      connected++;
      if (options.connectError) throw new Error(raw);
    }
    async query(sql: string) {
      if (
        sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
        sql === 'ROLLBACK'
      ) {
        statements.push(sql);
        if (
          (sql.startsWith('BEGIN') && options.beginError) ||
          (sql === 'ROLLBACK' && options.rollbackError)
        )
          throw new Error('MOCK_ONLY_TRANSACTION_FAILURE');
        return {};
      }
      const noLiterals = sql.replace(/'[^']*'/g, "''");
      expect(noLiterals).toMatch(/^SELECT\s/);
      expect(noLiterals).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COPY|CALL)\b/i,
      );
      expect(sql).not.toContain(';');
      expect(sql).not.toMatch(
        /\bquery\s*,|\bquery\s+AS|pg_terminate_backend|pg_cancel_backend/,
      );
      statements.push(sql);
      if (options.errorAt === statements.length)
        throw Object.assign(new Error(raw), { code: options.code });
      if (sql.includes('AS self_pid'))
        return { rows: options.emptyIdentity ? [] : [data.identity] };
      if (sql.includes('aclexplode')) return { rows: data.acl };
      if (sql.includes('FROM pg_catalog.pg_roles WHERE'))
        return { rows: data.roles };
      if (sql.includes('FROM pg_catalog.pg_database d ORDER'))
        return { rows: data.databases };
      if (sql.includes('FROM pg_catalog.pg_stat_activity')) {
        if (options.lost) this.errorHandler();
        return { rows: data.sessions };
      }
      throw new Error('UNEXPECTED_SQL');
    }
    async end() {
      closed++;
      if (options.closeError) throw new Error(raw);
    }
    unref() {}
  }
  const result = await (options.collector ?? inspectMetadata)(
    options.raw === undefined ? raw : options.raw,
    { Client: MockClient, aclMode: options.aclMode === true },
  );
  expect(JSON.stringify(result)).not.toContain('MOCK_ONLY');
  expect(JSON.stringify(result)).not.toContain('postgresql://');
  if (connected) expect(closed).toBe(1);
  return { result, statements, connected };
}
describe('Read-only TEST metadata inspector (injected clients only)', () => {
  function scopedCollector(blocked = false) {
    let collector: any;
    jest.isolateModules(() => {
      jest.doMock('./inspect-payment-surplus-acl.cjs', () => ({
        inspectAcl: jest.fn(async (_query, roles, transaction) => {
          expect(transaction).toEqual({
            owner: 'METADATA_CLIENT',
            backendPid: '100',
          });
          return {
            status: 'VERIFIED',
            snapshotMatched: true,
            database_oid: '5',
            objects: {
              roles: roles.map((r) => ({ role_oid: r.oid })),
              databases: [{ effective_temp: blocked }],
              schemas: [],
              relations: [],
              sequences: [],
              definers: [],
            },
          };
        }),
      }));
      collector =
        require('./inspect-payment-surplus-metadata.cjs').collectPreflightMetadata;
    });
    jest.dontMock('./inspect-payment-surplus-acl.cjs');
    return collector;
  }
  it('scoped metadata proof does not upgrade the independent inspector session result', async () => {
    const collector = scopedCollector();
    const r = await run({
      collector,
      mutate: (d) => {
        d.sessions[0].can_observe = false;
      },
    });
    expect(r.result.verification).toBe('VERIFIED');
    expect(r.result.scope).toBe('POSTGRES_ACL_AND_CLUSTER_DATABASES');
    expect(r.result).not.toHaveProperty('readiness');
    expect(r.result).not.toHaveProperty('sessions');
    expect(r.statements[0]).toContain('REPEATABLE READ READ ONLY');
    expect(r.statements.at(-1)).toBe('ROLLBACK');
    const standalone = await run({
      mutate: (d) => {
        d.sessions[0].can_observe = false;
      },
    });
    expect(standalone.result.verification).toBe('UNKNOWN');
    expect(standalone.result.readiness).toBe('NOT_READY');
  });
  it('scoped metadata preserves every technical blocker', async () => {
    const r = await run({
      collector: scopedCollector(true),
      mutate: (d) => {
        d.databases[0].writer_create = true;
      },
    });
    expect(r.result.blockers).toEqual(
      expect.arrayContaining([
        'ACL_TEMP_PRIVILEGE_PRESENT',
        'TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE',
      ]),
    );
  });
  it.each([
    'beginError',
    'rollbackError',
    'closeError',
    'connectError',
    'lost',
  ])('scoped proof fails closed on %s', async (field) => {
    const r = await run({ collector: scopedCollector(), [field]: true });
    expect(r.result.verification).toBe('UNKNOWN');
    expect(r.result.blockers).toEqual(['METADATA_UNVERIFIED']);
  });
  it('scoped proof rejects identity and catalog errors without exposing values', async () => {
    const collector = scopedCollector();
    expect(
      (
        await run({
          collector,
          mutate: (d) => {
            d.identity.cluster = 'WRONG';
          },
        })
      ).result.verification,
    ).toBe('UNKNOWN');
    expect(
      (await run({ collector, errorAt: 3, code: '42501' })).result.verification,
    ).toBe('UNKNOWN');
  });
  it('ACL BEGIN thuoc client moi, loi BEGIN khong doc catalog', async () => {
    const r = await run({ aclMode: true, beginError: true });
    expect(r.result.verification).toBe('UNKNOWN');
    expect(r.result.checks).toBeNull();
    expect(r.result.code).toBe('ACL_TRANSACTION_INVALID');
    expect(r.result.warnings).toEqual([]);
    expect(r.statements).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    ]);
  });
  it('identity sai van rollback truoc khi dong, khong goi ACL', async () => {
    const r = await run({
      aclMode: true,
      mutate: (d) => (d.identity.cluster = 'WRONG'),
    });
    expect(r.result.verification).toBe('UNKNOWN');
    expect(r.result.checks).toBeNull();
    expect(r.statements[0]).toContain('BEGIN');
    expect(r.statements.at(-1)).toBe('ROLLBACK');
    expect(r.statements).toHaveLength(3);
  });
  it.each(['rollbackError', 'closeError'])(
    'loi %s khong xuat bang chung VERIFIED',
    async (field) => {
      const r = await run({
        aclMode: true,
        [field]: true,
        mutate: (d) => (d.identity.cluster = 'WRONG'),
      });
      expect(r.result.verification).toBe('UNKNOWN');
      expect(r.result.checks).toBeNull();
      expect(r.result.sessionCheck.status).toBe('UNKNOWN');
    },
  );
  it('loi catalog rollback mot lan va khong truy van tiep', async () => {
    const r = await run({ aclMode: true, errorAt: 3, code: '42501' });
    expect(r.result.verification).toBe('UNKNOWN');
    expect(r.result.checks).toBeNull();
    expect(r.statements.filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    expect(r.statements.at(-1)).toBe('ROLLBACK');
  });
  it('verifies metadata on the same identity-checked session, never authorizes execution', async () => {
    const { result, statements, connected } = await run();
    expect(connected).toBe(1);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toContain('AS self_pid');
    expect(result.verification).toBe('VERIFIED');
    expect(result.readiness).toBe('NOT_READY');
    expect(result).not.toHaveProperty('warnings');
    expect(result.blockers).toEqual(['EXCLUSIVE_OPERATION_NOT_CONFIRMED']);
    expect(result.metadata.acl[0]).toMatchObject({
      grantee: 'PUBLIC',
      privilege: 'CONNECT',
    });
    expect(result.metadata.orphan).toBe('ABSENT_AT_SNAPSHOT');
  });
  it.each([
    raw.replace(':55432/', ':5432/'),
    raw.replace('127.0.0.1', 'localhost'),
    raw.replace('/postgres', '/text_to_voice'),
    raw + '?host=localhost',
    raw + '#fragment',
    raw.replace('ttv_surplus_lifecycle', 'postgres'),
    raw.replace(':MOCK_ONLY', ''),
    '',
    null,
  ])(
    'rejects invalid endpoint/credential shape without connecting',
    async (value) => {
      const { result, connected } = await run({ raw: value });
      expect(connected).toBe(0);
      expect(result.verification).toBe('UNKNOWN');
      expect(result.phase).toBe('URL_VALIDATION');
      expect(result.fields).toContain('url_format');
    },
  );
  it.each([
    'cluster',
    'directory',
    'port',
    'host',
    'db',
    'role',
    'session_role',
    'session_ro',
    'tx_ro',
  ])('stops before catalog reads on wrong %s', async (field) => {
    const { result, statements } = await run({
      mutate: (d) => {
        d.identity[field] = 'WRONG';
      },
    });
    expect(result.verification).toBe('UNKNOWN');
    expect(result.reason).toBe('IDENTITY_MISMATCH');
    const labels = {
      cluster: 'cluster_id',
      directory: 'data_directory',
      port: 'server_port',
      host: 'server_address',
      db: 'database',
      role: 'current_user',
      session_role: 'session_user',
      session_ro: 'session_read_only',
      tx_ro: 'transaction_read_only',
    };
    expect(result.phase).toBe('SERVER_IDENTITY');
    expect(result.fields).toContain(labels[field]);
    expect(JSON.stringify(result)).not.toContain('WRONG');
    expect(statements).toHaveLength(1);
  });
  it('URL diagnostics name the endpoint/credential field without printing values', async () => {
    for (const [input, field] of [
      [raw.replace(':55432/', ':5432/'), 'port'],
      [raw.replace('127.0.0.1', 'localhost'), 'host'],
      [raw.replace('/postgres', '/text_to_voice'), 'database'],
      [raw.replace('ttv_surplus_lifecycle', 'postgres'), 'username'],
      [raw.replace(':MOCK_ONLY', ''), 'credential_presence'],
      [raw.replace('MOCK_ONLY', '%XX'), 'url_encoding'],
    ]) {
      const { result } = await run({ raw: input });
      expect(result.fields).toContain(field);
      const json = JSON.stringify(result);
      expect(json).not.toContain(input);
      expect(json).not.toContain('ttv_surplus_lifecycle');
    }
  });
  it.each([null, 100, '0', 'not-a-pid'])(
    'invalid backend PID %p fails with a field label only',
    async (value) => {
      const { result, statements } = await run({
        mutate: (d) => {
          d.identity.self_pid = value;
        },
      });
      expect(result.phase).toBe('SERVER_IDENTITY');
      expect(result.fields).toContain('backend_pid');
      expect(statements).toHaveLength(1);
    },
  );
  it('empty identity result and simultaneous mismatches stay fail-closed', async () => {
    const empty = await run({ emptyIdentity: true });
    expect(empty.result.fields).toEqual(['identity_row']);
    const { result } = await run({
      mutate: (d) => {
        d.identity.cluster = 'SECRET_CLUSTER';
        d.identity.directory = 'SECRET_DIRECTORY';
        d.identity.role = 'SECRET_ROLE';
      },
    });
    expect(result.fields).toEqual(
      expect.arrayContaining([
        'current_user',
        'session_user',
        'cluster_id',
        'data_directory',
      ]),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /SECRET_CLUSTER|SECRET_DIRECTORY|SECRET_ROLE/,
    );
  });
  it('invalid mode and missing admin attribute have sanitized diagnostics', async () => {
    const Constructor = jest.fn();
    const invalid = await inspectSessions(raw, {
      Client: Constructor,
      mode: 'INVALID',
    });
    expect(Constructor).not.toHaveBeenCalled();
    expect(invalid.phase).toBe('URL_VALIDATION');
    expect(invalid.fields).toEqual(['mode']);
    class MockAdmin {
      on() {}
      async connect() {}
      async end() {}
      async query() {
        return {
          rows: [
            {
              ...fixtures().identity,
              role: 'postgres',
              session_role: 'postgres',
              is_superuser: 'off',
            },
          ],
        };
      }
    }
    const admin = await inspectSessions(
      raw.replace('ttv_surplus_lifecycle', 'postgres'),
      { Client: MockAdmin, mode: 'TEST_ADMIN' },
    );
    expect(admin.phase).toBe('SERVER_IDENTITY');
    expect(admin.fields).toEqual(['admin_attribute']);
    expect(JSON.stringify(admin)).not.toContain('postgres');
  });
  it.each(['writer_create', 'reader_create'])(
    'matches preflight CREATE blocker for %s',
    async (field) => {
      const { result } = await run({
        mutate: (d) => {
          d.databases[0][field] = true;
        },
      });
      expect(result.verification).toBe('VERIFIED');
      expect(result.blockers).toContain(
        'TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE',
      );
    },
  );
  it('reports the old database without treating marker format as proof of origin', async () => {
    const marker = `ttv-surplus-it:${'c'.repeat(64)}`;
    const { result } = await run({
      mutate: (d) => {
        d.databases.push({
          ...d.databases[0],
          datname: 'ttv_surplus_it_f646e091562849a38743a12b41e8ec2f',
          oid: '16393',
          owner: 'ttv_surplus_writer',
          owner_oid: '16389',
          writer_create: true,
          marker,
        });
      },
    });
    expect(result.metadata.orphan).toBe('IDENTITY_CHANGED_OR_UNVERIFIED');
    expect(result.metadata.origin).toBe('UNVERIFIED');
    expect(result.blockers).toContain(
      'TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE',
    );
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(result.metadata.databases[1].markerSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('detects orphan OID surviving under a different name', async () => {
    const { result } = await run({
      mutate: (d) => {
        d.databases.push({
          ...d.databases[0],
          datname: 'renamed',
          oid: '16393',
        });
      },
    });
    expect(result.metadata.orphan).toBe('IDENTITY_CHANGED_OR_UNVERIFIED');
  });
  it('redacts unrelated database/role names and raw comments', async () => {
    const { result } = await run({
      mutate: (d) => {
        Object.assign(d.databases[0], {
          datname: 'PRIVATE_NAME',
          owner: 'PRIVATE_OWNER',
          marker: 'PRIVATE_COMMENT',
        });
      },
    });
    const json = JSON.stringify(result);
    for (const s of ['PRIVATE_NAME', 'PRIVATE_OWNER', 'PRIVATE_COMMENT'])
      expect(json).not.toContain(s);
  });
  it('idle client is a blocker; unclassified backends are UNKNOWN, never safe', async () => {
    const { result } = await run({
      mutate: (d) => {
        d.sessions.push({ ...d.sessions[0], pid: '101', state: 'idle' });
        d.sessions.push({
          ...d.sessions[0],
          pid: '102',
          backend_type: null,
          can_observe: false,
        });
      },
    });
    expect(result.verification).toBe('UNKNOWN');
    expect(result.blockers).toContain('OTHER_CLIENT_SESSIONS_PRESENT');
    expect(result.blockers).toContain('UNCLASSIFIED_BACKENDS_PRESENT');
    expect(result.sessions.otherSessions).toBe('UNKNOWN');
  });
  it('masked observation remains UNKNOWN even for a named background', async () => {
    const { result } = await run({
      mutate: (d) => {
        d.sessions.push({
          ...d.sessions[0],
          pid: '101',
          backend_type: 'checkpointer',
          can_observe: false,
        });
      },
    });
    expect(result.verification).toBe('UNKNOWN');
  });
  it.each(['42501', '57014', 'ECONNRESET'])(
    'metadata error %s never reports VERIFIED',
    async (code) => {
      const { result } = await run({ errorAt: 3, code });
      expect(result.verification).toBe('UNKNOWN');
      expect(result.readiness).toBe('NOT_READY');
    },
  );
  it.each([{ connectError: true }, { lost: true }, { closeError: true }])(
    'fails closed and cleans connections on %p',
    async (options) => {
      expect((await run(options)).result.verification).toBe('UNKNOWN');
    },
  );
  it('missing roles or malformed effective privileges never become zero/false', async () => {
    expect(
      (await run({ mutate: (d) => d.roles.pop() })).result.verification,
    ).toBe('UNKNOWN');
    expect(
      (
        await run({
          mutate: (d) => {
            d.databases[0].reader_create = null;
          },
        })
      ).result.verification,
    ).toBe('UNKNOWN');
  });
  it('unsafe role attributes block readiness', async () => {
    const { result } = await run({
      mutate: (d) => {
        d.roles[1].rolsuper = true;
      },
    });
    expect(result.blockers).toContain('ROLE_ATTRIBUTES_UNSAFE');
  });
  it('reports MEMBER/USAGE/SET separately; non-inherited membership is not effective visibility', async () => {
    const { result } = await run({
      mutate: (d) => {
        Object.assign(d.roles[1], {
          stats_member: true,
          stats_usage: false,
          stats_set: true,
        });
      },
    });
    const writer = result.metadata.roles.find(
      (r) => r.name === 'ttv_surplus_writer',
    );
    expect(writer.observationRights.pg_read_all_stats).toEqual({
      MEMBER: true,
      USAGE: false,
      SET: true,
    });
    expect(writer.fullStatsEffective).toBe(false);
    expect(writer.observationRights.pg_read_all_settings).toEqual({
      MEMBER: false,
      USAGE: false,
      SET: false,
    });
  });
  it('effective statistics rights are reported without inferring visibility from membership', async () => {
    const { result } = await run({
      mutate: (d) => {
        Object.assign(d.roles[0], {
          stats_member: true,
          stats_usage: true,
          stats_set: false,
          monitor_member: true,
          monitor_usage: false,
          monitor_set: true,
        });
      },
    });
    expect(result.metadata.roles[0].fullStatsEffective).toBe(true);
    expect(result.metadata.roles[0].observationRights.pg_monitor.USAGE).toBe(
      false,
    );
  });
  it('masked permission booleans cannot become false', async () => {
    const { result } = await run({
      mutate: (d) => {
        d.roles[0].stats_usage = null;
      },
    });
    expect(result.verification).toBe('UNKNOWN');
    expect(result.metadata).toBeNull();
  });
  it('preserves backend OIDs and full timestamp precision in its identity', async () => {
    const { result } = await run();
    const row = result.sessions.sessions[0];
    expect(row.database_oid).toBe('5');
    expect(row.role_oid).toBe('200');
    expect(row.backend_start).toBe('2026-11-04T00:30:00.123456Z');
    expect(row.backendIdentity).toContain('|2026-11-04T00:30:00.123456Z');
  });
  it.each(['backend_start', 'role_oid', 'database_oid'])(
    'incomplete client %s remains UNKNOWN',
    async (field) => {
      const { result } = await run({
        mutate: (d) => {
          d.sessions.push({ ...d.sessions[0], pid: '101', [field]: null });
        },
      });
      expect(result.verification).toBe('UNKNOWN');
      expect(result.sessions.sessions[1].classification).toBe('UNCLASSIFIED');
      expect(result.sessions.sessions[1].backendIdentity).toBeNull();
      expect(result.blockers).toContain('UNCLASSIFIED_BACKENDS_PRESENT');
    },
  );
  it('explicit backend type without observation rights never becomes verified background', async () => {
    const { result } = await run({
      mutate: (d) => {
        d.sessions.push({
          ...d.sessions[0],
          pid: '101',
          backend_type: 'checkpointer',
          can_observe: false,
        });
      },
    });
    expect(result.sessions.sessions[1].classification).toBe('UNCLASSIFIED');
    expect(result.sessions.verifiedOtherBackgrounds).toBe(0);
  });
  it('compares snapshots without treating vanished or reused PIDs as safe', async () => {
    const before = (await run()).result.sessions;
    expect(compareSessionSnapshots(before, before).backends[0].status).toBe(
      'SAME_BACKEND',
    );
    const after = JSON.parse(JSON.stringify(before));
    after.sessions[0].backend_start = '2026-11-04T00:45:00.123456Z';
    after.sessions[0].backendIdentity =
      after.sessions[0].backendIdentity.replace('00:30:00', '00:45:00');
    expect(compareSessionSnapshots(before, after).backends[0].status).toBe(
      'PID_REUSED',
    );
    after.sessions = [];
    expect(compareSessionSnapshots(before, after).backends[0].status).toBe(
      'NOT_OBSERVED_LATER',
    );
    after.sessions = [
      { ...before.sessions[0], backend_start: null, backendIdentity: null },
    ];
    expect(compareSessionSnapshots(before, after).backends[0].status).toBe(
      'IDENTITY_UNKNOWN',
    );
    after.cluster = 'different';
    expect(compareSessionSnapshots(before, after).status).toBe(
      'SNAPSHOT_SCOPE_UNKNOWN',
    );
  });
  it('wrapper reuses the hidden prompt, isolates environment and never invokes runner', () => {
    const ps = readFileSync(
      join(__dirname, 'inspect-payment-surplus-metadata.ps1'),
      'utf8',
    );
    expect(ps).toContain("Read-SurplusSecretUrl 'ttv_surplus_lifecycle'");
    expect(ps).toContain('$info.EnvironmentVariables.Clear()');
    expect(ps).toContain('$raw=$null');
    expect(ps).not.toMatch(
      /-RunHarness|ALLOW_RUN|DATABASE_URL|\.env|Invoke-SurplusSecurePreparation/,
    );
    expect(ps).toContain('inspect-payment-surplus-metadata.cjs');
    expect(ps).not.toContain('Write-Output $raw');
  });
});
