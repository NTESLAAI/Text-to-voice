// Run only after explicit approval. No dotenv loading, application URL fallback,
// production bootstrap, database cloning, reset or forced connection termination.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const {
  createPreflightRun,
} = require('./payment-surplus-preflight-contract.cjs');
const {
  collectPreflightMetadata,
} = require('./inspect-payment-surplus-metadata.cjs');
const { inspectSessions } = require('./inspect-payment-surplus-sessions.cjs');
const {
  WRITE_CASES,
  testSummary,
} = require('./payment-surplus-write-contract.cjs');
const backend = path.resolve(__dirname, '..');
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
const normalizePath = (value) =>
  value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const APPROVED_TEST = Object.freeze({
  host: '127.0.0.1',
  port: '55432',
  cluster: '7703979600700924132',
  directory: 'd:/text-to-voice/pg-test-cluster',
});
const QUERY_LIMITS = Object.freeze({
  connectionTimeoutMillis: 10000,
  query_timeout: 20000,
});
const SESSION_LIMITS =
  '-c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=30000';

async function verifyDatabaseDropped(client, name, oid, verifyCluster) {
  await verifyCluster(client, 'postgres');
  const remaining = await client.query(
    'SELECT oid::text FROM pg_catalog.pg_database WHERE datname=$1 OR oid=$2::oid',
    [name, oid],
  );
  requireCondition(remaining.rowCount === 0, 'DATABASE_DROP_NOT_CONFIRMED');
}

async function assertNoExistingDatabaseCreate(client, writerOid, readerOid) {
  const result = await client.query(
    `SELECT 1 FROM pg_database
      WHERE has_database_privilege($1::oid,oid,'CREATE')
         OR has_database_privilege($2::oid,oid,'CREATE')`,
    [writerOid, readerOid],
  );
  requireCondition(
    result.rowCount === 0,
    'TEST_ROLES_CAN_CREATE_IN_EXISTING_DATABASE',
  );
}
function assertApprovedConfiguration(cluster, directory, port) {
  requireCondition(
    cluster === APPROVED_TEST.cluster &&
      typeof directory === 'string' &&
      normalizePath(directory) === APPROVED_TEST.directory &&
      port === APPROVED_TEST.port,
    'FIXED_TEST_CLUSTER_REQUIRED',
  );
}
function parseTestUrl(value) {
  requireCondition(
    typeof value === 'string' &&
      /^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\//.test(value) &&
      !/[\s\\]/.test(value),
    'FIXED_TEST_ENDPOINT_REQUIRED',
  );
  let url;
  try {
    url = new URL(value);
  } catch {
    requireCondition(false, 'INVALID_TEST_URL');
  }
  requireCondition(
    url.hostname === APPROVED_TEST.host &&
      url.port === APPROVED_TEST.port &&
      !url.search &&
      !url.hash,
    'FIXED_TEST_ENDPOINT_REQUIRED',
  );
  return url;
}
const sha = (data) => createHash('sha256').update(data).digest('hex');
function requireCondition(ok, code) {
  if (!ok) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

function runnerStatus(status) {
  console.log(JSON.stringify({ surplusStatus: status }));
}

async function cleanupDeadline(operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('CLEANUP_TIMEOUT');
          error.safeCode = 'CLEANUP_TIMEOUT';
          reject(error);
        }, 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeCleanupClient(client) {
  try {
    await cleanupDeadline(() => client.end());
  } catch (error) {
    // A rejected deadline does not close a socket. Do not let our own stalled
    // connection keep the runner alive; never terminate a PostgreSQL backend.
    try {
      client.unref();
    } catch {
      // Preserve the original failure; cleanup must remain unsuccessful.
    }
    throw error;
  }
}

// Never inherit application URLs, PG*, JWT*, NODE_OPTIONS or administrator secrets.
function childEnvironment(values) {
  const allowed = new Set([
    'SYSTEMROOT',
    'WINDIR',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'COMSPEC',
    'LANG',
    'LC_ALL',
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        allowed.has(key.toUpperCase()),
      ),
    ),
    TZ: 'UTC',
    ...values,
  };
}

// Standalone verification entrypoint. This function never calls main(), Prisma,
// a child process, lifecycle DDL, migrations or fixture preparation.
async function verifyMigrationTarget() {
  const name = process.env.PAYMENT_SURPLUS_TEMP_NAME;
  const token = process.env.PAYMENT_SURPLUS_TEMP_TOKEN;
  const oid = process.env.PAYMENT_SURPLUS_TEMP_OID;
  const owner = process.env.PAYMENT_SURPLUS_TEMP_OWNER_OID;
  const role = process.env.PAYMENT_SURPLUS_TEMP_MIGRATION_ROLE;
  const cluster = process.env.PAYMENT_SURPLUS_TEST_CLUSTER_ID;
  const directory = process.env.PAYMENT_SURPLUS_TEST_DATA_DIRECTORY;
  const port = process.env.PAYMENT_SURPLUS_TEST_PORT;
  const rawUrl = process.env.PAYMENT_SURPLUS_TEMP_MIGRATION_URL;
  requireCondition(
    name &&
      /^ttv_surplus_it_[a-f0-9]{32}$/.test(name) &&
      token &&
      /^[a-f0-9]{64}$/.test(token) &&
      /^[1-9]\d*$/.test(oid ?? '') &&
      /^[1-9]\d*$/.test(owner ?? '') &&
      role &&
      /^\d+$/.test(cluster ?? '') &&
      directory &&
      /^\d+$/.test(port ?? '') &&
      Number(port) > 0 &&
      Number(port) < 65536 &&
      rawUrl,
    'VERIFY_CONFIGURATION_REQUIRED',
  );
  assertApprovedConfiguration(cluster, directory, port);
  const url = parseTestUrl(rawUrl);
  requireCondition(
    ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.hostname === '127.0.0.1' &&
      url.port === port &&
      !url.search &&
      !url.hash &&
      decodeURIComponent(url.pathname) === `/${name}` &&
      decodeURIComponent(url.username) === role,
    'VERIFY_URL_MISMATCH',
  );
  const verificationOptions =
    '-c default_transaction_read_only=on -c statement_timeout=4000 -c lock_timeout=2000';
  url.searchParams.set('options', verificationOptions);
  const client = new Client({
    connectionString: url.toString(),
    options: verificationOptions,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    application_name: 'ttv-surplus-migration-verifier',
  });
  try {
    await client.connect();
    // Exactly one SELECT on the actual migration target; all checks fail closed.
    const row = (
      await client.query(`SELECT current_database() AS db, current_user AS role,
      session_user AS session_role, host(inet_server_addr()) AS address,
      inet_server_port()::text AS port, current_setting('data_directory') AS directory,
      current_setting('server_version_num')::int AS version,
      current_setting('default_transaction_read_only') AS session_ro,
      current_setting('transaction_read_only') AS tx_ro, pg_is_in_recovery() AS recovery,
      (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
      d.oid::text AS oid, d.datdba::text AS owner, pg_catalog.shobj_description(d.oid,'pg_database') AS marker,
      r.oid::text AS role_oid, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
      FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
      WHERE d.datname=current_database()`)
    ).rows[0];
    requireCondition(
      row &&
        row.db === name &&
        row.oid === oid &&
        row.owner === owner &&
        row.marker === `ttv-surplus-it:${token}` &&
        row.cluster === cluster &&
        normalizePath(row.directory) === normalizePath(directory) &&
        row.port === port &&
        row.address === '127.0.0.1' &&
        row.role === role &&
        row.session_role === role &&
        row.role_oid === owner &&
        row.version >= 170000 &&
        row.version < 180000 &&
        !row.recovery &&
        row.session_ro === 'on' &&
        row.tx_ro === 'on' &&
        !row.rolsuper &&
        !row.rolcreatedb &&
        !row.rolcreaterole &&
        !row.rolreplication &&
        !row.rolbypassrls,
      'VERIFY_TARGET_IDENTITY_MISMATCH',
    );
  } finally {
    await client.end();
  }
  // Fixed protocol marker, containing no database identity or secret values.
  console.log('PAYMENT_SURPLUS_MIGRATION_TARGET_VERIFIED');
}

