/** @type {import('jest').Config} */
module.exports = {
  rootDir: './src',
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  moduleNameMapper: {
    '^@nestjs/passport$': '<rootDir>/../test/jest-mocks/nest-passport.mock.cjs',
    '^@nestjs/jwt$': '<rootDir>/../test/jest-mocks/nest-jwt.mock.cjs',
    '^@openrouter/sdk$': '<rootDir>/../test/jest-mocks/openrouter.mock.cjs',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: false,
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'Node',
          isolatedModules: true,
          resolvePackageJsonExports: false,
          resolvePackageJsonImports: false,
        },
      },
    ],
  },
  testEnvironment: 'node',
};
