import { defineConfig } from 'prisma/config';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const APPROVED_TEST = Object.freeze({
  host: '127.0.0.1',
  port: '55432',
  cluster: '7703979600700924132',
  directory: 'd:/text-to-voice/pg-test-cluster',
});
const normalizePath = (value: string) =>
  value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

// No dotenv import and no fallback to the application's connection configuration.
// Intended only for the guarded test runner, never for a manual production command.
const name = process.env.PAYMENT_SURPLUS_TEMP_NAME;
const rawUrl = process.env.PAYMENT_SURPLUS_TEMP_MIGRATION_URL;
const token = process.env.PAYMENT_SURPLUS_TEMP_TOKEN;
if (
  !name ||
  !/^ttv_surplus_it_[a-f0-9]{32}$/.test(name) ||
  !rawUrl ||
  !token ||
  !/^[a-f0-9]{64}$/.test(token) ||
  !process.env.PAYMENT_SURPLUS_TEMP_MIGRATION_ROLE ||
  !process.env.PAYMENT_SURPLUS_TEST_CLUSTER_ID ||
  !process.env.PAYMENT_SURPLUS_TEST_DATA_DIRECTORY ||
  !process.env.PAYMENT_SURPLUS_TEST_PORT ||
  !/^\d+$/.test(process.env.PAYMENT_SURPLUS_TEMP_OID ?? '') ||
  !/^\d+$/.test(process.env.PAYMENT_SURPLUS_TEMP_OWNER_OID ?? '')
)
  throw new Error('Guarded temporary database configuration required');

if (
  process.env.PAYMENT_SURPLUS_TEST_PORT !== APPROVED_TEST.port ||
  process.env.PAYMENT_SURPLUS_TEST_CLUSTER_ID !== APPROVED_TEST.cluster ||
  normalizePath(process.env.PAYMENT_SURPLUS_TEST_DATA_DIRECTORY!) !==
    APPROVED_TEST.directory ||
  !/^postgres(?:ql)?:\/\/[^/?#\s]+@127\.0\.0\.1:55432\//.test(rawUrl) ||
  /[\s\\]/.test(rawUrl)
)
  throw new Error('Fixed isolated test cluster required');
let url: URL;
try {
  url = new URL(rawUrl);
} catch {
  throw new Error('Invalid temporary database URL');
}
if (
  !['postgres:', 'postgresql:'].includes(url.protocol) ||
  url.hostname !== APPROVED_TEST.host ||
  url.search ||
  url.hash ||
  decodeURIComponent(url.username) !==
    process.env.PAYMENT_SURPLUS_TEMP_MIGRATION_ROLE ||
  url.port !== APPROVED_TEST.port ||
  decodeURIComponent(url.pathname) !== `/${name}`
)
  throw new Error('Temporary database URL does not match approved test target');

// An environment flag is not proof. Reverify the real target on every config load.
// The child uses a SELECT-only branch and cannot invoke Prisma or lifecycle code.
const osKeys = new Set([
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
const verifierKeys = new Set([
  'PAYMENT_SURPLUS_TEMP_NAME',
  'PAYMENT_SURPLUS_TEMP_MIGRATION_URL',
  'PAYMENT_SURPLUS_TEMP_TOKEN',
  'PAYMENT_SURPLUS_TEMP_OID',
  'PAYMENT_SURPLUS_TEMP_OWNER_OID',
  'PAYMENT_SURPLUS_TEMP_MIGRATION_ROLE',
  'PAYMENT_SURPLUS_TEST_CLUSTER_ID',
  'PAYMENT_SURPLUS_TEST_DATA_DIRECTORY',
  'PAYMENT_SURPLUS_TEST_PORT',
]);
const verifierEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => osKeys.has(key.toUpperCase()) || verifierKeys.has(key),
  ),
);
const verification = spawnSync(
  process.execPath,
  [
    resolve(__dirname, 'test/run-payment-surplus-temp.cjs'),
    '--verify-migration-target',
  ],
  {
    cwd: __dirname,
    env: { ...verifierEnv, TZ: 'UTC' },
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 65536,
    killSignal: 'SIGTERM',
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
if (
  verification.error ||
  verification.status !== 0 ||
  verification.stdout.trim() !== 'PAYMENT_SURPLUS_MIGRATION_TARGET_VERIFIED'
) {
  let diagnostic: { code?: string; sqlstate?: string } = {};
  try {
    diagnostic = JSON.parse(verification.stderr);
  } catch {
    /* Never echo raw output. */
  }
  const code = /^[A-Z_]+$/.test(diagnostic.code ?? '')
    ? diagnostic.code
    : 'VERIFIER_FAILED';
  const sqlstate = /^[0-9A-Z]{5}$/.test(diagnostic.sqlstate ?? '')
    ? diagnostic.sqlstate
    : 'unavailable';
  const timedOut =
    (verification.error as NodeJS.ErrnoException | undefined)?.code ===
    'ETIMEDOUT';
  throw new Error(
    `Migration target verification failed; code=${code}; SQLSTATE=${sqlstate}; exit=${verification.status}; timeout=${timedOut}`,
  );
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: url.toString() },
});
