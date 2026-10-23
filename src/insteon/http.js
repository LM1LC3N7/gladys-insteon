// -----------------------------------------------------------------------------
// HTTP to the Hub 2245 (port 25105, basic authentication: the user name and
// password printed under the hub), on node:http.
//
// - One new connection per request (an agent without keep-alive, one socket):
//   the hub is a small device, pyinsteon opens a session per request too.
// - Every answer is bounded in size (8 KB; a buffstatus answer is about
//   230 bytes) and in time (the whole request, not only an idle socket).
// - `sent` tells whether the request may have reached the hub: false only
//   when the connection was never made (refused, unreachable, timed out
//   before connecting). A command whose request may have left is never
//   reported "not sent".
// - Redirections are not followed. The password is never in an error.
// -----------------------------------------------------------------------------

import http from 'node:http';

export const MAX_BODY = 8 * 1024;

export class HubError extends Error {
  /** kind: 'auth' (401), 'status' (another HTTP status), 'network', 'timeout', 'too_large'. */
  constructor(kind, message, { sent = false, status } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
    this.status = status;
  }
}

export function httpTransport({ host, port, username, password }) {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  const request = (method, path, { timeout = 5_000 } = {}) =>
    new Promise((resolve, reject) => {
      let connected = false;
      let settled = false;
      const chunks = [];
      let size = 0;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const req = http.request({
        host,
        port,
        path,
        method,
        agent,
        auth: `${username}:${password}`,
        headers: method === 'POST' ? { 'content-length': 0 } : {},
      });
      const timer = setTimeout(() => {
        finish(
          reject,
          new HubError('timeout', 'the hub did not answer in time', { sent: connected }),
        );
        req.destroy();
      }, timeout);
      req.on('socket', (socket) => {
        if (!socket.connecting) connected = true;
        else socket.once('connect', () => (connected = true));
      });
      req.on('error', (err) => {
        finish(
          reject,
          new HubError('network', err.code ?? 'connection failed', { sent: connected }),
        );
      });
      req.on('response', (res) => {
        connected = true;
        if (res.statusCode !== 200) {
          res.resume();
          finish(
            reject,
            new HubError(res.statusCode === 401 ? 'auth' : 'status', `HTTP ${res.statusCode}`, {
              sent: true,
              status: res.statusCode,
            }),
          );
          req.destroy();
          return;
        }
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            finish(reject, new HubError('too_large', 'answer too large', { sent: true }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(resolve, { status: 200, body: Buffer.concat(chunks).toString('latin1') }),
        );
        res.on('error', () =>
          finish(reject, new HubError('network', 'answer cut', { sent: true })),
        );
      });
      req.end();
    });
  return { request, close: () => agent.destroy() };
}