// Approval transport only. EOF/error/extra input revokes even an accepted reply.
// No environment variable or persisted JSON report can replace this exchange.
function readRunApproval(input, gate, signal) {
  return new Promise((resolve, reject) => {
    let buffer = '',
      accepted = false,
      live = true,
      timer;
    const dispose = () => {
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', ended);
      input.off('close', ended);
      input.off('error', ended);
      signal.removeEventListener('abort', aborted);
      input.pause();
      buffer = '';
    };
    const fail = (code) => {
      live = false;
      gate.revoke();
      buffer = '';
      if (!accepted) {
        dispose();
        const error = new Error(code);
        error.safeCode = code;
        reject(error);
      }
    };
    const ended = () => fail('PREFLIGHT_CHANNEL_CLOSED');
    const aborted = () => fail('PREFLIGHT_INTERRUPTED');
    const data = (chunk) => {
      if (accepted) {
        if (chunk.length) fail('PREFLIGHT_APPROVAL_INVALID');
        return;
      }
      buffer += chunk.toString('utf8');
      if (buffer.length > 2048) return fail('PREFLIGHT_APPROVAL_INVALID');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        requireCondition(
          buffer.slice(newline + 1).length === 0,
          'PREFLIGHT_APPROVAL_INVALID',
        );
        gate.approve(JSON.parse(buffer.slice(0, newline)));
        buffer = '';
        accepted = true;
        clearTimeout(timer);
        resolve({
          isOpen: () => live && !input.readableEnded && !input.destroyed,
          dispose,
        });
      } catch {
        fail('PREFLIGHT_APPROVAL_INVALID');
      }
    };
    if (signal.aborted) return fail('PREFLIGHT_INTERRUPTED');
    if (
      input.isTTY ||
      input.readable !== true ||
      input.readableEnded ||
      input.destroyed
    )
      return fail('PREFLIGHT_CHANNEL_CLOSED');
    input.on('data', data);
    input.on('end', ended);
    input.on('close', ended);
    input.on('error', ended);
    signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => fail('PREFLIGHT_APPROVAL_TIMEOUT'), 120000);
    input.resume();
  });
}

