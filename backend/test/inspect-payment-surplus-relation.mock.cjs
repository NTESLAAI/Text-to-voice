'use strict';
// node --test test/inspect-payment-surplus-relation.mock.cjs (mock clients only).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { DatabaseError } = require('pg-protocol');
const {
  inspect,
  safeJson,
  validateUrl,
  SQL,
  SCHEMAS,
  BEGIN,
  IDENTITY,
  INVENTORY,
  INVENTORY_GROUPS,
  diagnostic,
  PHASES,
  SQLSTATES,
  ACL_STEPS,
  ACL_DIAGNOSTIC,
} = require('./inspect-payment-surplus-relation.cjs');
const RAW =
  'postgresql://ttv_surplus_lifecycle:MOCK_ONLY@127.0.0.1:55432/postgres';
function fixture() {
  const ids = ['16388', '16389', '16390'];
  return {
    relation: [
      {
        oid: '12104',
        schema_oid: '11',
        schema_name: 'pg_catalog',
        name: 'mock_view',
        kind: 'v',
        owner_oid: '10',
        default_acl: false,
        rls: false,
        force_rls: false,
        has_rules: true,
        has_triggers: false,
        security_invoker: false,
      },
    ],
    roles: ids.map((oid, i) => ({
      oid,
      internal_name: [
        'ttv_surplus_lifecycle',
        'ttv_surplus_writer',
        'ttv_surplus_reader',
      ][i],
      superuser: false,
      bypass_rls: false,
      schema_usage: true,
      table_update: true,
      column_update: true,
      owner_usage: false,
      owner_set: false,
      write_all_usage: false,
      write_all_set: false,
    })),
    columns: [{ attnum: 1, default_acl: true }],
    acl: [
      {
        scope: 'RELATION',
        attnum: 0,
        grantor_oid: '10',
        grantee_oid: '0',
        grantable: false,
      },
    ],
    memberships: ids.flatMap((role_oid) =>
      ['10', ...ids].map((target_oid) => ({
        role_oid,
        target_oid,
        member: role_oid === target_oid,
        usage: role_oid === target_oid,
        settable: role_oid === target_oid,
      })),
    ),
    rules: [{ oid: '12105', event: '2', enabled: 'O', instead: true }],
    triggers: [],
    policies: [],
  };
}
async function run(options = {}) {
  const d = fixture();
  options.mutate?.(d);
  // Explicit PG17 ACL-array contract model, not a PostgreSQL SQL parser/executor.
  if (Object.hasOwn(options, 'columnAcl')) {
    const acl = options.columnAcl;
    d.columns[0].default_acl = acl === null;
    d.acl = d.acl.filter((r) => r.scope !== 'COLUMN');
    if (acl?.dimensions === 1 && Array.isArray(acl.items)) {
      for (const item of acl.items)
        if (item?.privilege === 'UPDATE')
          d.acl.push({
            scope: 'COLUMN',
            attnum: 1,
            grantor_oid: '10',
            grantee_oid: '0',
            grantable: false,
          });
    }
  }
  const statements = [];
  function mockError(code, javascript = false) {
    const error =
      !javascript && typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)
        ? new DatabaseError('MOCK_SECRET_SERVER', 0, 'error')
        : new TypeError('MOCK_SECRET_JAVASCRIPT');
    error.code = code;
    return error;
  }
  let clients = 0,
    closed = 0,
    sample = 0;
  const id = {
    role: 'ttv_surplus_lifecycle',
    session_role: 'ttv_surplus_lifecycle',
    db: 'postgres',
    database_oid: '5',
    host: '127.0.0.1',
    port: '55432',
    pid: '100',
    cluster: '7703979600700924132',
    directory: 'D:/text-to-voice/pg-test-cluster',
    session_ro: 'on',
    tx_ro: 'on',
    ...options.identity,
  };
  class MockClient {
    constructor(config) {
      clients++;
      assert.equal(
        config.options.includes('default_transaction_read_only=on'),
        true,
      );
    }
    on(event, callback) {
      this.onError = callback;
    }
    async connect() {
      if (options.connectError)
        throw mockError(
          options.errorCode || 'ECONNREFUSED',
          options.javascript,
        );
    }
    async query(sql) {
      statements.push(sql);
      if (options.errorStatement === sql)
        throw mockError(options.errorCode, options.javascript);
      if (sql === BEGIN || sql === 'ROLLBACK') return {};
      if (sql === IDENTITY) return { rows: [id] };
      assert.ok(statements.includes(BEGIN) && statements.includes(IDENTITY));
      if (
        Object.hasOwn(options, 'columnAcl') &&
        sql.includes('aclexplode') &&
        sql.includes('a.attacl')
      ) {
        const acl = options.columnAcl;
        if (acl === null) {
          // Old COALESCE fallback manufactures an invalid zero-dimensional ACL.
          if (sql.includes("'{}'::aclitem[]")) throw mockError('22023');
        } else if (acl.dimensions !== 1 || !Array.isArray(acl.items))
          throw mockError('22023');
      }
      if (options.aclDiagnostic) {
        const step = ACL_STEPS.find((step) => ACL_DIAGNOSTIC[step] === sql);
        assert.ok(step);
        if (options.aclError === step)
          throw mockError(options.errorCode, options.javascript);
        const count =
          step === 'UNION_ORDERED'
            ? d.acl.length
            : d.acl.filter(
                (a) =>
                  a.scope ===
                  (step === 'RELATION_BRANCH' ? 'RELATION' : 'COLUMN'),
              ).length;
        const rows = [{ count }];
        options.aclMutate?.(
          rows,
          step,
          statements.filter((s) => s === sql).length,
        );
        return { rows };
      }
      const inventoryGroup = INVENTORY_GROUPS.find(
        (group) => INVENTORY[group] === sql,
      );
      if (inventoryGroup) {
        if (options.inventoryError === inventoryGroup)
          throw mockError(options.errorCode, options.javascript);
        const rows = [{ count: d[inventoryGroup].length }];
        options.inventoryMutate?.(rows, inventoryGroup);
        return { rows };
      }
      const key = Object.keys(SQL).find((k) => SQL[k] === sql);
      assert.ok(key);
      if (key === 'relation') sample++;
      if (options.errorKey === key) {
        const e = mockError(options.errorCode, options.javascript);
        e.safeCode = options.safeCode;
        throw e;
      }
      if (options.lostKey === key)
        this.onError(new Error('MOCK_SECRET_DISCONNECT'));
      let rows = structuredClone(d[key]);
      if (options.changed && sample === 2 && key === 'relation')
        rows[0].name = 'changed_view';
      if (options.truncate === key) rows = [];
      if (options.hang === key) return new Promise(() => {});
      return { rows };
    }
    async end() {
      closed++;
      if (options.closeError) throw new Error('MOCK_SECRET_CLOSE');
    }
    unref() {}
  }
  const result = await inspect(options.url ?? RAW, {
    Client: MockClient,
    aclDiagnostic: options.aclDiagnostic ?? false,
  });
  const json = safeJson(result);
  assert.doesNotMatch(json, /MOCK_SECRET|MOCK_ONLY|postgresql:\/\//);
  return { result, json, statements, clients, closed };
}

