'use strict';
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/receiving-bank-acceptance/integration.bank.ts'],
  setupFiles: ['<rootDir>/test/receiving-bank-acceptance/setup.cjs'],
  maxWorkers: 1,
  testTimeout: 45000,
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transformIgnorePatterns: ['/node_modules/(?!@nestjs/(?:jwt|passport)/)'],
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