async function main(writeMode = false) {
  requireCondition(
    process.env.PAYMENT_SURPLUS_TEMP_ALLOW_RUN === 'YES',
    'RUN_NOT_APPROVED',
  );
  const rawUrl = process.env.PAYMENT_SURPLUS_TEST_ADMIN_URL;
  const clusterId = process.env.PAYMENT_SURPLUS_TEST_CLUSTER_ID;
  const directory = process.env.PAYMENT_SURPLUS_TEST_DATA_DIRECTORY;
  const port = process.env.PAYMENT_SURPLUS_TEST_PORT;
  requireCondition(
    rawUrl &&
      /^\d+$/.test(clusterId ?? '') &&
      directory &&
      /^\d+$/.test(port ?? '') &&
      Number(port) > 0 &&
      Number(port) < 65536,
    'APPROVED_TEST_CLUSTER_CONFIGURATION_REQUIRED',
  );
  assertApprovedConfiguration(clusterId, directory, port);
  const approved = parseTestUrl(rawUrl);
  requireCondition(
    ['postgres:', 'postgresql:'].includes(approved.protocol) &&
      approved.hostname === '127.0.0.1' &&
      approved.port === port &&
      approved.pathname === '/postgres' &&
      !approved.search &&
      !approved.hash,
    'ONLY_EXPLICIT_LOCAL_TEST_MAINTENANCE_ENDPOINT_ALLOWED',
  );
  function credential(key) {
    const value = process.env[key];
    requireCondition(value, 'SEPARATE_TEST_CREDENTIAL_REQUIRED');
    const url = parseTestUrl(value);
    requireCondition(
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
        url.hostname === approved.hostname &&
        url.port === port &&
        url.pathname === '/postgres' &&
        !url.search &&
        !url.hash &&
        url.username,
      'CREDENTIAL_MUST_USE_APPROVED_TEST_ENDPOINT',
    );
    return url;
  }
  const migrationCredential = credential('PAYMENT_SURPLUS_TEST_WRITER_URL');
  const readerCredential = credential('PAYMENT_SURPLUS_TEST_READER_URL');
  const roleNames = [approved, migrationCredential, readerCredential].map(
    (url) => decodeURIComponent(url.username),
  );
  requireCondition(
    roleNames.every(Boolean) && new Set(roleNames).size === 3,
    'THREE_DISTINCT_TEST_ROLES_REQUIRED',
  );

  const name = `ttv_surplus_it_${randomUUID().replaceAll('-', '')}`;
  const token = randomBytes(32).toString('hex');
  const marker = `ttv-surplus-it:${token}`;
  const observationMode = process.env.PAYMENT_SURPLUS_TEST_OBSERVATION_MODE;
  requireCondition(
    ['OBSERVER', 'TEST_ADMIN'].includes(observationMode),
    'PREFLIGHT_CONFIGURATION_INVALID',
  );
  const observationUrl = credential('PAYMENT_SURPLUS_TEST_OBSERVATION_URL');
  requireCondition(
    observationUrl.password &&
      decodeURIComponent(observationUrl.username) ===
        (observationMode === 'OBSERVER' ? 'ttv_surplus_observer' : 'postgres'),
    'PREFLIGHT_CONFIGURATION_INVALID',
  );
  const runContext = {
    runId: randomUUID(),
    mode: writeMode ? 'WRITE_TESTS' : 'READ_TESTS',
    target: name,
    runnerPid: process.pid,
    challenge: randomBytes(32).toString('hex'),
    observationMode,
  };
  const now = () => performance.now();
  const gate = createPreflightRun(runContext, now);
  const link = {
    version: 1,
    runId: runContext.runId,
    mode: runContext.mode,
    target: name,
  };
  const tempUrl = new URL(migrationCredential.toString());
  tempUrl.pathname = `/${name}`;
  const readerUrl = new URL(readerCredential.toString());
  readerUrl.pathname = `/${name}`;
  const migrationRoot = path.join(backend, 'prisma', 'migrations');
  const migrations = fs
    .readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  requireCondition(
    migrations.length === 24 &&
      migrations[23] === '20261103000000_add_payment_surplus_handling',
    'EXACTLY_24_APPROVED_MIGRATIONS_REQUIRED',
  );
  const checksums = new Map(
    migrations.map((migration) => [
      migration,
      sha(
        fs.readFileSync(path.join(migrationRoot, migration, 'migration.sql')),
      ),
    ]),
  );

  const admin = new Client({
    connectionString: approved.toString(),
    ...QUERY_LIMITS,
    options: SESSION_LIMITS,
    application_name: 'ttv-surplus-temp-control',
  });
  let writer;
  let adminConnected = false;
  let created = false;
  let createSubmitted = false;
  let oid;
  let owner;
  let readerOid;
  let failed = false;
  let httpPassed = false;
  let cleanupPassed = false;
  let stage = 'cluster-preflight';
  let interrupted = false;
  let approvalChannel;
  const approvalSignal = new AbortController();
  const children = new Set();
  const constraints = new Set(
    migrations.flatMap((migration) =>
      [
        ...fs
          .readFileSync(
            path.join(migrationRoot, migration, 'migration.sql'),
            'utf8',
          )
          .matchAll(/(?:CONSTRAINT|(?:UNIQUE )?INDEX)\s+"([^"]+)"/g),
      ].map((match) => match[1]),
    ),
  );
  function report(error, extra = {}) {
    const details = {
      stage,
      code: error.safeCode ?? 'OPERATION_FAILED',
      sqlstate: /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : undefined,
      constraint: constraints.has(error.constraint)
        ? error.constraint
        : undefined,
      ...extra,
    };
    console.error(JSON.stringify(details));
  }
  const interrupt = () => {
    interrupted = true;
    approvalSignal.abort();
    for (const child of children) child.kill('SIGTERM'); // Only our own child process.
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const workTimer = setTimeout(() => {
    failed = true;
    report({ safeCode: 'HARNESS_TIMEOUT' });
    runnerStatus('HARNESS_TIMEOUT');
    interrupt(); // Stop our child commands; guarded cleanup still runs.
  }, 300000);
  async function assertCluster(client, database) {
    const row = (
      await client.query(`SELECT current_database() AS db,
      current_setting('server_version_num')::int AS version,
      current_setting('data_directory') AS directory,
      host(inet_server_addr()) AS address, inet_server_port()::text AS port,
      (SELECT system_identifier::text FROM pg_control_system()) AS cluster,
      pg_is_in_recovery() AS recovery`)
    ).rows[0];
    requireCondition(
      row.db === database &&
        row.version >= 170000 &&
        row.version < 180000 &&
        row.address === '127.0.0.1' &&
        row.port === port &&
        row.cluster === clusterId &&
        normalizePath(row.directory) === normalizePath(directory) &&
        !row.recovery,
      'CLUSTER_IDENTITY_MISMATCH',
    );
  }
  async function identity(client = admin) {
    await assertCluster(client, 'postgres');
    return (
      await client.query(
        `SELECT oid::text, datdba::text AS owner,
      pg_catalog.shobj_description(oid, 'pg_database') AS marker
      FROM pg_database WHERE datname = $1`,
        [name],
      )
    ).rows[0];
  }
  async function assertOwned(client = admin) {
    if (client === admin) requireCondition(!interrupted, 'RUN_INTERRUPTED');
    requireCondition(
      created && /^ttv_surplus_it_[a-f0-9]{32}$/.test(name) && oid && owner,
      'DATABASE_NOT_CREATED_BY_THIS_PROCESS',
    );
    const row = await identity(client);
    if (client === admin) requireCondition(!interrupted, 'RUN_INTERRUPTED');
    requireCondition(
      row && row.oid === oid && row.owner === owner && row.marker === marker,
      'DATABASE_OWNERSHIP_OR_MARKER_MISMATCH',
    );
  }
  async function assertDirect(client, readOnly = false) {
    requireCondition(!interrupted, 'RUN_INTERRUPTED');
    if (!readOnly) await assertCluster(client, name);
    const row = (
      await client.query(`SELECT current_database() AS db,
      current_user AS role, host(inet_server_addr()) AS address, inet_server_port()::text AS port,
      current_setting('default_transaction_read_only') AS session_ro,
      current_setting('transaction_read_only') AS tx_ro,
      d.oid::text AS oid, d.datdba::text AS owner,
      pg_catalog.shobj_description(d.oid,'pg_database') AS marker
      FROM pg_database d WHERE d.datname=current_database()`)
    ).rows[0];
    requireCondition(
      row &&
        row.db === name &&
        row.oid === oid &&
        row.owner === owner &&
        row.marker === marker &&
        row.port === port &&
        row.address === '127.0.0.1' &&
        row.role === roleNames[readOnly ? 2 : 1] &&
        (!readOnly || (row.session_ro === 'on' && row.tx_ro === 'on')),
      'DIRECT_TEMP_DATABASE_PREFLIGHT_FAILED',
    );
  }
  async function child(args, env, isJest = false) {
    requireCondition(!interrupted, 'RUN_INTERRUPTED');
    const result = await new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, args, {
        cwd: backend,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(processChild);
      let stdout = '',
        stderr = '',
        reason;
      let grace;
      function stop(code) {
        if (reason) return;
        reason = code;
        processChild.kill('SIGTERM');
        grace = setTimeout(() => {
          clearTimeout(timer);
          processChild.unref();
          processChild.stdout.destroy();
          processChild.stderr.destroy();
          const error = new Error('CHILD_NOT_CLOSED');
          error.safeCode = 'CHILD_NOT_CLOSED';
          reject(error); // Keep child in Set: cleanup MUST refuse DROP.
        }, 15000);
      }
      const timer = setTimeout(() => stop('CHILD_TIMEOUT'), 120000);
      for (const [stream, key] of [
        [processChild.stdout, 'stdout'],
        [processChild.stderr, 'stderr'],
      ]) {
        stream.on('data', (buffer) => {
          const text = buffer.toString('utf8');
          if (stdout.length + stderr.length + text.length > 4 * 1024 * 1024) {
            stop('CHILD_OUTPUT_LIMIT');
            return;
          }
          if (key === 'stdout') stdout += text;
          else stderr += text;
        });
      }
      processChild.on('error', () => stop('CHILD_START_FAILED'));
      processChild.once('close', (exitCode, signal) => {
        clearTimeout(timer);
        clearTimeout(grace);
        children.delete(processChild);
        resolve({ stdout, stderr, exitCode, signal, reason });
      });
    });
    // Only structured, whitelisted metadata is ever printed, never raw output.
    const migration = /Migration name:\s*([a-zA-Z0-9_]+)/.exec(
      result.stderr,
    )?.[1];
    const sqlstate = /Database error code:\s*([0-9A-Z]{5})/.exec(
      result.stderr,
    )?.[1];
    const constraint = /constraint "([^"]+)"/.exec(result.stderr)?.[1];
    const childMetadata = {
      exitCode: result.exitCode,
      signal: ['SIGTERM', 'SIGINT'].includes(result.signal)
        ? result.signal
        : undefined,
      sqlstate,
      migration: migrations.includes(migration) ? migration : undefined,
      constraint: constraints.has(constraint) ? constraint : undefined,
    };
    if (isJest) {
      let summary;
      try {
        summary = JSON.parse(result.stdout);
      } catch {
        /* Fail closed below. */
      }
      const assertions =
        summary?.testResults?.flatMap((suite) => suite.assertionResults) ?? [];
      const failureText = (summary?.testResults ?? [])
        .flatMap((suite) => [
          suite.message ?? '',
          ...(suite.assertionResults ?? []).flatMap(
            (test) => test.failureMessages ?? [],
          ),
        ])
        .join('\n');
      const harnessReasons = new Set([
        'IDENTITY_READONLY_MISMATCH',
        'POOL_SESSIONS_UNVERIFIED',
        'INVALID_READER_URL',
        'FIXTURE_IDENTITIES_MISSING',
        'AUTH_FIXTURES_INVALID',
        'PAYMENT_FIXTURE_MISSING',
        'REFERENCE_OVERALLOCATED',
        'OPERATION_FAILED',
      ]);
      const harnessReason = /reason=([A-Z_]+)/.exec(failureText)?.[1];
      childMetadata.sqlstate =
        /SQLSTATE=([0-9A-Z]{5})\b/.exec(failureText)?.[1] ?? sqlstate;
      childMetadata.harnessReason = harnessReasons.has(harnessReason)
        ? harnessReason
        : undefined;
      childMetadata.prismaCode = /Prisma=(P\d{4})\b/.exec(failureText)?.[1];
      const { cases: statuses, passed: allPassed } = testSummary(
        summary,
        writeMode,
      );
      console.log(JSON.stringify({ stage: 'http-results', cases: statuses }));
      if (!allPassed) {
        const error = new Error(
          writeMode ? 'ALL_WRITE_CASES_REQUIRED' : 'FOUR_HTTP_PASSES_REQUIRED',
        );
        error.safeCode = writeMode
          ? 'ALL_WRITE_CASES_REQUIRED'
          : 'FOUR_HTTP_PASSES_REQUIRED';
        report(error, childMetadata);
        throw error;
      }
    }
    if (result.reason || result.exitCode !== 0 || interrupted) {
      const error = new Error('CHILD_COMMAND_FAILED');
      error.safeCode =
        result.reason ??
        (interrupted ? 'RUN_INTERRUPTED' : 'CHILD_COMMAND_FAILED');
      report(error, childMetadata);
      throw error;
    }
  }

  try {
    const approval = readRunApproval(
      process.stdin,
      gate,
      approvalSignal.signal,
    );
    console.log(JSON.stringify(gate.request()));
    approvalChannel = await approval;
    requireCondition(
      approvalChannel.isOpen() && !interrupted,
      'PREFLIGHT_CHANNEL_CLOSED',
    );
    await admin.connect();
    adminConnected = true;
    await assertCluster(admin, 'postgres');
    const roles = (
      await admin.query(
        `SELECT oid::text, rolname, rolcanlogin,
      rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname=ANY($1::text[])`,
        [roleNames],
      )
    ).rows;
    const lifecycleRole = roles.find((role) => role.rolname === roleNames[0]);
    const writerRole = roles.find((role) => role.rolname === roleNames[1]);
    const readerRole = roles.find((role) => role.rolname === roleNames[2]);
    requireCondition(
      roles.length === 3 &&
        writerRole &&
        readerRole &&
        [writerRole, readerRole].every(
          (role) =>
            role.rolcanlogin &&
            !role.rolsuper &&
            !role.rolcreatedb &&
            !role.rolcreaterole &&
            !role.rolreplication &&
            !role.rolbypassrls,
        ),
      'DEDICATED_UNPRIVILEGED_WRITER_AND_READER_REQUIRED',
    );
    requireCondition(
      lifecycleRole?.rolcanlogin === true &&
        lifecycleRole.rolcreatedb === true &&
        lifecycleRole.rolsuper === false &&
        lifecycleRole.rolcreaterole === false &&
        lifecycleRole.rolreplication === false &&
        lifecycleRole.rolbypassrls === false,
      'LIFECYCLE_CREATEDB_WITHOUT_ADMIN_PRIVILEGES_REQUIRED',
    );
    const lifecycleMembership = (
      await admin.query(
        `SELECT current_user = $3::name AS lifecycle_identity,
          EXISTS (
            SELECT 1 FROM pg_auth_members
            WHERE roleid = $2::oid AND member = $1::oid
              AND set_option IS TRUE AND inherit_option IS TRUE
              AND admin_option IS FALSE
          ) AS direct_writer_membership,
          pg_has_role($2::oid, $1::oid, 'MEMBER') AS reverse_membership`,
        [lifecycleRole.oid, writerRole.oid, lifecycleRole.rolname],
      )
    ).rows[0];
    requireCondition(
      lifecycleMembership?.lifecycle_identity === true,
      'LIFECYCLE_ROLE_IDENTITY_MISMATCH',
    );
    requireCondition(
      lifecycleMembership.direct_writer_membership === true,
      'LIFECYCLE_DIRECT_WRITER_SET_INHERIT_REQUIRED',
    );
    requireCondition(
      lifecycleMembership.reverse_membership === false,
      'REVERSE_LIFECYCLE_WRITER_MEMBERSHIP_FORBIDDEN',
    );
    // Only the writer may be granted directly to lifecycle. The sole additional
    // reachable role is pg_read_all_settings, inherited through that writer.
    // MEMBER also rejects disabled/uninherited edges; USAGE/SET check effective
    // inherited privileges and SET ROLE reachability explicitly.
    const lifecycleScope = (
      await admin.query(
        `SELECT
          NOT EXISTS (
            SELECT 1 FROM pg_auth_members
            WHERE member = $1::oid AND roleid <> $2::oid
          ) AS direct_memberships_allowed,
          NOT EXISTS (
            SELECT 1 FROM pg_roles r
            WHERE r.oid <> $1::oid
              AND r.oid <> $2::oid
              AND r.rolname <> 'pg_read_all_settings'
              AND (pg_has_role($1::oid, r.oid, 'MEMBER')
                OR pg_has_role($1::oid, r.oid, 'USAGE')
                OR pg_has_role($1::oid, r.oid, 'SET'))
          ) AS reachable_roles_allowed`,
        [lifecycleRole.oid, writerRole.oid],
      )
    ).rows[0];
    requireCondition(
      lifecycleScope?.direct_memberships_allowed === true &&
        lifecycleScope.reachable_roles_allowed === true,
      'LIFECYCLE_ROLE_MEMBERSHIP_OUTSIDE_ALLOWLIST',
    );
    readerOid = readerRole.oid;
    const unsafeMembership = await admin.query(
      `SELECT 1 FROM pg_roles r
      WHERE (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR r.rolname IN ('pg_write_all_data','pg_read_all_data','pg_execute_server_program',
          'pg_read_server_files','pg_write_server_files'))
      AND (pg_has_role($1::oid,r.oid,'MEMBER') OR pg_has_role($2::oid,r.oid,'MEMBER'))
      UNION ALL SELECT 1 WHERE pg_has_role($2::oid,$1::oid,'MEMBER')`,
      [writerRole.oid, readerOid],
    );
    requireCondition(
      unsafeMembership.rowCount === 0,
      'TEST_ROLE_MEMBERSHIP_TOO_BROAD',
    );
    const writerCanReadSettings = (
      await admin.query(
        "SELECT pg_has_role($1::oid,'pg_read_all_settings','USAGE') AS allowed",
        [writerRole.oid],
      )
    ).rows[0];
    requireCondition(
      writerCanReadSettings.allowed,
      'WRITER_CANNOT_VERIFY_CLUSTER_SETTINGS',
    );
    await assertNoExistingDatabaseCreate(admin, writerRole.oid, readerOid);
    const rolesCollectedAt = now();
    const metadataCollectedAt = now();
    const metadataProof = await collectPreflightMetadata(approved.toString(), {
      Client,
    });
    requireCondition(
      metadataProof.verification === 'VERIFIED',
      'PREFLIGHT_EVIDENCE_INVALID',
    );
    const ownConnection = (
      await admin.query(`SELECT pg_backend_pid()::text AS pid,
      to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS backend_start,
      datid::text AS database_oid, usesysid::text AS role_oid
      FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()`)
    ).rows[0];
    const sessionsCollectedAt = now();
    const sessionProof = await inspectSessions(observationUrl.toString(), {
      Client,
      mode: observationMode,
    });
    const identityProof = metadataProof.identity;
    const evidence = {
      ...link,
      identity: {
        ...link,
        verification: 'VERIFIED',
        collectedAt: metadataCollectedAt,
        host: identityProof.host,
        port: identityProof.port,
        database: identityProof.db,
        cluster: identityProof.cluster,
        directory: identityProof.directory,
        postmasterStart: identityProof.postmaster_start,
      },
      roles: {
        ...link,
        verification: 'VERIFIED',
        collectedAt: rolesCollectedAt,
        lifecycleOid: lifecycleRole.oid,
        writerOid: writerRole.oid,
        readerOid,
        existingRunnerChecksPassed: true,
      },
      metadata: {
        ...link,
        verification: metadataProof.verification,
        collectedAt: metadataCollectedAt,
        scope: metadataProof.scope,
        blockers: metadataProof.blockers,
        roleOids: metadataProof.checks.objects.roles.map((r) => r.role_oid),
        databaseOid: metadataProof.checks.database_oid,
        snapshotMatched: metadataProof.checks.snapshotMatched,
      },
      sessions: {
        ...link,
        verification: sessionProof.status === 'PASS' ? 'VERIFIED' : 'UNKNOWN',
        collectedAt: sessionsCollectedAt,
        observationMode,
        snapshot: sessionProof,
        expectedConnections: [ownConnection],
      },
    };
    stage = 'create-database';
    requireCondition(!(await identity()), 'TEMP_DATABASE_NAME_ALREADY_EXISTS');
    requireCondition(!interrupted, 'RUN_INTERRUPTED');
    await assertCluster(admin, 'postgres'); // Immediately before CREATE DATABASE.
    requireCondition(!interrupted, 'RUN_INTERRUPTED');
    const decision = gate.evaluate(
      evidence,
      approvalChannel.isOpen(),
      interrupted,
    );
    // Diagnostics never contain the in-memory READY permit or its challenge.
    console.log(
      JSON.stringify({
        surplusStatus: 'PREFLIGHT_RESULT',
        verification: decision.verification,
        readiness: 'NOT_READY',
        code: decision.code,
      }),
    );
    requireCondition(decision.readiness === 'READY', decision.code);
    gate.consume(approvalChannel.isOpen(), interrupted);
    createSubmitted = true;
    await admin.query(
      `CREATE DATABASE ${quote(name)} OWNER ${quote(roleNames[1])} TEMPLATE template0`,
    );
    created = true; // Never set this on a collision/error.
    runnerStatus('TEMP_DB_CREATED');
    const initial = await identity();
    requireCondition(initial, 'NEW_DATABASE_IDENTITY_MISSING');
    oid = initial.oid;
    owner = initial.owner;
    requireCondition(
      initial.marker === null && owner === writerRole.oid,
      'NEW_DATABASE_IDENTITY_UNEXPECTED',
    );
    await assertCluster(admin, 'postgres');
    // marker is hex generated in this process, not interpolated user input.
    await admin.query(`COMMENT ON DATABASE ${quote(name)} IS '${marker}'`);
    await assertOwned();
    // Restrict only this new database. No role creation or global grants.
    await admin.query(`REVOKE ALL ON DATABASE ${quote(name)} FROM PUBLIC`);
    await assertOwned();
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quote(name)} TO ${quote(roleNames[2])}`,
    );

    const identityEnv = {
      PAYMENT_SURPLUS_TEMP_NAME: name,
      PAYMENT_SURPLUS_TEMP_OID: oid,
      PAYMENT_SURPLUS_TEMP_OWNER_OID: owner,
      PAYMENT_SURPLUS_TEMP_TOKEN: token,
      PAYMENT_SURPLUS_TEST_CLUSTER_ID: clusterId,
      PAYMENT_SURPLUS_TEST_DATA_DIRECTORY: directory,
      PAYMENT_SURPLUS_TEST_PORT: port,
    };
    stage = 'migration-direct-preflight';
    // Pinned direct connection using the exact credential and URL passed to Prisma.
    writer = new Client({
      connectionString: tempUrl.toString(),
      ...QUERY_LIMITS,
      options: `${SESSION_LIMITS} -c default_transaction_read_only=off -c TimeZone=UTC`,
    });
    await writer.connect();
    await assertDirect(writer); // Includes DB/OID/owner/marker/cluster/directory/port.
    await closeCleanupClient(writer);
    writer = undefined;
    const migrationEnv = childEnvironment({
      ...identityEnv,
      PAYMENT_SURPLUS_TEMP_MIGRATION_URL: tempUrl.toString(),
      PAYMENT_SURPLUS_TEMP_MIGRATION_ROLE: roleNames[1],
    });
    stage = 'migration';
    await assertOwned();
    await child(
      [
        path.join(backend, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--config',
        path.join(backend, 'prisma.payment-surplus-temp.config.ts'),
      ],
      migrationEnv,
    );
    await assertOwned();

    writer = new Client({
      connectionString: tempUrl.toString(),
      ...QUERY_LIMITS,
      options: `${SESSION_LIMITS} -c default_transaction_read_only=off -c TimeZone=UTC`,
    });
    await writer.connect();
    await assertDirect(writer);
    stage = 'migration-history';
    const history = (
      await writer.query(`SELECT migration_name, checksum, finished_at,
      rolled_back_at FROM public."_prisma_migrations" ORDER BY migration_name`)
    ).rows;
    requireCondition(
      history.length === 24 &&
        history.every(
          (row, index) =>
            row.migration_name === migrations[index] &&
            row.finished_at &&
            !row.rolled_back_at &&
            row.checksum === checksums.get(row.migration_name),
        ),
      'MIGRATION_HISTORY_MISMATCH',
    );
    requireCondition(
      migrations.every(
        (migration) =>
          checksums.get(migration) ===
          sha(
            fs.readFileSync(
              path.join(migrationRoot, migration, 'migration.sql'),
            ),
          ),
      ),
      'MIGRATION_FILES_CHANGED_DURING_RUN',
    );

    runnerStatus('MIGRATION_PASS');
    const fixtures = {
      adminId: randomUUID(),
      userId: randomUUID(),
      paymentId: randomUUID(),
      missingPaymentId: randomUUID(),
      planId: randomUUID(),
      ...(writeMode
        ? {
            writePayments: Object.fromEntries(
              WRITE_CASES.map((id) => [id, randomUUID()]),
            ),
          }
        : {}),
    };
    await assertOwned();
    await assertDirect(writer);
    requireCondition(!interrupted, 'RUN_INTERRUPTED');
    stage = 'fixture';
    await writer.query('BEGIN');
    try {
      for (const [id, role] of [
        [fixtures.adminId, 'ADMIN'],
        [fixtures.userId, 'USER'],
      ]) {
        await writer.query(
          `INSERT INTO public."User" ("id", "email", "role", "updatedAt")
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)`,
          [id, `${id}@example.invalid`, role],
        );
      }
      await writer.query(
        `INSERT INTO public."Plan" ("id", "code", "name", "price", "currency",
        "durationDays", "characterLimit", "updatedAt")
        VALUES ($1, 'SURPLUS_TEST_ONLY', 'Synthetic test plan', 120.10, 'VND', 30, 1000, CURRENT_TIMESTAMP)`,
        [fixtures.planId],
      );
      await writer.query(
        `INSERT INTO public."Payment" ("id", "userId", "planId", "amount", "currency",
        "status", "provider", "effectivePlanPriceSnapshot", "planPriceSnapshot",
        "promotionPriceSnapshot", "planDurationDaysSnapshot", "planCharacterLimitSnapshot", "updatedAt")
        VALUES ($1, $2, $3, 100.10, 'VND', 'PAID', 'SYNTHETIC_TEST',
          100.10, 120.10, 100.10, 30, 1000, CURRENT_TIMESTAMP)`,
        [fixtures.paymentId, fixtures.userId, fixtures.planId],
      );
      for (const amount of ['80.10', '70.20']) {
        const id = randomUUID();
        await writer.query(
          `INSERT INTO public."PaymentTransaction" ("id", "paymentId", "provider",
          "providerTransactionId", "amount", "currency", "status", "updatedAt")
          VALUES ($1, $2, 'SYNTHETIC_TEST', $1, $3, 'VND', 'MATCHED', CURRENT_TIMESTAMP)`,
          [id, fixtures.paymentId, amount],
        );
      }
      for (const [status, amount] of [
        ['PENDING', '10.05'],
        ['COMPLETED', '15.10'],
        ['CANCELLED', '99.99'],
      ]) {
        await writer.query(
          `INSERT INTO public."PaymentSurplusHandling" ("id", "paymentId", "action",
          "status", "amount", "currency", "idempotencyKey", "createdById", "completedById",
          "completedAt", "cancelledById", "cancelledAt", "effectivePlanPriceSnapshot", "updatedAt")
          VALUES ($1, $2, 'REFUND', $3::"PaymentSurplusStatus", $4, 'VND', $1, $5,
            CASE WHEN $3 = 'COMPLETED' THEN $5 END,
            CASE WHEN $3 = 'COMPLETED' THEN CURRENT_TIMESTAMP END,
            CASE WHEN $3 = 'CANCELLED' THEN $5 END,
            CASE WHEN $3 = 'CANCELLED' THEN CURRENT_TIMESTAMP END, 100.10, CURRENT_TIMESTAMP)`,
          [randomUUID(), fixtures.paymentId, status, amount, fixtures.adminId],
        );
      }
      if (writeMode) {
        for (const [caseId, paymentId] of Object.entries(
          fixtures.writePayments,
        )) {
          await writer.query(
            `INSERT INTO public."Payment" ("id","userId","planId","amount","currency","status","provider",
            "effectivePlanPriceSnapshot","planPriceSnapshot","promotionPriceSnapshot","creditAmount",
            "planDurationDaysSnapshot","planCharacterLimitSnapshot","updatedAt")
            VALUES ($1,$2,$3,80.10,'VND',$4,'SYNTHETIC_TEST',100.10,120.10,100.10,20,30,1000,CURRENT_TIMESTAMP)`,
            [
              paymentId,
              fixtures.userId,
              fixtures.planId,
              caseId === 'WRITE_PAID_ONLY' ? 'PENDING' : 'PAID',
            ],
          );
          await writer.query(
            `INSERT INTO public."PaymentTransaction" ("id","paymentId","provider","providerTransactionId",
            "amount","currency","status","updatedAt") VALUES ($1,$2,'SYNTHETIC_TEST',$1,130.30,'VND','MATCHED',CURRENT_TIMESTAMP)`,
            [randomUUID(), paymentId],
          );
        }
      }
      await writer.query('COMMIT');
    } catch (error) {
      await writer.query('ROLLBACK');
      throw error;
    }
    stage = 'reader-grants';
    await assertOwned();
    await assertDirect(writer);
    await writer.query(
      `GRANT USAGE ON SCHEMA public TO ${quote(roleNames[2])}`,
    );
    await assertOwned();
    await assertDirect(writer);
    await writer.query(`GRANT SELECT ON TABLE public."User", public."Payment",
      public."PaymentTransaction", public."PaymentSurplusHandling" TO ${quote(roleNames[2])}`);
    const readerPrivileges = (
      await writer.query(
        `SELECT
      has_database_privilege($1::oid,current_database(),'CREATE') OR
      has_database_privilege($1::oid,current_database(),'TEMP') OR
      has_schema_privilege($1::oid,'public','CREATE') OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
        AND has_table_privilege($1::oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      ) AS unsafe`,
        [readerOid],
      )
    ).rows[0];
    requireCondition(!readerPrivileges.unsafe, 'READER_HAS_WRITE_PRIVILEGES');
    await closeCleanupClient(writer);
    writer = undefined; // No fixture writer survives into API tests.
    stage = 'reader-preflight';
    const readonlyUrl = new URL(readerUrl.toString());
    readonlyUrl.searchParams.set(
      'options',
      `${SESSION_LIMITS} -c default_transaction_read_only=on`,
    );
    const reader = new Client({
      connectionString: readonlyUrl.toString(),
      ...QUERY_LIMITS,
      options: `${SESSION_LIMITS} -c default_transaction_read_only=on`,
    });
    try {
      await reader.connect();
      await assertDirect(reader, true);
    } finally {
      await closeCleanupClient(reader);
    }

    const config = {
      rootDir: backend,
      testMatch: [
        '<rootDir>/test/payment-surplus-temp.integration.e2e-spec.ts',
      ],
      moduleFileExtensions: ['js', 'json', 'ts'],
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
      transform: {
        '^.+\\.[tj]s$': [
          'ts-jest',
          {
            useESM: false,
            tsconfig: {
              allowJs: true,
              module: 'CommonJS',
              moduleResolution: 'Node',
              isolatedModules: true,
              resolvePackageJsonExports: false,
              resolvePackageJsonImports: false,
            },
          },
        ],
      },
      transformIgnorePatterns: [
        'node_modules[/\\\\](?!@nestjs[/\\\\](jwt|passport)[/\\\\])',
      ],
      testEnvironment: 'node',
      testTimeout: 30000,
    };
    await assertOwned();
    stage = 'http';
    await child(
      [
        path.join(backend, 'node_modules/jest/bin/jest.js'),
        '--config',
        JSON.stringify(config),
        '--runInBand',
        '--json',
      ],
      childEnvironment({
        ...(writeMode
          ? {
              PAYMENT_SURPLUS_TEMP_WRITE_MODE: '1',
              PAYMENT_SURPLUS_TEMP_WRITER_URL: tempUrl.toString(),
              PAYMENT_SURPLUS_TEMP_WRITER_ROLE: roleNames[1],
            }
          : {}),
        PAYMENT_SURPLUS_TEMP_NAME: name,
        PAYMENT_SURPLUS_TEMP_OID: oid,
        PAYMENT_SURPLUS_TEMP_OWNER_OID: owner,
        PAYMENT_SURPLUS_TEMP_TOKEN: token,
        PAYMENT_SURPLUS_TEST_CLUSTER_ID: clusterId,
        PAYMENT_SURPLUS_TEST_DATA_DIRECTORY: directory,
        PAYMENT_SURPLUS_TEST_PORT: port,
        PAYMENT_SURPLUS_TEMP_READONLY_URL: readerUrl.toString(),
        PAYMENT_SURPLUS_TEMP_READER_ROLE: roleNames[2],
        PAYMENT_SURPLUS_TEMP_FIXTURES: JSON.stringify(fixtures),
      }),
      true,
    );
    await assertOwned(); // Full privileged cluster validation after HTTP, before PASS.
    httpPassed = true;
    runnerStatus('JEST_PASS');
  } catch (error) {
    failed = true;
    report(error);
    if (createSubmitted && !created)
      runnerStatus('TEMP_DB_CREATE_OUTCOME_UNKNOWN');
    runnerStatus(
      stage === 'cluster-preflight' || stage === 'migration-direct-preflight'
        ? 'PREFLIGHT_FAILED'
        : stage === 'migration' || stage === 'migration-history'
          ? 'MIGRATION_FAILED'
          : stage === 'http'
            ? 'JEST_FAILED'
            : 'SETUP_FAILED',
    );
  } finally {
    clearTimeout(workTimer);
    stage = 'cleanup-writer';
    try {
      if (writer) {
        await closeCleanupClient(writer);
        writer = undefined;
      }
    } catch (error) {
      failed = true;
      report(error);
      runnerStatus('CLEANUP_FAILED');
    }
    if (created && adminConnected) {
      let dropState = 'DROP_REFUSED';
      const cleanupClient = {
        query: (...args) => cleanupDeadline(() => admin.query(...args)),
      };
      try {
        stage = 'cleanup-database';
        requireCondition(children.size === 0, 'CHILD_LIFECYCLE_NOT_SETTLED');
        requireCondition(!writer, 'WRITER_LIFECYCLE_NOT_SETTLED');
        // Session-local limits only, never change server configuration.
        await cleanupClient.query("SET statement_timeout = '5s'");
        await cleanupClient.query("SET lock_timeout = '2s'");
        await assertOwned(cleanupClient);
        // Briefly wait for orderly disconnects, never terminate any backend.
        let active;
        for (let attempt = 0; attempt < 10; attempt++) {
          active = await cleanupClient.query(
            'SELECT 1 FROM pg_stat_activity WHERE datid=$1::oid',
            [oid],
          );
          if (active.rowCount === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        requireCondition(
          active.rowCount === 0,
          'DATABASE_STILL_HAS_CONNECTIONS',
        );
        // No await between this final verification and submitting DROP.
        // This narrows, but cannot atomically eliminate, concurrent DDL races.
        await assertOwned(cleanupClient);
        dropState = 'DROP_OUTCOME_UNKNOWN';
        try {
          await cleanupClient.query(`DROP DATABASE ${quote(name)}`);
        } catch (error) {
          // Only explicit server rejections establish that DROP failed.
          if (
            ['42501', '55006', '3D000', '57014', '55P03'].includes(error.code)
          )
            dropState = 'DROP_FAILED';
          throw error;
        }
        await verifyDatabaseDropped(cleanupClient, name, oid, assertCluster);
        cleanupPassed = true;
        runnerStatus('CLEANUP_PASS');
        console.log(
          'Cleanup PASS: only this process-owned temporary database removed',
        );
      } catch (error) {
        failed = true;
        report(error, { dropState });
        runnerStatus(
          dropState === 'DROP_OUTCOME_UNKNOWN'
            ? 'DROP_OUTCOME_UNKNOWN'
            : 'CLEANUP_FAILED',
        );
        console.error(
          `Cleanup ${dropState}: target ${name}; OID ${oid ?? 'unknown'}; database existence not confirmed`,
        );
      }
    }
    if (adminConnected) {
      try {
        await closeCleanupClient(admin);
      } catch (error) {
        failed = true;
        report(error);
        runnerStatus('CLEANUP_FAILED');
      }
    }
    approvalChannel?.dispose();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (failed || interrupted) process.exitCode = 1;
    else if (httpPassed && cleanupPassed && !interrupted) {
      runnerStatus('HARNESS_PASS');
      console.log(
        writeMode
          ? 'PASS: all mandatory REFUND/CREDIT scenarios, independent read-only postchecks; cleanup confirmed'
          : 'PASS: synthetic 401/403/404/200; read-only API and independent Decimal SELECT; cleanup confirmed',
      );
    }
  }
}
if (require.main === module) {
  // Strict dispatch: verify cannot fall through to lifecycle execution.
  const args = process.argv.slice(2);
  const verifyOnly =
    args.length === 1 && args[0] === '--verify-migration-target';
  const execute = async () => {
    if (verifyOnly) return verifyMigrationTarget();
    const writeMode = args.length === 1 && args[0] === '--write-tests';
    requireCondition(
      args.length === 0 || writeMode,
      'UNSUPPORTED_RUNNER_ARGUMENTS',
    );
    return main(writeMode);
  };
  execute().catch((error) => {
    if (!verifyOnly) runnerStatus('PREFLIGHT_FAILED');
    const code = /^[A-Z_]+$/.test(error.safeCode ?? '')
      ? error.safeCode
      : 'INVALID_CONFIGURATION';
    console.error(
      JSON.stringify({
        stage: verifyOnly ? 'verify-migration-target' : 'configuration',
        code,
        sqlstate: /^[0-9A-Z]{5}$/.test(error.code ?? '')
          ? error.code
          : undefined,
      }),
    );
    process.exitCode = 1;
  });
}