for (const [name, options, code, phase, identityStatus, sqlstate] of [
  [
    'authentication',
    { connectError: true, errorCode: '28P01' },
    'AUTHENTICATION_FAILED',
    'CONNECT',
    'UNVERIFIED',
    '28P01',
  ],
  [
    'syntax before identity',
    { errorStatement: BEGIN, errorCode: '42601' },
    'SQL_SYNTAX_ERROR',
    'BEGIN_READ_ONLY',
    'UNVERIFIED',
    '42601',
  ],
  [
    'function in identity',
    { errorStatement: IDENTITY, errorCode: '42883' },
    'UNDEFINED_FUNCTION',
    'IDENTITY',
    'UNVERIFIED',
    '42883',
  ],
  [
    'identity privilege',
    { errorStatement: IDENTITY, errorCode: '42501' },
    'INSUFFICIENT_PRIVILEGE',
    'IDENTITY',
    'UNVERIFIED',
    '42501',
  ],
  [
    'inventory syntax',
    { errorStatement: INVENTORY.relation, errorCode: '42601' },
    'SQL_SYNTAX_ERROR',
    'INVENTORY',
    'VERIFIED',
    '42601',
  ],
  [
    'inventory column',
    { errorStatement: INVENTORY.relation, errorCode: '42703' },
    'UNDEFINED_COLUMN',
    'INVENTORY',
    'VERIFIED',
    '42703',
  ],
  [
    'catalog function',
    { errorKey: 'rules', errorCode: '42883' },
    'UNDEFINED_FUNCTION',
    'CATALOG_RULES_TRIGGERS',
    'VERIFIED',
    '42883',
  ],
  [
    'catalog canceled',
    { errorKey: 'acl', errorCode: '57014' },
    'QUERY_CANCELED',
    'CATALOG_ACL',
    'VERIFIED',
    '57014',
  ],
  [
    'membership failure',
    { errorKey: 'memberships' },
    'JAVASCRIPT_ERROR',
    'CATALOG_MEMBERSHIP',
    'VERIFIED',
    undefined,
  ],
  [
    'role failure',
    { errorKey: 'roles' },
    'JAVASCRIPT_ERROR',
    'CATALOG_ROLES',
    'VERIFIED',
    undefined,
  ],
  [
    'column failure',
    { errorKey: 'columns' },
    'JAVASCRIPT_ERROR',
    'CATALOG_COLUMNS',
    'VERIFIED',
    undefined,
  ],
  [
    'policy failure',
    { errorKey: 'policies' },
    'JAVASCRIPT_ERROR',
    'CATALOG_POLICIES',
    'VERIFIED',
    undefined,
  ],
  [
    'rollback failure',
    { errorStatement: 'ROLLBACK', errorCode: '25P02' },
    'TRANSACTION_FAILED',
    'ROLLBACK',
    'VERIFIED',
    '25P02',
  ],
  [
    'connection refused',
    { connectError: true, errorCode: 'ECONNREFUSED' },
    'CONNECTION_FAILED',
    'CONNECT',
    'UNVERIFIED',
    undefined,
  ],
  [
    'unclassified SQLSTATE',
    { errorKey: 'relation', errorCode: 'ZZ999' },
    'UNCLASSIFIED_DATABASE_ERROR',
    'CATALOG_RELATION',
    'VERIFIED',
    undefined,
  ],
  [
    'untrusted safeCode',
    { errorKey: 'relation', safeCode: 'MOCK_SECRET_CODE' },
    'JAVASCRIPT_ERROR',
    'CATALOG_RELATION',
    'VERIFIED',
    undefined,
  ],
])
  test('diagnostic ' + name, async () => {
    const r = await run(options);
    assert.equal(r.result.code, code);
    assert.equal(r.result.phase, phase);
    assert.equal(r.result.identityStatus, identityStatus);
    assert.equal(r.result.sqlstate, sqlstate);
    assert.equal(JSON.parse(r.json).phase, phase);
    assert.doesNotMatch(r.json, /ZZ999|MOCK_SECRET/);
  });

