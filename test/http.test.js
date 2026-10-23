// The HTTP transport against a real HTTP server on 127.0.0.1 (no network):
// basic authentication, one connection per request, bounded answers, the
// `sent` flag of each failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { httpTransport } from '../src/insteon/http.js';

async function server(t, handler) {
  const connections = { count: 0 };
  const srv = http.createServer(handler);
  srv.on('connection', () => (connections.count += 1));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  return { port: srv.address().port, connections, srv };
}

test('basic authentication, one connection per request, the buffer read', async (t) => {
  const seen = [];
  const { port, connections } = await server(t, (req, res) => {
    seen.push([req.method, req.url, req.headers.authorization]);
    res.end('<response><BS>00</BS></response>');
  });
  const hub = httpTransport({ host: '127.0.0.1', port, username: 'user', password: 'pa:ss' });
  t.after(() => hub.close());
  const answer = await hub.request('GET', '/buffstatus.xml');
  assert.equal(answer.body, '<response><BS>00</BS></response>');
  await hub.request('POST', '/3?0262=I=3');
  assert.deepEqual(seen, [
    ['GET', '/buffstatus.xml', `Basic ${Buffer.from('user:pa:ss').toString('base64')}`],
    ['POST', '/3?0262=I=3', `Basic ${Buffer.from('user:pa:ss').toString('base64')}`],
  ]);
  assert.equal(connections.count, 2, 'no connection kept alive');
});

test('401 is a refusal; another status, a redirection too, is not followed', async (t) => {
  let status = 401;
  const { port } = await server(t, (req, res) => {
    res.writeHead(status, { location: 'http://192.0.2.9/' });
    res.end();
  });
  const hub = httpTransport({ host: '127.0.0.1', port, username: 'u', password: 'secret-value' });
  t.after(() => hub.close());
  await assert.rejects(hub.request('GET', '/buffstatus.xml'), (err) => {
    assert.equal(err.kind, 'auth');
    assert.ok(!err.message.includes('secret-value'));
    return true;
  });
  status = 302;
  await assert.rejects(hub.request('GET', '/x'), { kind: 'status', status: 302 });
});

test('an answer too large is cut', async (t) => {
  const { port } = await server(t, (req, res) => {
    res.write('x'.repeat(6_000));
    res.end('y'.repeat(6_000));
  });
  const hub = httpTransport({ host: '127.0.0.1', port, username: 'u', password: 'p' });
  t.after(() => hub.close());
  await assert.rejects(hub.request('GET', '/buffstatus.xml'), { kind: 'too_large' });
});

test('a hub that never answers: timed out, and it may have received the request', async (t) => {
  const { port } = await server(t, () => {});
  const hub = httpTransport({ host: '127.0.0.1', port, username: 'u', password: 'p' });
  t.after(() => hub.close());
  await assert.rejects(hub.request('POST', '/3?00=I=3', { timeout: 200 }), {
    kind: 'timeout',
    sent: true,
  });
});

test('nothing listening: not sent', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const hub = httpTransport({ host: '127.0.0.1', port, username: 'u', password: 'p' });
  await assert.rejects(hub.request('POST', '/3?00=I=3'), { kind: 'network', sent: false });
  hub.close();
});
