const { callRPC, sleep } = require('./rpc-utils');

describe('RPC Multi Account', () => {
  jest.setTimeout(30000);
  let win1, win2;

  test('should open window with account 0', async () => {
    const result = await callRPC('open_window', { url: 'https://google.com', accountIdx: 0 });
    win1 = parseInt(result.content[0].text.match(/\d+/)[0]);
    expect(win1).toBeGreaterThan(0);
    await sleep(1000);
  });

  test('should open window with account 1', async () => {
    const result = await callRPC('open_window', { url: 'https://google.com', accountIdx: 1 });
    win2 = parseInt(result.content[0].text.match(/\d+/)[0]);
    expect(win2).toBeGreaterThan(0);
    await sleep(1000);
  });

  test('should have different window IDs', () => {
    expect(win1).not.toBe(win2);
  });

  test('should get window info with account', async () => {
    const result = await callRPC('get_window_info', { win_id: win1 });
    expect(result.content[0].text).toContain('accountIdx');
  });
});
