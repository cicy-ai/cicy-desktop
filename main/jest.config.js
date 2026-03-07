module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  testTimeout: 30000,
  maxWorkers: 1,
  globalSetup: "<rootDir>/jest.setup.global.js",
  globalTeardown: "<rootDir>/jest.teardown.global.js",
  forceExit: true,
  detectOpenHandles: false,
};
