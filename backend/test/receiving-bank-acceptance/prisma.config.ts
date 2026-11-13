import { defineConfig } from 'prisma/config';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
const g = require('./guard.cjs'),
  p = g.readPacket(3);
g.insist(['base', 'expand', 'enforce', 'cold'].includes(p.action));
const checked = spawnSync(process.execPath, [join(__dirname, 'guard.cjs')], {
  input: JSON.stringify(p),
  env: g.osEnvironment(),
  encoding: 'utf8',
  timeout: 20000,
  windowsHide: true,
});
g.insist(
  checked.status === 0 && checked.stdout === 'IDENTITY_VERIFIED',
  'BANK_MIGRATION_TARGET_UNVERIFIED',
);
export default defineConfig({
  schema: join(__dirname, '../../prisma/schema.prisma'),
  migrations: {
    path: join(dirname(p.manifest.dataDirectory), 'migrations-' + p.action),
  },
  datasource: { url: g.connection(p, 'owner').connectionString },
});