test('diagnostic allowlists reject unknown fields, phases, codes and misleading identity', () => {
  const base = diagnostic(
    Object.assign(new DatabaseError('MOCK_SECRET', 0, 'error'), {
      code: '28P01',
    }),
    'CONNECT',
    'UNVERIFIED',
  );
  for (const mutate of [
    (r) => (r.phase = 'MOCK_SECRET_PHASE'),
    (r) => (r.code = 'MOCK_SECRET_CODE'),
    (r) => (r.identityStatus = 'VERIFIED'),
    (r) => (r.identityStatus = true),
    (r) => (r.sqlstate = 'ZZ999'),
    (r) => (r.sqlstate = ['28P01']),
    (r) => (r.sqlstate = 28000),
    (r) => (r.detail = 'MOCK_SECRET_DETAIL'),
    (r) => (r.sqlstate = '42601'),
  ]) {
    const r = structuredClone(base);
    mutate(r);
    const output = JSON.parse(safeJson(r));
    assert.equal(output.code, 'REPORT_VALIDATION_FAILED');
    assert.equal(output.identityStatus, 'UNVERIFIED');
    assert.doesNotMatch(JSON.stringify(output), /MOCK_SECRET|ZZ999/);
  }
  assert.ok(PHASES.includes('INVENTORY'));
  assert.equal(SQLSTATES['28P01'], 'AUTHENTICATION_FAILED');
});

test('each allowed SQLSTATE has a safe classification without exception content', () => {
  for (const [sqlstate, code] of Object.entries(SQLSTATES)) {
    const report = diagnostic(
      Object.assign(new DatabaseError('MOCK_SECRET', 0, 'error'), {
        code: sqlstate,
        detail: 'MOCK_SECRET',
        hint: 'MOCK_SECRET',
        stack: 'MOCK_SECRET',
      }),
      'CONNECT',
      'UNVERIFIED',
    );
    assert.equal(report.code, code);
    assert.equal(report.sqlstate, sqlstate);
    assert.doesNotMatch(safeJson(report), /MOCK_SECRET/);
  }
});

