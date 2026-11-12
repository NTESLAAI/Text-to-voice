'use strict';
// Standalone SELECT-only inspection. Importing this file never connects.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const TARGET = Object.freeze({
  name: 'ttv_surplus_it_f646e091562849a38743a12b41e8ec2f',
  oid: '16393',
  owner: 'ttv_surplus_writer',
  ownerOid: '16389',
  role: 'ttv_surplus_lifecycle',
  cluster: '7703979600700924132',
  directory: 'd:/text-to-voice/pg-test-cluster',
});
const hash = (value) => createHash('sha256').update(value).digest('hex');
const normalize = (value) =>
  value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
function fail(reason) {
  const error = new Error(reason);
  error.inspectionReason = reason;
  throw error;
}
function localMigrations() {
  const root = path.resolve(__dirname, '../prisma/migrations');
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      checksum: hash(
        fs.readFileSync(path.join(root, entry.name, 'migration.sql')),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
const identitySql = `SELECT current_database() AS db, current_user AS role,
  session_user AS session_role, host(inet_server_addr()) AS host,
  inet_server_port()::text AS port,
  (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
  current_setting('data_directory') AS directory,
  current_setting('default_transaction_read_only') AS session_ro,
  current_setting('transaction_read_only') AS tx_ro,
  d.datname AS name, d.oid::text AS oid, d.datdba::text AS owner_oid,
  pg_catalog.pg_get_userbyid(d.datdba) AS owner,
  pg_catalog.shobj_description(d.oid, 'pg_database') AS marker
  FROM pg_catalog.pg_database d WHERE d.datname=$1`;
const clusterSql = `SELECT current_database() AS db, current_user AS role,
  session_user AS session_role, host(inet_server_addr()) AS host,
  inet_server_port()::text AS port,
  (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS cluster,
  current_setting('data_directory') AS directory,
  current_setting('default_transaction_read_only') AS session_ro,
  current_setting('transaction_read_only') AS tx_ro`;

async function inspect(raw, { Client, readMigrations = localMigrations }) {
  let client;
  let lost = false;
  let result = { status: 'UNKNOWN', reason: 'INSPECTION_FAILED' };
  async function close() {
    if (!client) return;
    const closing = client;
    let timer;
    try {
      await Promise.race([
        closing.end(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('CLOSE_TIMEOUT')), 3000);
        }),
      ]);
      client = undefined;
    } catch {
      try {
        closing.unref();
      } catch {
        /* No backend termination. */
      }
      throw new Error('CLOSE_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }
  async function connect(url, database, expectedMarker) {
    client = new Client({
      connectionString: url.toString(),
      options:
        '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000',
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      application_name: 'ttv-surplus-target-inspection',
    });
    client.on('error', () => {
      lost = true;
    });
    await client.connect();
    // Verify the endpoint before reading even the target's catalog metadata.
    const endpoint = (await client.query(clusterSql)).rows[0];
    if (
      !endpoint ||
      endpoint.db !== database ||
      endpoint.role !== TARGET.role ||
      endpoint.session_role !== TARGET.role ||
      endpoint.host !== '127.0.0.1' ||
      endpoint.port !== '55432' ||
      endpoint.cluster !== TARGET.cluster ||
      typeof endpoint.directory !== 'string' ||
      normalize(endpoint.directory) !== TARGET.directory ||
      endpoint.session_ro !== 'on' ||
      endpoint.tx_ro !== 'on' ||
      lost
    )
      fail('IDENTITY_MISMATCH');
    const row = (await client.query(identitySql, [TARGET.name])).rows[0];
    if (
      !row ||
      row.db !== database ||
      row.role !== TARGET.role ||
      row.session_role !== TARGET.role ||
      row.host !== '127.0.0.1' ||
      row.port !== '55432' ||
      row.cluster !== TARGET.cluster ||
      typeof row.directory !== 'string' ||
      normalize(row.directory) !== TARGET.directory ||
      row.session_ro !== 'on' ||
      row.tx_ro !== 'on' ||
      row.name !== TARGET.name ||
      row.oid !== TARGET.oid ||
      row.owner !== TARGET.owner ||
      row.owner_oid !== TARGET.ownerOid ||
      lost
    ) {
      fail('IDENTITY_MISMATCH');
    }
    if (
      typeof row.marker !== 'string' ||
      !/^ttv-surplus-it:[0-9a-f]{64}$/.test(row.marker) ||
      (expectedMarker !== undefined && row.marker !== expectedMarker)
    ) {
      fail('MARKER_MISMATCH');
    }
    return row.marker;
  }
  try {
    if (
      typeof raw !== 'string' ||
      !/^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\/postgres$/.test(
        raw,
      ) ||
      /[\s\\?#]/.test(raw) ||
      /%(?![0-9a-f]{2})/i.test(raw)
    )
      fail('URL_REJECTED');
    let url;
    try {
      url = new URL(raw);
    } catch {
      fail('URL_REJECTED');
    }
    if (
      url.hostname !== '127.0.0.1' ||
      url.port !== '55432' ||
      url.pathname !== '/postgres' ||
      url.search ||
      url.hash ||
      !url.password ||
      decodeURIComponent(url.username) !== TARGET.role
    ) {
      fail('URL_REJECTED');
    }
    const expected = readMigrations();
    if (
      expected.length !== 24 ||
      expected[23].name !== '20261103000000_add_payment_surplus_handling'
    )
      fail('LOCAL_MIGRATIONS_INVALID');
    const marker = await connect(url, 'postgres');
    await close(); // A close failure prevents the second connection.
    url.pathname = `/${TARGET.name}`;
    await connect(url, TARGET.name, marker);
    const tables = (
      await client.query(`SELECT c.relkind FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='_prisma_migrations'`)
    ).rows;
    if (!tables.length) {
      result = { status: 'UNKNOWN', reason: 'HISTORY_NOT_FOUND' };
    } else {
      if (tables.length !== 1 || tables[0].relkind !== 'r')
        fail('HISTORY_OBJECT_INVALID');
      // Explicit columns only. Never read the Prisma logs column or business data.
      const history = (
        await client.query(`SELECT migration_name, checksum, started_at,
        finished_at, rolled_back_at, applied_steps_count
        FROM public."_prisma_migrations" ORDER BY migration_name`)
      ).rows;
      const expectedByName = new Map(
        expected.map((row) => [row.name, row.checksum]),
      );
      const date = (value) => {
        if (value === null) return null;
        if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
          fail('HISTORY_DATA_INVALID');
        return value.toISOString();
      };
      const rows = history.map((row) => {
        if (
          typeof row.checksum !== 'string' ||
          !/^[0-9a-f]{64}$/i.test(row.checksum) ||
          !Number.isInteger(row.applied_steps_count) ||
          row.applied_steps_count < 0
        )
          fail('HISTORY_DATA_INVALID');
        return {
          migration_name: expectedByName.has(row.migration_name)
            ? row.migration_name
            : 'UNEXPECTED_MIGRATION',
          checksum: row.checksum.toLowerCase(),
          started_at: date(row.started_at),
          finished_at: date(row.finished_at),
          rolled_back_at: date(row.rolled_back_at),
          applied_steps_count: row.applied_steps_count,
          checksum_matches:
            expectedByName.get(row.migration_name) === row.checksum,
        };
      });
      const current = readMigrations();
      if (JSON.stringify(current) !== JSON.stringify(expected))
        fail('LOCAL_MIGRATIONS_CHANGED');
      const complete =
        history.length === expected.length &&
        history.every(
          (row, i) =>
            row.migration_name === expected[i].name &&
            row.checksum === expected[i].checksum &&
            row.started_at !== null &&
            row.finished_at !== null &&
            row.rolled_back_at === null,
        );
      result = {
        status: complete ? 'PASS' : 'FAIL',
        reason: complete ? 'HISTORY_MATCHES' : 'HISTORY_INCOMPLETE_OR_DIFFERS',
        history: rows,
      };
    }
    result.database = TARGET.name;
    result.oid = TARGET.oid;
    result.owner = TARGET.owner;
    result.ownerOid = TARGET.ownerOid;
    result.markerFingerprint = hash(marker);
    result.origin = 'UNVERIFIED';
  } catch (error) {
    result = error.inspectionReason
      ? { status: 'FAIL', reason: error.inspectionReason }
      : {
          status: 'UNKNOWN',
          reason:
            error.code === '42501'
              ? 'INSUFFICIENT_PRIVILEGE'
              : 'QUERY_OR_CONNECTION_FAILED',
        };
  } finally {
    try {
      await close();
    } catch {
      result = { status: 'UNKNOWN', reason: 'CONNECTION_CLOSE_FAILED' };
    }
    if (lost) result = { status: 'UNKNOWN', reason: 'CONNECTION_LOST' };
  }
  return result;
}
module.exports = { inspect };
if (require.main === module) {
  (async () => {
    const { Client } = require('pg');
    let result;
    try {
      result = await inspect(process.env.SURPLUS_TARGET_URL, { Client });
    } finally {
      delete process.env.SURPLUS_TARGET_URL;
    }
    process.stdout.write(JSON.stringify(result));
    process.exitCode = result.status === 'PASS' ? 0 : 1;
  })().catch(() => {
    process.stdout.write(
      JSON.stringify({ status: 'UNKNOWN', reason: 'INSPECTION_FAILED' }),
    );
    process.exitCode = 1;
  });
}
