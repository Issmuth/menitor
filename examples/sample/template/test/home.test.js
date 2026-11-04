import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/app.js';

test('GET / shows the app name in a heading', async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /<h1>\s*Recipe box\s*<\/h1>/i);
  } finally {
    server.close();
  }
});
