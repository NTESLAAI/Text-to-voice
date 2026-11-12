import { inspectAcl as inspectAclImpl } from './inspect-payment-surplus-acl.cjs';
const inspectAcl = (query, roles) =>
  inspectAclImpl(query, roles, { owner: 'METADATA_CLIENT', backendPid: '100' });
import {
  inspectMetadata,
  classifyAclWrites,
} from './inspect-payment-surplus-metadata.cjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const names = [
  'ttv_surplus_lifecycle',
  'ttv_surplus_writer',
  'ttv_surplus_reader',
];
const roles = names.map((rolname, i) => ({ rolname, oid: String(200 + i) }));
function data() {
  const inventory = {
    correct_database: true,
    database_oid: '5',
    current_role_oid: '200',
    roots: '3',
    all_roles: '5',
    schemas: '1',
    relations: '1',
    sequences: '1',
    edges: '1',
    definers: '1',
    evidence_targets: '1',
    evidence_grants: '1',
  };
  const common = (role_oid, object_oid) => ({
    role_oid,
    object_oid,
    owner_oid: '10',
    schema_oid: '11',
    default_acl: true,
    effective_execute: true,
    schema_usage: true,
    public_execute: true,
    effective_connect: true,
    effective_create: false,
    effective_temp: true,
    public_connect: true,
    public_create: false,
    public_temp: true,
    owner_usage: false,
    owner_set: false,
    effective_usage: false,
    public_usage: true,
    effective_update: false,
    table_insert: false,
    table_update: true,
    table_delete: false,
    table_truncate: false,
    table_references: false,
    table_trigger: false,
    table_maintain: false,
    column_insert: false,
    column_update: true,
    internal_acl: 'PRIVATE_ACL_TEXT',
    internal_column_acl: 'PRIVATE_COLUMN_ACL',
  });
  const tables: any = {
    inventory: [inventory],
    roles: roles.map((r) => ({
      ...common(r.oid, r.oid),
      internal_name: r.rolname,
      login: true,
      inherit: true,
      superuser: false,
      create_database: r.oid === '200',
      create_role: false,
      replication: false,
      bypass_rls: false,
      stats_member: false,
      stats_usage: false,
      stats_set: false,
      settings_usage: false,
    })),
    functions: roles.flatMap((r) =>
      ['1000', '1001', '1002'].map((o) => common(r.oid, o)),
    ),
    databases: roles.map((r) => common(r.oid, '5')),
    schemas: roles.map((r) => common(r.oid, '11')),
    memberships: roles.flatMap((r) =>
      ['10', '200', '201', '202', '900'].map((o) => ({
        ...common(r.oid, o),
        member: r.oid === o,
        usage: r.oid === o,
        settable: r.oid === o,
      })),
    ),
    edges: [
      {
        role_oid: '201',
        object_oid: '900',
        grantor_oid: '10',
        admin: false,
        inherit: false,
        settable: true,
      },
    ],
    relations: roles.map((r) => common(r.oid, '12')),
    sequences: roles.map((r) => common(r.oid, '13')),
    definers: roles.map((r) => common(r.oid, '14')),
    transaction: [
      {
        isolation: 'repeatable read',
        read_only: 'on',
        default_read_only: 'on',
        backend_pid: '100',
        snapshot: '100:101:',
        correct_database: true,
        database_oid: '5',
        current_role_oid: '200',
      },
    ],
    evidence_target: [
      {
        object_oid: '12',
        schema_oid: '11',
        schema_name: 'pg_catalog',
        relation_name: 'pg_settings',
        relkind: 'v',
        owner_oid: '10',
      },
    ],
    evidence_grants: [
      {
        scope: 'RELATION',
        attnum: 0,
        grantor_oid: '10',
        grantee_oid: '0',
        grantable: false,
      },
    ],
    evidence_roles: roles.map((r) => ({
      role_oid: r.oid,
      write_all_usage: false,
      write_all_set: false,
    })),
  };
  return tables;
}
function category(sql: string) {
  if (sql.includes("current_setting('transaction_isolation')"))
    return 'transaction';
  if (sql.includes(' AS current_role_oid')) return 'inventory';
  if (sql.includes(' AS relation_name')) return 'evidence_target';
  if (sql.startsWith("SELECT 'RELATION'::text AS scope"))
    return 'evidence_grants';
  if (sql.includes(' AS write_all_usage')) return 'evidence_roles';
  if (sql.includes(' AS internal_name')) return 'roles';
  if (sql.includes('to_regprocedure')) return 'functions';
  if (sql.includes('CROSS JOIN pg_catalog.pg_database')) return 'databases';
  if (sql.includes('CROSS JOIN pg_catalog.pg_namespace')) return 'schemas';
  if (sql.includes('CROSS JOIN pg_catalog.pg_roles t')) return 'memberships';
  if (sql.includes('FROM pg_catalog.pg_auth_members ORDER')) return 'edges';
  if (sql.includes('has_any_column_privilege')) return 'relations';
  if (sql.includes('has_sequence_privilege')) return 'sequences';
  if (sql.includes('p.prosecdef')) return 'definers';
  throw Error('UNKNOWN_FIXED_QUERY');
}
function mock(tables: any, options: any = {}) {
  const calls: Record<string, number> = {};
  const statements: string[] = [];
  const query = jest.fn(async (sql: string) => {
    expect(sql).toMatch(/^SELECT\s/);
    expect(sql).not.toContain(';');
    expect(sql.replace(/'[^']*'/g, "''")).not.toMatch(
      /\b(?:CREATE|DROP|INSERT|UPDATE|DELETE|ALTER|GRANT|REVOKE|TRUNCATE|COPY|CALL)\b/i,
    );
    expect(sql).not.toMatch(
      /prosrc|proconfig|proargdefaults|pg_get_functiondef|rolpassword|rolconfig|pg_terminate_backend/,
    );
    statements.push(sql);
    const key = category(sql);
    calls[key] = (calls[key] ?? 0) + 1;
    if (options.error === key)
      throw Object.assign(new Error('MOCK_SECRET_MUST_NOT_LEAK'), {
        code: '42501',
      });
    const rows = JSON.parse(JSON.stringify(tables[key]));
    options.change?.(key, calls[key], rows);
    return { rows };
  });
  return { query, calls, statements };
}
describe('ACL inspection fixed SELECTs (mock only)', () => {
  it('checks default ACL and PUBLIC using server acldefault, filters output by schema', async () => {
    const m = mock(data());
    const result = await inspectAcl(m.query, roles);
    expect(result.status).toBe('VERIFIED');
    expect(result.counts.functions).toBe(9);
    expect(result.objects.databases[0]).toMatchObject({
      default_acl: true,
      public_connect: true,
      public_temp: true,
    });
    expect(
      m.statements.some((s) => s.includes("acldefault('d',d.datdba)")),
    ).toBe(true);
    expect(
      m.statements.some((s) => s.includes("acldefault('f',p.proowner)")),
    ).toBe(true);
    expect(
      m.statements.some((s) => s.includes("acldefault('n',n.nspowner)")),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_|ttv_surplus_|internal_/,
    );
    for (const n of Object.values(m.calls)) expect(n).toBe(2);
  });
  it('preserves non-inherited membership and SET-only access as separate booleans', async () => {
    const d = data();
    Object.assign(d.memberships[3], {
      member: true,
      usage: false,
      settable: true,
    });
    const result = await inspectAcl(mock(d).query, roles);
    expect(result.objects.memberships[3]).toMatchObject({
      member: true,
      usage: false,
      settable: true,
    });
  });
  it('detects column-only writes without table-wide privileges', async () => {
    const d = data();
    d.relations.forEach((r) => {
      r.table_update = false;
      r.column_update = false;
    });
    d.evidence_grants = [
      {
        scope: 'COLUMN',
        attnum: 1,
        grantor_oid: '10',
        grantee_oid: '200',
        grantable: false,
      },
    ];
    d.relations[0].column_update = true;
    const r = await inspectAcl(mock(d).query, roles);
    expect(r.objects.relations[0]).toMatchObject({
      column_update: true,
      table_update: false,
    });
  });
  it('reports schema ownership and effective CREATE independently', async () => {
    const d = data();
    Object.assign(d.schemas[0], { owner_usage: true, effective_create: true });
    expect(
      (await inspectAcl(mock(d).query, roles)).objects.schemas[0],
    ).toMatchObject({ owner_usage: true, effective_create: true });
  });
  it('lists public-executable definers by OID, never invokes audited routines', async () => {
    const m = mock(data());
    const r = await inspectAcl(m.query, roles);
    expect(r.objects.definers).toHaveLength(3);
    expect(r.objects.definers[0].objectType).toBe('SECURITY_DEFINER');
    expect(
      m.statements.filter((s) => s.includes('p.prosecdef')),
    ).not.toHaveLength(0);
    expect(m.statements.join('\n')).not.toMatch(
      /SELECT\s+(?:public|custom_schema)\./,
    );
  });
  it.each(['object_oid', 'owner_oid', 'effective_execute', 'public_execute'])(
    'missing function field %s fails closed',
    async (field) => {
      const d = data();
      d.functions[0][field] = null;
      await expect(inspectAcl(mock(d).query, roles)).rejects.toHaveProperty(
        'safeReason',
      );
    },
  );
  it.each([
    'inventory',
    'roles',
    'functions',
    'databases',
    'schemas',
    'memberships',
    'edges',
    'relations',
    'sequences',
    'definers',
  ])(
    'catalog error in %s propagates without false verification',
    async (key) => {
      await expect(
        inspectAcl(mock(data(), { error: key }).query, roles),
      ).rejects.toHaveProperty('code', '42501');
    },
  );
  it.each([
    'roles',
    'functions',
    'databases',
    'schemas',
    'memberships',
    'edges',
    'relations',
    'sequences',
    'definers',
  ])('missing rows in %s are UNKNOWN candidates', async (key) => {
    const d = data();
    d[key].pop();
    await expect(inspectAcl(mock(d).query, roles)).rejects.toHaveProperty(
      'safeReason',
      'ACL_INCOMPLETE_RESULT',
    );
  });
  it('rejects duplicate rows and wrong role OIDs', async () => {
    const d = data();
    d.functions[1] = { ...d.functions[0] };
    await expect(inspectAcl(mock(d).query, roles)).rejects.toHaveProperty(
      'safeReason',
    );
    const wrong = data();
    wrong.roles[0].role_oid = '999';
    await expect(inspectAcl(mock(wrong).query, roles)).rejects.toHaveProperty(
      'safeReason',
      'ACL_ROLE_OID_MISMATCH',
    );
  });
  it('detects ACL, role and inventory changes between samples', async () => {
    for (const key of ['roles', 'schemas', 'inventory']) {
      await expect(
        inspectAcl(
          mock(data(), {
            change: (c, n, rows) => {
              if (c === key && n === 2) {
                if (c === 'inventory') rows[0].database_oid = '99';
                else rows[0].internal_acl = 'CHANGED_PRIVATE_ACL';
              }
            },
          }).query,
          roles,
        ),
      ).rejects.toHaveProperty('safeReason', 'ACL_SNAPSHOT_CHANGED');
    }
  });
  it('allows empty optional categories only when independent counts are zero', async () => {
    const d = data();
    for (const key of ['edges', 'sequences', 'definers']) {
      d[key] = [];
      d.inventory[0][key] = '0';
    }
    expect((await inspectAcl(mock(d).query, roles)).counts.sequences).toBe(0);
  });
  it('rejects a changed maintenance database or mismatched database OID', async () => {
    const d = data();
    d.inventory[0].correct_database = false;
    await expect(inspectAcl(mock(d).query, roles)).rejects.toHaveProperty(
      'safeReason',
      'ACL_SCOPE_MISMATCH',
    );
    const other = data();
    other.databases[0].object_oid = '99';
    await expect(inspectAcl(mock(other).query, roles)).rejects.toHaveProperty(
      'safeReason',
      'ACL_SCOPE_MISMATCH',
    );
  });
  it.each([
    false,
    true,
    'rollback',
    'close',
    'lost',
    'begin',
    'begin-timeout',
    'rollback-timeout',
    'close-timeout',
    'warning',
  ])(
    'metadata integration filters ACL output, incomplete sessions=%s',
    async (incomplete) => {
      const fixture = data();
      if (incomplete === 'warning') {
        fixture.evidence_grants.push({
          scope: 'RELATION',
          attnum: 0,
          grantor_oid: '10',
          grantee_oid: '10',
          grantable: false,
        });
        fixture.inventory[0].evidence_grants = '2';
        fixture.relations.forEach((r) => (r.default_acl = false));
      }
      const m = mock(fixture);
      const lifecycle: string[] = [];
      class Client {
        handlers: any[] = [];
        on(_event, callback) {
          this.handlers.push(callback);
        }
        async connect() {
          lifecycle.push('CONNECT');
        }
        async end() {
          lifecycle.push('END');
          if (incomplete === 'close') throw Error('PRIVATE_CLOSE');
          if (incomplete === 'close-timeout') return new Promise(() => {});
        }
        async query(sql: string) {
          lifecycle.push(sql);
          if (
            sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
            sql === 'ROLLBACK'
          ) {
            if (
              (incomplete === 'rollback' && sql === 'ROLLBACK') ||
              (incomplete === 'begin' && sql.startsWith('BEGIN'))
            )
              throw Error('PRIVATE_TRANSACTION');
            if (
              (incomplete === 'rollback-timeout' && sql === 'ROLLBACK') ||
              (incomplete === 'begin-timeout' && sql.startsWith('BEGIN'))
            )
              return new Promise(() => {});
            return {};
          }
          if (sql.includes('AS self_pid'))
            return {
              rows: [
                {
                  role: names[0],
                  session_role: names[0],
                  db: 'postgres',
                  host: '127.0.0.1',
                  port: '55432',
                  cluster: '7703979600700924132',
                  directory: 'D:/text-to-voice/pg-test-cluster',
                  self_pid: '100',
                  session_ro: 'on',
                  tx_ro: 'on',
                  postmaster_start: '2026-11-04T00:00:00.000001Z',
                  observed_at: '2026-11-04T01:00:00.000001Z',
                },
              ],
            };
          if (sql.includes('FROM pg_catalog.pg_roles WHERE'))
            return {
              rows: roles.map((r) => ({
                ...r,
                rolcanlogin: true,
                rolcreatedb: r.oid === '200',
                rolsuper: false,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
                rolinherit: true,
                ...Object.fromEntries(
                  ['stats', 'monitor', 'settings'].flatMap((p) =>
                    ['member', 'usage', 'set'].map((o) => [`${p}_${o}`, false]),
                  ),
                ),
              })),
            };
          if (sql.includes('pg_get_userbyid'))
            return {
              rows: [
                {
                  datname: 'postgres',
                  oid: '5',
                  owner_oid: '10',
                  owner: 'postgres',
                  acl_default: true,
                  writer_create: incomplete === 'warning',
                  reader_create: false,
                  marker: 'PRIVATE_MARKER',
                },
              ],
            };
          if (sql.includes('LEFT JOIN pg_catalog.pg_roles g'))
            return { rows: [] };
          if (sql.includes('FROM pg_catalog.pg_stat_activity')) {
            if (incomplete === 'lost') this.handlers.forEach((cb) => cb());
            return {
              rows: [
                {
                  pid: '100',
                  database_oid: '5',
                  role_oid: '200',
                  backend_start: '2026-11-04T00:10:00.000001Z',
                  datname: 'postgres',
                  usename: names[0],
                  application_name: '',
                  client_addr: '127.0.0.1',
                  backend_type: 'client backend',
                  state: 'active',
                  wait_event_type: null,
                  wait_event: null,
                  can_observe: incomplete !== true,
                },
              ],
            };
          }
          return m.query(sql);
        }
      }
      const timing =
        typeof incomplete === 'string' && incomplete.endsWith('-timeout');
      if (timing) jest.useFakeTimers();
      let result;
      try {
        const pending = inspectMetadata(
          'postgresql://ttv_surplus_lifecycle:MOCK_ONLY@127.0.0.1:55432/postgres',
          { Client, aclMode: true },
        );
        if (timing) await jest.runAllTimersAsync();
        result = await pending;
      } finally {
        if (timing) jest.useRealTimers();
      }
      const failed = typeof incomplete === 'string' && incomplete !== 'warning';
      expect(result.verification).toBe(
        incomplete === true || failed ? 'UNKNOWN' : 'VERIFIED',
      );
      expect(result.readiness).toBe('NOT_READY');
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE_|MOCK_ONLY|ttv_surplus_|postgresql|marker|backend_start|application_name/,
      );
      if (failed) {
        expect(result.checks).toBeNull();
        expect(result.sessionCheck.status).toBe('UNKNOWN');
      } else
        expect(result.blockers).toContain(
          'PUBLIC_SECURITY_DEFINER_REVIEW_REQUIRED',
        );
      if (incomplete === true || failed)
        expect(result.sessionCheck.status).toBe('UNKNOWN');
      if (incomplete === 'warning') {
        expect(result.warnings).toHaveLength(1);
        expect(result.blockers).not.toContain('ACL_WRITE_CAPABILITIES_PRESENT');
        expect(result.blockers).toEqual(
          expect.arrayContaining([
            'EXCLUSIVE_OPERATION_NOT_CONFIRMED',
            'TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE',
            'ACL_TEMP_PRIVILEGE_PRESENT',
            'PUBLIC_SECURITY_DEFINER_REVIEW_REQUIRED',
          ]),
        );
      }
      expect(lifecycle[0]).toBe('CONNECT');
      expect(lifecycle[1]).toBe(
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      expect(lifecycle.at(-1)).toBe('END');
      expect(lifecycle.filter((s) => s.startsWith('BEGIN'))).toHaveLength(1);
      if (incomplete !== 'begin' && incomplete !== 'begin-timeout')
        expect(lifecycle.filter((s) => s === 'ROLLBACK')).toHaveLength(1);
    },
  );
  it('thu thap pg_settings va PUBLIC UPDATE nhung van giu du inventory', async () => {
    const d = data();
    const r = await inspectAcl(mock(d).query, roles);
    expect(r.evidence.identity).toMatchObject({
      schema_name: 'pg_catalog',
      relation_name: 'pg_settings',
      relkind: 'v',
      object_oid: '12',
    });
    expect(r.evidence.transaction).toEqual({
      owner: 'METADATA_CLIENT',
      isolation: 'repeatable read',
      readOnly: true,
      sameSnapshot: true,
    });
    expect(r.evidence.paths).toHaveLength(3);
    expect(
      r.evidence.paths.every(
        (p) => p.public && !p.direct && !p.inherited && !p.settable,
      ),
    ).toBe(true);
    expect(r.objects.relations).toHaveLength(3);
    expect(r.objects.sequences).toHaveLength(3);
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE_|internal_|MOCK_ONLY/);
  });
  it.each([
    'schema_name',
    'relation_name',
    'relkind',
    'owner_oid',
    'schema_oid',
  ])('bang chung sai %s phai fail-closed', async (field) => {
    const d = data();
    d.evidence_target[0][field] = field.endsWith('oid') ? '999' : 'WRONG';
    await expect(inspectAcl(mock(d).query, roles)).rejects.toHaveProperty(
      'safeReason',
      'ACL_EVIDENCE_INVALID',
    );
  });
  it.each([
    'direct',
    'inherited',
    'settable',
    'ownership',
    'owner_set',
    'column',
    'grant_option',
    'public_plus',
    'wide',
  ])('phan biet nguon quyen %s khong mien tru', async (mode) => {
    const d = data();
    if (mode === 'direct') {
      d.evidence_grants[0].grantee_oid = '200';
      d.relations.forEach((r) => {
        r.table_update = r.role_oid === '200';
        r.column_update = r.table_update;
      });
    }
    if (mode === 'inherited' || mode === 'settable' || mode === 'public_plus') {
      const g = {
        scope: 'RELATION',
        attnum: 0,
        grantor_oid: '10',
        grantee_oid: '900',
        grantable: false,
      };
      if (mode === 'public_plus') {
        d.evidence_grants.push(g);
        d.inventory[0].evidence_grants = '2';
      } else d.evidence_grants = [g];
      Object.assign(
        d.memberships.find(
          (m) => m.role_oid === '200' && m.object_oid === '900',
        ),
        { member: true, usage: mode !== 'settable', settable: true },
      );
      if (mode !== 'public_plus')
        d.relations.forEach((r) => {
          r.table_update = r.role_oid === '200' && mode === 'inherited';
          r.column_update = r.table_update;
        });
    }
    if (mode === 'ownership' || mode === 'owner_set') {
      Object.assign(
        d.memberships.find(
          (m) => m.role_oid === '200' && m.object_oid === '10',
        ),
        { member: true, usage: mode === 'ownership', settable: true },
      );
      d.relations[0].owner_usage = mode === 'ownership';
      d.relations[0].owner_set = true;
    }
    if (mode === 'column') {
      Object.assign(d.evidence_grants[0], { scope: 'COLUMN', attnum: 1 });
      d.relations.forEach((r) => (r.table_update = false));
    }
    if (mode === 'grant_option') d.evidence_grants[0].grantable = true;
    if (mode === 'wide')
      d.evidence_roles[0].write_all_usage =
        d.evidence_roles[0].write_all_set = true;
    const r = await inspectAcl(mock(d).query, roles);
    expect(r.evidence.grants).toEqual(d.evidence_grants);
    if (mode === 'inherited') expect(r.evidence.paths[0].inherited).toBe(true);
    if (mode === 'settable')
      expect(r.evidence.paths[0]).toMatchObject({
        inherited: false,
        settable: true,
      });
    if (mode === 'direct') expect(r.evidence.paths[0].direct).toBe(true);
    if (mode === 'ownership' || mode === 'owner_set')
      expect(r.objects.relations[0].owner_set).toBe(true);
    if (mode === 'public_plus')
      expect(
        r.evidence.paths.filter(
          (p) => p.role_oid === '200' && (p.public || p.inherited),
        ),
      ).toHaveLength(2);
    if (mode === 'wide') expect(r.evidence.roles[0].write_all_usage).toBe(true);
  });
  it.each([
    'isolation',
    'read_only',
    'default_read_only',
    'backend_pid',
    'snapshot',
    'database_oid',
    'current_role_oid',
  ])('transaction sai %s bi tu choi', async (field) => {
    const d = data();
    d.transaction[0][field] = 'WRONG';
    await expect(inspectAcl(mock(d).query, roles)).rejects.toHaveProperty(
      'safeReason',
      'ACL_TRANSACTION_INVALID',
    );
  });
  it('context khong thay the bang chung SQL, snapshot va count phai khop', async () => {
    await expect(
      inspectAclImpl(mock(data()).query, roles),
    ).rejects.toHaveProperty('safeReason', 'ACL_TRANSACTION_INVALID');
    for (const key of [
      'transaction',
      'evidence_target',
      'evidence_grants',
      'evidence_roles',
    ]) {
      await expect(
        inspectAcl(
          mock(data(), {
            change: (c, n, rows) => {
              if (c === key && n === 2) {
                if (c === 'transaction') rows[0].snapshot = '101:102:';
                else rows[0].unexpected = 'PRIVATE_SENTINEL';
              }
            },
          }).query,
          roles,
        ),
      ).rejects.toHaveProperty('safeReason', 'ACL_SNAPSHOT_CHANGED');
    }
    const d = data();
    d.evidence_roles.pop();
    await expect(inspectAcl(mock(d).query, roles)).rejects.toHaveProperty(
      'safeReason',
      'ACL_EVIDENCE_INVALID',
    );
  });
  it('PowerShell ACL mode does not bootstrap a runner or widen inherited environment', () => {
    const ps = readFileSync(
      join(__dirname, 'inspect-payment-surplus-metadata.ps1'),
      'utf8',
    );
    expect(ps).toContain('[switch]$Acl');
    expect(ps).toContain(
      "$info.EnvironmentVariables['SURPLUS_METADATA_ACL']='1'",
    );
    expect(ps).toContain('$info.EnvironmentVariables.Clear()');
    expect(ps).not.toMatch(/-RunHarness|DATABASE_URL|SET ROLE/);
  });
  async function warningReport() {
    const d = data();
    d.evidence_grants.push({
      scope: 'RELATION',
      attnum: 0,
      grantor_oid: '10',
      grantee_oid: '10',
      grantable: false,
    });
    d.inventory[0].evidence_grants = '2';
    d.relations.forEach((r) => (r.default_acl = false));
    return inspectAcl(mock(d).query, roles);
  }
  it('chi UPDATE mac dinh pg_settings thanh warning, khong doi inventory', async () => {
    const r = await warningReport();
    const before = JSON.stringify(r);
    const c = classifyAclWrites(r);
    expect(c.blocked).toBe(false);
    expect(c.warnings).toEqual([
      {
        code: 'PG_SETTINGS_DEFAULT_PUBLIC_UPDATE',
        database_oid: '5',
        object_oid: '12',
        role_oids: ['200', '201', '202'],
      },
    ]);
    expect(JSON.stringify(r)).toBe(before);
    expect(r.objects.sequences).toHaveLength(3);
  });
  it('khong chi dua vao OID va khong cam membership cung huong PUBLIC', async () => {
    const r = await warningReport();
    r.evidence.identity.object_oid = '12104';
    r.objects.relations.forEach((a) => (a.object_oid = '12104'));
    Object.assign(
      r.objects.memberships.find(
        (m) => m.role_oid === '200' && m.object_oid === '201',
      ),
      { member: true, usage: true, settable: true },
    );
    expect(classifyAclWrites(r).warnings[0].object_oid).toBe('12104');
    r.evidence.identity.schema_name = 'public';
    expect(classifyAclWrites(r)).toEqual({ blocked: true, warnings: [] });
  });
  it.each([
    'direct',
    'inherited',
    'settable',
    'column',
    'grant_option',
    'owner_usage',
    'owner_set',
    'write_all_usage',
    'write_all_set',
    'schema',
    'name',
    'kind',
    'missing',
    'snapshot',
    'count',
  ])('warning khong duoc che bang chung %s', async (mode) => {
    const r: any = await warningReport();
    const e = r.evidence;
    if (['direct', 'inherited', 'settable', 'column'].includes(mode)) {
      const g = {
        scope: mode === 'column' ? 'COLUMN' : 'RELATION',
        attnum: mode === 'column' ? 1 : 0,
        grantor_oid: '10',
        grantee_oid: '200',
        grantable: false,
      };
      e.grants.push(g);
      e.counts.grants++;
      for (const role of roles)
        e.paths.push({
          role_oid: role.oid,
          ...g,
          public: false,
          direct: role.oid === '200',
          inherited: false,
          settable: role.oid === '200',
        });
      e.counts.paths = e.paths.length;
    }
    if (mode === 'grant_option') {
      e.grants[0].grantable = true;
      e.paths[0].grantable = true;
    }
    if (mode === 'owner_usage' || mode === 'owner_set')
      r.objects.relations[0][mode] = true;
    if (mode.startsWith('write_all_')) e.roles[0][mode] = true;
    if (mode === 'schema') e.identity.schema_name = 'public';
    if (mode === 'name') e.identity.relation_name = 'application_data';
    if (mode === 'kind') e.identity.relkind = 'r';
    if (mode === 'missing') delete r.evidence;
    if (mode === 'snapshot') e.transaction.sameSnapshot = false;
    if (mode === 'count') r.counts.relations++;
    const c = classifyAclWrites(r);
    expect(c.blocked).toBe(true);
    expect(c.warnings).toEqual([]);
  });
  it.each([
    'table_insert',
    'table_delete',
    'table_truncate',
    'table_references',
    'table_trigger',
    'table_maintain',
    'column_insert',
  ])('quyen %s tren pg_settings van la blocker', async (capability) => {
    const r = await warningReport();
    r.objects.relations[0][capability] = true;
    expect(classifyAclWrites(r)).toEqual({ blocked: true, warnings: [] });
  });
  it.each(['effective_usage', 'effective_update', 'owner_usage', 'owner_set'])(
    'sequence %s van blocker cung warning pg_settings',
    async (capability) => {
      const r = await warningReport();
      r.objects.sequences[0][capability] = true;
      const c = classifyAclWrites(r);
      expect(c.blocked).toBe(true);
      expect(c.warnings).toHaveLength(1);
    },
  );
  it('bang ung dung co UPDATE van bi chan, khong mien tru theo OID', async () => {
    const r = await warningReport();
    const extra = r.objects.relations.map((a) => ({
      ...a,
      object_oid: '999',
      schema_oid: '2200',
    }));
    r.objects.relations.push(...extra);
    r.counts.relations += 3;
    const c = classifyAclWrites(r);
    expect(c.blocked).toBe(true);
    expect(c.warnings).toHaveLength(1);
    r.evidence.identity.relation_name = 'application_table';
    expect(classifyAclWrites(r).warnings).toEqual([]);
  });
});
