const { startTestServer } = require('./tests/mcp/setup-test-server');

module.exports = async () => {
  console.log('\n🚀 Starting test server...\n');
  try {
    await startTestServer();
    console.log('\n✅ Test server ready\n');
  } catch (error) {
    console.error('\n❌ Failed to start test server:', error.message);
    console.log('\n⚠️  Continuing without SSE connection...\n');
    // 不抛出错误，让测试继续（服务器已启动，只是 SSE 连接失败）
  }
};