test('CLI URL and offline parsing failures remain distinct without loading pg', () => {
  const env = Object.fromEntries(
    ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  for (const offline of [false, true]) {
    const args = [
      path.join(__dirname, 'inspect-payment-surplus-relation.cjs'),
      ...(offline ? ['--validate-report'] : []),
    ];
    const child = spawnSync(process.execPath, args, {
      input: 'MOCK_SECRET_INVALID_JSON',
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    const output = JSON.parse(child.stdout);
    assert.equal(child.status, 1);
    assert.equal(output.status, 'UNKNOWN');
    assert.equal(
      output.phase,
      offline ? 'OUTPUT_VALIDATION' : 'URL_VALIDATION',
    );
    assert.equal(
      output.code,
      offline ? 'REPORT_VALIDATION_FAILED' : 'IDENTITY_MISMATCH',
    );
    assert.equal(output.identityStatus, 'UNVERIFIED');
    assert.equal(child.stderr, '');
    assert.doesNotMatch(child.stdout, /MOCK_SECRET/);
  }
});
test('CLI dependency failure is classified without connecting or leaking raw error', async () => {
  const module = { exports: {} };
  let output = '';
  const guardedRequire = (id) => {
    if (id === 'pg') throw new Error('MOCK_SECRET_DEPENDENCY');
    return require(id);
  };
  guardedRequire.main = module;
  const proc = {
    argv: ['node', 'mock-inspector'],
    env: { SURPLUS_RELATION_URL: RAW },
    stdout: { write: (s) => (output += s) },
    exitCode: 0,
  };
  vm.runInNewContext(
    readFileSync(
      path.join(__dirname, 'inspect-payment-surplus-relation.cjs'),
      'utf8',
    ),
    {
      require: guardedRequire,
      module,
      process: proc,
      URL,
      setTimeout,
      clearTimeout,
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const result = JSON.parse(output);
  assert.equal(result.code, 'DEPENDENCY_FAILED');
  assert.equal(result.phase, 'DEPENDENCY_LOAD');
  assert.equal(result.identityStatus, 'UNVERIFIED');
  assert.equal(proc.exitCode, 1);
  assert.doesNotMatch(output, /MOCK_SECRET|MOCK_ONLY/);
});
test('PUBLIC UPDATE is identified, no OID/name inference, rules metadata only', async () => {
  const r = await run();
  assert.equal(r.result.status, 'VERIFIED');
  assert.equal(r.result.data.relation[0].name, 'mock_view');
  assert.equal(r.result.data.sources.length, 3);
  assert.ok(r.result.data.sources.every((s) => s.public));
  assert.equal(r.closed, 1);
  assert.ok(
    r.statements.every(
      (s) => s === BEGIN || s === 'ROLLBACK' || /^SELECT /.test(s),
    ),
  );
  assert.equal(r.statements[0], BEGIN);
  assert.equal(r.statements[1], IDENTITY);
});
for (const [field, wrong] of Object.entries({
  role: 'postgres',
  session_role: 'other',
  db: 'text_to_voice',
  database_oid: '16393',
  host: '::1',
  port: '5432',
  cluster: 'wrong',
  directory: 'C:/Program Files/PostgreSQL/17/data',
  session_ro: 'off',
  tx_ro: 'off',
  pid: null,
})) {
  test(
    'identity mismatch ' + field + ' blocks all catalog inspection',
    async () => {
      const r = await run({ identity: { [field]: wrong } });
      assert.equal(r.result.code, 'IDENTITY_MISMATCH');
      assert.equal(r.statements.length, 2);
      assert.equal(r.closed, 1);
    },
  );
}
test('Windows directory normalization retains exact identity', async () => {
  assert.equal(
    (
      await run({
        identity: { directory: 'D:\\text-to-voice\\pg-test-cluster\\' },
      })
    ).result.status,
    'VERIFIED',
  );
});
for (const [index, url] of [
  RAW.replace('55432', '5432'),
  RAW.replace('127.0.0.1', 'localhost'),
  RAW.replace('/postgres', '/text_to_voice_test'),
  RAW.replace('ttv_surplus_lifecycle', 'postgres'),
  RAW + '?host=evil',
  RAW + '#x',
  RAW.replace(':MOCK_ONLY', ''),
  '',
].entries()) {
  test(
    'invalid URL rejected before Client construction case ' + (index + 1),
    async () => {
      const r = await run({ url });
      assert.equal(r.clients, 0);
      assert.equal(r.result.status, 'UNKNOWN');
    },
  );
}
test('all fixed queries contain only permitted catalog reads', () => {
  for (const sql of [
    IDENTITY,
    ...Object.values(INVENTORY),
    ...Object.values(SQL),
  ]) {
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(
      sql,
      /;|pg_get_(view|rule|function)def|ev_action|ev_qual|prosrc|tgargs|polqual\s+AS|polwithcheck\s+AS|SET ROLE|pg_terminate|COMMENT|\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|REVOKE)\s+[A-Za-z]/i,
    );
  }
});
test('direct grants distinct from inherited and SET-only paths', async () => {
  const r = await run({
    mutate(d) {
      d.acl[0].grantee_oid = '16389';
      for (const m of d.memberships)
        if (m.target_oid === '16389' && m.role_oid === '16388')
          m.member = m.usage = m.settable = true;
      for (const m of d.memberships)
        if (m.target_oid === '16389' && m.role_oid === '16390') {
          m.member = m.settable = true;
        }
      d.roles[2].table_update = d.roles[2].column_update = false;
    },
  });
  assert.equal(r.result.status, 'VERIFIED');
  assert.equal(
    r.result.data.sources.find((s) => s.role_oid === '16388').inherited,
    true,
  );
  assert.equal(
    r.result.data.sources.find((s) => s.role_oid === '16389').direct,
    true,
  );
  const reader = r.result.data.sources.find((s) => s.role_oid === '16390');
  assert.equal(reader.settable, true);
  assert.equal(reader.inherited, false);
});
test('column-only grant does not imply table UPDATE', async () => {
  const r = await run({
    mutate(d) {
      d.acl[0].scope = 'COLUMN';
      d.acl[0].attnum = 1;
      d.columns[0].default_acl = false;
      d.roles.forEach((r) => (r.table_update = false));
    },
  });
  assert.equal(r.result.status, 'VERIFIED');
  assert.equal(r.result.data.sources[0].scope, 'COLUMN');
});
test('owner privileges and default ACL remain distinct', async () => {
  const r = await run({
    mutate(d) {
      d.relation[0].owner_oid = '16389';
      d.relation[0].default_acl = true;
      d.acl[0].grantee_oid = '16389';
      d.acl[0].grantor_oid = '16389';
      d.roles[1].owner_usage = d.roles[1].owner_set = true;
      d.roles[0].table_update =
        d.roles[0].column_update =
        d.roles[2].table_update =
        d.roles[2].column_update =
          false;
    },
  });
  assert.equal(r.result.status, 'VERIFIED');
});
test('ownership does not manufacture revoked UPDATE privileges', async () => {
  const r = await run({
    mutate(d) {
      d.relation[0].owner_oid = '16389';
      d.acl = [];
      d.roles.forEach((r) => {
        r.table_update = false;
        r.column_update = false;
      });
      d.roles[1].owner_usage = d.roles[1].owner_set = true;
    },
  });
  assert.equal(r.result.status, 'VERIFIED');
});
test('table RLS and trigger/policy metadata, no expressions/functions', async () => {
  const r = await run({
    mutate(d) {
      Object.assign(d.relation[0], {
        kind: 'r',
        rls: true,
        force_rls: true,
        has_triggers: true,
      });
      d.triggers.push({
        oid: '33',
        function_oid: '44',
        type_mask: 17,
        enabled: 'O',
        internal: false,
        security_definer: true,
      });
      d.policies.push({
        oid: '55',
        command: 'w',
        permissive: true,
        role_oid: '0',
        has_qual: true,
        has_check: true,
      });
    },
  });
  assert.equal(r.result.status, 'VERIFIED');
  assert.doesNotMatch(r.json, /prosrc|definition|expression/);
});
for (const [name, mutate, code] of [
  ['missing relation', (d) => (d.relation = []), 'RELATION_NOT_FOUND'],
  ['missing role', (d) => d.roles.pop(), 'INVALID_METADATA'],
  ['null boolean', (d) => (d.roles[0].table_update = null), 'INVALID_METADATA'],
  ['numeric OID', (d) => (d.relation[0].oid = 12104), 'INVALID_METADATA'],
  [
    'unknown field sentinel',
    (d) => (d.relation[0].unexpected = 'MOCK_SECRET_SENTINEL'),
    'INVALID_METADATA',
  ],
  ['unexplained effective UPDATE', (d) => (d.acl = []), 'UNATTRIBUTED_UPDATE'],
  [
    'wrong ownership path',
    (d) => (d.roles[0].owner_usage = true),
    'INVALID_METADATA',
  ],
  [
    'duplicate membership',
    (d) => d.memberships.push(d.memberships[0]),
    'INVALID_METADATA',
  ],
  [
    'column target missing',
    (d) => {
      d.acl[0].scope = 'COLUMN';
      d.acl[0].attnum = 99;
    },
    'INVALID_METADATA',
  ],
  [
    'row limit',
    (d) =>
      (d.columns = Array.from({ length: 201 }, (_, i) => ({
        attnum: i + 1,
        default_acl: true,
      }))),
    'ROW_LIMIT_EXCEEDED',
  ],
])
  test(name + ' fails closed', async () => {
    assert.equal((await run({ mutate })).result.code, code);
  });
for (const [name, options, code] of [
  ['missing result rows', { truncate: 'rules' }, 'INVALID_METADATA'],
  ['changed snapshot', { changed: true }, 'SNAPSHOT_CHANGED'],
  [
    'catalog permission',
    { errorKey: 'relation', errorCode: '42501' },
    'INSUFFICIENT_PRIVILEGE',
  ],
  ['catalog error', { errorKey: 'relation' }, 'JAVASCRIPT_ERROR'],
  ['disconnect', { lostKey: 'relation' }, 'CONNECTION_LOST'],
  ['connect failure', { connectError: true }, 'CONNECTION_FAILED'],
  ['close failure', { closeError: true }, 'CLOSE_FAILED'],
  ['real finite mock timeout', { hang: 'relation' }, 'TIMEOUT'],
])
  test(name, async () => {
    const r = await run(options);
    assert.equal(r.result.code, code);
    assert.equal(r.closed, 1);
  });
test('offline validator rejects malformed VERIFIED and never imports pg', async () => {
  const valid = (await run()).result;
  const mutations = [
    (r) => (r.data = null),
    (r) => (r.snapshotMatched = false),
    (r) => r.counts.acl++,
    (r) => (r.data.relation[0].unexpected = 'MOCK_SECRET_SENTINEL'),
    (r) => (r.data.roles[0].oid = '0'),
    (r) => (r.data.roles[0].table_update = 'true'),
    (r) => (r.data.sources[0].public = false),
    (r) => (r.status = 'PASS'),
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(valid);
    mutate(bad);
    const output = JSON.parse(safeJson(bad));
    assert.equal(output.code, 'REPORT_VALIDATION_FAILED');
    assert.doesNotMatch(JSON.stringify(output), /MOCK_SECRET/);
  }
  const env = Object.fromEntries(
    ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP']
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  const child = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'inspect-payment-surplus-relation.cjs'),
      '--validate-report',
    ],
    { input: JSON.stringify(valid), env, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.status, 0);
  assert.equal(JSON.parse(child.stdout).status, 'VERIFIED');
  assert.equal(child.stderr, '');
  assert.throws(() => validateUrl(RAW + '?options=x'));
  assert.equal(Object.keys(SCHEMAS).length, 9);
});

test('all eight inventory counts are sequential, on the verified transaction before sampling', async () => {
  const r = await run();
  assert.equal(r.result.status, 'VERIFIED');
  assert.deepEqual(
    r.statements.slice(2, 10),
    INVENTORY_GROUPS.map((g) => INVENTORY[g]),
  );
  assert.equal(r.statements[0], BEGIN);
  assert.equal(r.statements[1], IDENTITY);
  assert.equal(r.statements.filter((sql) => sql === BEGIN).length, 1);
  assert.ok(r.statements.indexOf(SQL.relation) > 9);
});
for (const group of INVENTORY_GROUPS)
  test('inventory stops exactly at failing ' + group, async () => {
    const r = await run({ inventoryError: group, errorCode: '42601' });
    assert.equal(r.result.code, 'SQL_SYNTAX_ERROR');
    assert.equal(r.result.phase, 'INVENTORY');
    assert.equal(r.result.inventoryGroup, group);
    assert.equal(r.result.identityStatus, 'VERIFIED');
    assert.equal(r.result.sqlstate, '42601');
    assert.equal(JSON.parse(r.json).inventoryGroup, group);
    assert.deepEqual(
      r.statements.slice(2),
      INVENTORY_GROUPS.slice(0, INVENTORY_GROUPS.indexOf(group) + 1).map(
        (g) => INVENTORY[g],
      ),
    );
    assert.equal(r.closed, 1);
  });
for (const [name, options, code, state] of [
  [
    'unlisted PostgreSQL error',
    { errorCode: 'ZZ999' },
    'UNCLASSIFIED_DATABASE_ERROR',
    undefined,
  ],
  [
    'JavaScript with fake recognized SQLSTATE',
    { errorCode: '42601', javascript: true },
    'JAVASCRIPT_ERROR',
    undefined,
  ],
  [
    'JavaScript with fake unrecognized SQLSTATE',
    { errorCode: 'ZZ999', javascript: true },
    'JAVASCRIPT_ERROR',
    undefined,
  ],
  [
    'PostgreSQL privilege error',
    { errorCode: '42501' },
    'INSUFFICIENT_PRIVILEGE',
    '42501',
  ],
])
  test(
    name + ' preserves inventory group without leaking content',
    async () => {
      const r = await run({ inventoryError: 'acl', ...options });
      assert.equal(r.result.code, code);
      assert.equal(r.result.sqlstate, state);
      assert.equal(r.result.inventoryGroup, 'acl');
      assert.equal(JSON.parse(r.json).code, code);
      assert.doesNotMatch(r.json, /ZZ999|MOCK_SECRET/);
    },
  );
for (const [name, count, expected] of [
  ['string', '1', 'INVALID_METADATA'],
  ['null', null, 'INVALID_METADATA'],
  ['boolean', true, 'INVALID_METADATA'],
  ['fraction', 0.5, 'INVALID_METADATA'],
  ['negative', -1, 'INVALID_METADATA'],
  ['overflow', 201, 'ROW_LIMIT_EXCEEDED'],
])
  test('inventory ' + name + ' count fails closed', async () => {
    const r = await run({
      inventoryMutate: (rows, group) => {
        if (group === 'columns') rows[0].count = count;
      },
    });
    assert.equal(r.result.code, expected);
    assert.equal(r.result.inventoryGroup, 'columns');
    assert.equal(r.result.phase, 'INVENTORY');
    assert.equal(JSON.parse(r.json).inventoryGroup, 'columns');
  });
test('inventory missing rows, unknown fields and spoofed group all fail closed', async () => {
  for (const mode of ['missing', 'extra']) {
    const r = await run({
      inventoryMutate: (rows, group) => {
        if (group === 'roles') {
          if (mode === 'missing') rows.pop();
          else rows[0].unexpected = 'MOCK_SECRET_SENTINEL';
        }
      },
    });
    assert.equal(r.result.code, 'INVALID_METADATA');
    assert.equal(r.result.inventoryGroup, 'roles');
  }
  const base = diagnostic(
    Object.assign(new DatabaseError('MOCK_SECRET', 0, 'error'), {
      code: '42601',
    }),
    'INVENTORY',
    'VERIFIED',
    'acl',
  );
  for (const mutate of [
    (r) => delete r.inventoryGroup,
    (r) => (r.inventoryGroup = 'MOCK_SECRET'),
    (r) => (r.inventoryGroup = null),
    (r) => (r.inventoryGroup = 1),
    (r) => (r.phase = 'COMPARE'),
  ]) {
    const r = structuredClone(base);
    mutate(r);
    const json = safeJson(r);
    assert.equal(JSON.parse(json).code, 'REPORT_VALIDATION_FAILED');
    assert.doesNotMatch(json, /MOCK_SECRET/);
  }
});
test('snapshot mismatch still refuses after successful grouped inventory', async () => {
  const r = await run({ changed: true });
  assert.equal(r.result.code, 'SNAPSHOT_CHANGED');
  assert.equal(r.result.phase, 'COMPARE');
  assert.equal(r.result.inventoryGroup, undefined);
  assert.equal(JSON.parse(r.json).code, 'SNAPSHOT_CHANGED');
});

test('ACL-only diagnostics opt in, retain ordered UNION, compare two samples and expose no ACL data', async () => {
  const r = await run({ aclDiagnostic: true });
  assert.equal(r.result.code, 'ACL_DIAGNOSTIC_VERIFIED');
  assert.deepEqual(
    r.statements.slice(2, 8),
    [...ACL_STEPS, ...ACL_STEPS].map((step) => ACL_DIAGNOSTIC[step]),
  );
  assert.equal(ACL_DIAGNOSTIC.UNION_ORDERED, INVENTORY.acl);
  assert.match(
    ACL_DIAGNOSTIC.UNION_ORDERED,
    /ORDER BY scope,attnum,grantor_oid,grantee_oid/,
  );
  assert.equal(r.result.data, undefined);
  assert.equal(r.result.counts, undefined);
  assert.equal(r.result.readiness, 'NOT_READY');
  assert.equal(r.closed, 1);
});
for (const step of ACL_STEPS)
  for (const state of ['42601', '42501', 'ZZ999'])
    test('ACL-only stops on ' + step + ' ' + state, async () => {
      const r = await run({
        aclDiagnostic: true,
        aclError: step,
        errorCode: state,
      });
      assert.equal(r.result.aclStep, step);
      assert.equal(r.result.phase, 'ACL_DIAGNOSTIC');
      assert.equal(r.result.identityStatus, 'VERIFIED');
      assert.equal(r.result.status, 'UNKNOWN');
      assert.equal(r.statements.length, 2 + ACL_STEPS.indexOf(step) + 1);
      assert.equal(r.closed, 1);
      assert.equal(JSON.parse(r.json).aclStep, step);
      assert.doesNotMatch(r.json, /ZZ999|MOCK_SECRET/);
    });
test('ACL-only JavaScript spoof, count validation, drift and empty ACL remain fail-closed', async () => {
  const js = await run({
    aclDiagnostic: true,
    aclError: 'COLUMN_BRANCH',
    errorCode: '42601',
    javascript: true,
  });
  assert.equal(js.result.code, 'JAVASCRIPT_ERROR');
  assert.equal(js.result.sqlstate, undefined);
  for (const count of [null, '1', 201]) {
    const r = await run({
      aclDiagnostic: true,
      aclMutate: (rows) => (rows[0].count = count),
    });
    assert.equal(r.result.status, 'UNKNOWN');
    assert.equal(JSON.parse(r.json).aclStep, 'RELATION_BRANCH');
    assert.equal(r.statements.length, 3);
  }
  const changed = await run({
    aclDiagnostic: true,
    aclMutate: (rows, step, n) => {
      if (step === 'COLUMN_BRANCH' && n === 2) rows[0].count++;
    },
  });
  assert.equal(changed.result.code, 'SNAPSHOT_CHANGED');
  assert.equal(changed.result.aclStep, 'COLUMN_BRANCH');
  const empty = await run({ aclDiagnostic: true, mutate: (d) => (d.acl = []) });
  assert.equal(empty.result.code, 'ACL_DIAGNOSTIC_VERIFIED');
});
test('ACL diagnostic output rejects extra fields, invalid steps and false success', async () => {
  const valid = (await run({ aclDiagnostic: true })).result;
  for (const mutate of [
    (r) => (r.aclStep = 'RELATION_BRANCH'),
    (r) => (r.snapshotMatched = false),
    (r) => (r.unexpected = 'MOCK_SECRET'),
    (r) => (r.identityStatus = 'UNVERIFIED'),
  ]) {
    const r = structuredClone(valid);
    mutate(r);
    assert.equal(JSON.parse(safeJson(r)).code, 'REPORT_VALIDATION_FAILED');
  }
  const bad = diagnostic(
    Object.assign(new DatabaseError('MOCK_SECRET', 0, 'error'), {
      code: '42601',
    }),
    'ACL_DIAGNOSTIC',
    'VERIFIED',
    undefined,
    'COLUMN_BRANCH',
  );
  assert.equal(
    JSON.parse(safeJson({ ...bad, aclStep: 'MOCK_SECRET' })).code,
    'REPORT_VALIDATION_FAILED',
  );
  assert.equal(
    JSON.parse(safeJson({ ...bad, phase: 'COMPARE' })).code,
    'REPORT_VALIDATION_FAILED',
  );
});

test('column ACL SQL uses strict NULL input with no empty-array fallback in every path', () => {
  for (const sql of [
    SQL.acl,
    INVENTORY.acl,
    ACL_DIAGNOSTIC.COLUMN_BRANCH,
    ACL_DIAGNOSTIC.UNION_ORDERED,
  ]) {
    assert.match(sql, /pg_catalog\.aclexplode\(a\.attacl\)/);
    assert.doesNotMatch(sql, /COALESCE\(a\.attacl|'\{\}'::aclitem\[\]/);
  }
  assert.equal(ACL_DIAGNOSTIC.UNION_ORDERED, INVENTORY.acl);
  assert.match(
    ACL_DIAGNOSTIC.RELATION_BRANCH,
    /aclexplode\(COALESCE\(c\.relacl,pg_catalog\.acldefault\('r',c\.relowner\)\)\)/,
  );
});
for (const [name, columnAcl, rows] of [
  ['NULL', null, 0],
  ['valid UPDATE', { dimensions: 1, items: [{ privilege: 'UPDATE' }] }, 1],
  ['valid SELECT only', { dimensions: 1, items: [{ privilege: 'SELECT' }] }, 0],
  ['valid one-dimensional empty ACL', { dimensions: 1, items: [] }, 0],
])
  test(
    'modeled column ACL ' +
      name +
      ' keeps counts and both inspection modes consistent',
    async () => {
      const normal = await run({ columnAcl });
      assert.equal(normal.result.code, 'METADATA_VERIFIED');
      assert.equal(
        normal.result.data.acl.filter((r) => r.scope === 'COLUMN').length,
        rows,
      );
      assert.equal(normal.result.counts.acl, 1 + rows);
      const diagnostic = await run({ columnAcl, aclDiagnostic: true });
      assert.equal(diagnostic.result.code, 'ACL_DIAGNOSTIC_VERIFIED');
    },
  );
for (const columnAcl of [
  { dimensions: 0, items: [] },
  { dimensions: 2, items: [] },
])
  test(
    'non-NULL invalid ACL dimension ' +
      columnAcl.dimensions +
      ' refuses without skipping',
    async () => {
      for (const aclDiagnostic of [false, true]) {
        const r = await run({ columnAcl, aclDiagnostic });
        assert.equal(r.result.code, 'INVALID_PARAMETER_VALUE');
        assert.equal(r.result.sqlstate, '22023');
        assert.equal(r.result.identityStatus, 'VERIFIED');
        if (aclDiagnostic) {
          assert.equal(r.result.aclStep, 'COLUMN_BRANCH');
          assert.equal(
            r.statements.includes(ACL_DIAGNOSTIC.UNION_ORDERED),
            false,
          );
        } else assert.equal(r.result.inventoryGroup, 'acl');
        assert.equal(JSON.parse(r.json).code, 'INVALID_PARAMETER_VALUE');
        assert.equal(r.closed, 1);
      }
    },
  );
test('22023 is server-only, unlisted SQLSTATE still hidden', () => {
  const server = Object.assign(new DatabaseError('MOCK_SECRET', 0, 'error'), {
    code: '22023',
  });
  const r = diagnostic(
    server,
    'ACL_DIAGNOSTIC',
    'VERIFIED',
    undefined,
    'COLUMN_BRANCH',
  );
  assert.equal(r.code, 'INVALID_PARAMETER_VALUE');
  assert.equal(JSON.parse(safeJson(r)).sqlstate, '22023');
  const js = diagnostic(
    Object.assign(new TypeError('MOCK_SECRET'), { code: '22023' }),
    'ACL_DIAGNOSTIC',
    'VERIFIED',
    undefined,
    'COLUMN_BRANCH',
  );
  assert.equal(js.code, 'JAVASCRIPT_ERROR');
  assert.equal(js.sqlstate, undefined);
  server.code = 'ZZ999';
  const hidden = safeJson(
    diagnostic(
      server,
      'ACL_DIAGNOSTIC',
      'VERIFIED',
      undefined,
      'COLUMN_BRANCH',
    ),
  );
  assert.equal(JSON.parse(hidden).code, 'UNCLASSIFIED_DATABASE_ERROR');
  assert.doesNotMatch(hidden, /ZZ999|MOCK_SECRET/);
});
