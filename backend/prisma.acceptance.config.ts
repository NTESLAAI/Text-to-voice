// Dedicated CLI config. No dotenv, DATABASE_URL or application config.
import { defineConfig } from 'prisma/config';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import * as guardModule from './test/acceptance/guard.cjs';
interface Packet {
  action: string;
  manifest: { runId: string };
}
// The CJS boundary validates the complete runtime schema before returning.
const guard = guardModule as {
  readPacket(): Packet;
  insist(ok: unknown, code?: string): void;
  osEnvironment(): NodeJS.ProcessEnv;
  connection(
    packet: Packet,
    kind: string,
    role: string,
  ): { connectionString: string };
};
const packet = guard.readPacket();
guard.insist(
  ['migrate-cold', 'upgrade-base', 'upgrade-final'].includes(packet.action),
);
const verification = spawnSync(
  process.execPath,
  [join(__dirname, 'test/acceptance/guard.cjs')],
  {
    input: JSON.stringify(packet),
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024,
    windowsHide: true,
    env: guard.osEnvironment(),
  },
);
guard.insist(
  !verification.error &&
    verification.status === 0 &&
    verification.stdout === 'IDENTITY_VERIFIED',
  'MIGRATION_TARGET_UNVERIFIED',
);
const kind = packet.action === 'migrate-cold' ? 'cold' : 'upgrade';
export default defineConfig({
  schema: join(__dirname, 'prisma/schema.prisma'),
  migrations: {
    path:
      packet.action === 'upgrade-base'
        ? join('D:/text-to-voice-it', packet.manifest.runId, 'migrations-base')
        : join(__dirname, 'prisma/migrations'),
  },
  datasource: { url: guard.connection(packet, kind, 'owner').connectionString },
});
