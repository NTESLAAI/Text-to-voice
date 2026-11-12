'use strict';
// Explicit selection: never discover historical database tests or fake JWTs.
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/acceptance/integration.acceptance.ts'],
  setupFiles: ['<rootDir>/test/acceptance/setup.cjs'],
  maxWorkers: 1,
  testTimeout: 45000,
  forceExit: false,
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // Execute the installed Nest 12 ESM packages as real code, never auth mocks.
  transformIgnorePatterns: [
    '/node_modules/(?!@nestjs/(?:jwt|passport|schedule)/)',
  ],
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'Node',
          isolatedModules: true,
          allowJs: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          resolvePackageJsonExports: false,
          resolvePackageJsonImports: false,
        },
      },
    ],
  },
};
