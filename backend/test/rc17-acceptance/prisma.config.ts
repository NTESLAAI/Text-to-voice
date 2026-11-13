import { defineConfig } from 'prisma/config';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const g = require('./guard.cjs');
const packet = g.readPacket(3);
g.insist(packet.action === 'migrate');
const checked = spawnSync(process.execPath, [join(__dirname, 'guard.cjs')], {
  input: JSON.stringify(packet),
  env: g.osEnvironment(),
  encoding: 'utf8',
  timeout: 20000,
  windowsHide: true,
});
g.insist(
  checked.status === 0 && checked.stdout === 'IDENTITY_VERIFIED',
  'RCR_MIGRATION_TARGET_UNVERIFIED',
);
export default defineConfig({
  schema: join(__dirname, '../../prisma/schema.prisma'),
  migrations: { path: join(__dirname, '../../prisma/migrations') },
  datasource: { url: g.connection(packet, 'owner').connectionString },
});
