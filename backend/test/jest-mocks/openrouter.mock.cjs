class MockOpenRouter {
  constructor() {
    this.tts = {
      createSpeech: jest.fn(),
    };
  }
}

module.exports = {
  OpenRouter: MockOpenRouter,
};
