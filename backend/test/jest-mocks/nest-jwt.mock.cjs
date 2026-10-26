class MockJwtService {
  sign = jest.fn();
  signAsync = jest.fn();
  verify = jest.fn();
  verifyAsync = jest.fn();
  decode = jest.fn();
}

module.exports = {
  JwtService: MockJwtService,
  JwtModule: {
    register: jest.fn(() => ({
      module: class MockJwtModule {},
      providers: [],
      exports: [],
    })),
    registerAsync: jest.fn(() => ({
      module: class MockJwtModule {},
      providers: [],
      exports: [],
    })),
  },
};
