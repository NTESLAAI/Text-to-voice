class MockAuthGuard {
  canActivate() {
    return true;
  }
}

module.exports = {
  AuthGuard: () => MockAuthGuard,
};
