'use strict';

// Retired entrypoint: never load configuration, dependencies or another runner.
console.error(
  'LEGACY_READONLY_RUNNER_DISABLED: This entrypoint has been retired for environment safety. Use the separately approved TEST temporary harness procedure; no automatic redirect is performed.',
);
process.exitCode = 1;
