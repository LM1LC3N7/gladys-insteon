// -----------------------------------------------------------------------------
// One session with the Hub 2245, after pyinsteon's protocol/http_transport.py
// (MIT, Tom Harris): the hub is read every 500 ms (`/buffstatus.xml`), a
// message to the Insteon network is a request `/3?<hex>=I=3`.
//
// - One HTTP request at a time, in this order: the commands of the user,
//   then the read of the buffer when it is due, then one background request
//   (status, ID, database), never two background requests waiting for their
//   answers at once.
// - Before each message: the buffer is read (nothing new is lost), then
//   cleared (`/1?XB=M=1`), then the message is sent: an answer is only taken
//   from what the hub received after the clear, never from an older message
//   that would look the same.
// - A command is sent only before its deadline and when its last check
//   (`beforeSend`: the option, the identity of the hub) still holds, both
//   checked right before the request.
// - Three failed requests in a row, or a refused password, end the session
//   ('down'); every waiter is told whether its message may have left.
// - Bounded: 30 commands waiting, 600 background requests waiting.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { bufferText, readBuffer } from './buffer.js';
import { HubError } from './http.js';
import { MessageReader } from './messages.js';
import { LIMITS, TIMINGS } from '../constants.js';

/** Why a message failed; `sent`: it may have reached the network. */
export class ClientError extends Error {
  constructor(kind, message, { sent = false } = {}) {
    super(message);
    this.kind = kind;
    this.sent = sent;
  }
}

export class HubClient extends EventEmitter {
  constructor({ transportFactory, timers = globalThis, now = Date.now, logger }) {
    super();
    this.transportFactory = transportFactory;
    this.timers = timers;
    this.now = now;
    this.logger = logger;
    this.epoch = 0;
    this.connected = false;
    this.busy = false;
    this.urgent = [];
    this.background = [];
    this.waiters = new Set();
    this.backgroundBusy = false;
    this.last = 0;
    this.failures = 0;
    this.invalid = { count: 0, loggedAt: undefined };
    this.reader = new MessageReader({
      onMessage: (message, bytes) => this.dispatch(message, bytes),
      onInvalid: () => this.noteInvalid(),
    });
  }

  configure(options) {
    this.options = options;
  }

  noteInvalid() {
    this.invalid.count += 1;
    const at = this.now();
    if (this.invalid.loggedAt === undefined || at - this.invalid.loggedAt >= 60_000) {
      this.invalid.loggedAt = at;
      this.logger?.warn(`Insteon: unreadable bytes from the hub (${this.invalid.count} so far)`);
    }
  }

  /** Opens a session: the buffer must answer, then it is cleared. */
  async start() {
    this.stop();
    const epoch = ++this.epoch;
    this.busy = true;
    const transport = this.transportFactory(this.options);
    this.transport = transport;
    try {
      const text = await this.readText(transport);
      if (epoch !== this.epoch) return;
      if (text === undefined) {
        throw new HubError('status', 'not the buffer of an Insteon Hub 2245', { sent: true });
      }
      await transport.request('GET', '/1?XB=M=1', { timeout: TIMINGS.httpTimeout });
      if (epoch !== this.epoch) return;
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.busy = false;
      transport.close?.();
      this.emit('down', { reason: err.message, refused: err.kind === 'auth' });
      return;
    }
    this.busy = false;
    this.last = 0;
    this.reader.reset();
    this.failures = 0;
    this.connected = true;
    this.nextPollAt = this.now();
    this.emit('up');
    this.pump(epoch);
  }

  stop() {
    this.epoch += 1;
    const was = this.connected;
    this.connected = false;
    this.busy = false;
    this.transport?.close?.();
    this.transport = undefined;
    this.failAll(new ClientError('offline', 'not connected to the hub'));
    // The loop of the old session wakes up and ends (its epoch is gone).
    this.wake();
    return was;
  }

  failAll(err) {
    for (const op of [...this.urgent, ...this.background]) op.reject(err);
    this.urgent = [];
    this.background = [];
    for (const waiter of [...this.waiters]) {
      waiter.fail(new ClientError(err.kind, err.message, { sent: true }));
    }
    this.backgroundBusy = false;
  }

  /** The session ends: everything waiting fails, 'down' tells why. */
  drop(epoch, err) {
    if (epoch !== this.epoch) return;
    this.epoch += 1;
    this.connected = false;
    this.transport?.close?.();
    this.transport = undefined;
    this.failAll(new ClientError('offline', 'the connection to the hub was lost'));
    this.emit('down', { reason: err.message, refused: err.kind === 'auth' });
  }

  async readText(transport) {
    const { body } = await transport.request('GET', '/buffstatus.xml', {
      timeout: TIMINGS.httpTimeout,
    });
    return bufferText(body);
  }

  // --- The loop ----------------------------------------------------------------

  wake() {
    const resolve = this.wakeResolve;
    this.wakeResolve = undefined;
    if (this.wakeTimer) this.timers.clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    resolve?.();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.wakeResolve = resolve;
      this.wakeTimer = this.timers.setTimeout(() => this.wake(), Math.max(0, ms));
    });
  }

  async pump(epoch) {
    while (epoch === this.epoch) {
      const op = this.urgent.shift();
      if (op) {
        await this.runWrite(epoch, op);
        continue;
      }
      if (this.now() >= this.nextPollAt) {
        await this.poll(epoch);
        continue;
      }
      if (!this.backgroundBusy && this.background.length > 0) {
        await this.runWrite(epoch, this.background.shift());
        continue;
      }
      await this.sleep(this.nextPollAt - this.now());
    }
  }

  /** A failed request; the third one in a row (or a refused password) ends the session. */
  failed(epoch, err) {
    if (err.kind === 'auth') {
      this.drop(epoch, err);
      return;
    }
    this.failures += 1;
    if (this.failures >= LIMITS.failuresInARow) this.drop(epoch, err);
  }

  async poll(epoch) {
    this.nextPollAt = this.now() + TIMINGS.poll;
    let text;
    try {
      text = await this.readText(this.transport);
    } catch (err) {
      if (epoch === this.epoch) this.failed(epoch, err);
      return;
    }
    if (epoch !== this.epoch) return;
    this.failures = 0;
    if (text === undefined) {
      this.noteInvalid();
      return;
    }
    this.take(text);
  }

  take(text) {
    const { bytes, next, cleared } = readBuffer(text, this.last);
    if (cleared) this.reader.reset();
    this.last = next;
    if (bytes) this.reader.push(bytes);
  }

  dispatch(message, bytes) {
    for (const waiter of [...this.waiters]) waiter.offer(message, bytes);
    this.emit('message', message);
  }

  // --- Messages to the network ---------------------------------------------------

  /**
   * Sends `bytes` (an IM message) and waits for the answer `match` accepts
   * (a message of the hub received after the clear), until `until`.
   * Resolves with what `match` returned. Rejects with ClientError:
   * 'offline', 'late', 'full', 'withdrawn' (nothing sent), 'unconfirmed'
   * (sent, no answer in time).
   */
  send(bytes, { urgent = false, sendBy, beforeSend, match, until, label, onWritten } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new ClientError('offline', 'not connected to the hub'));
        return;
      }
      const queue = urgent ? this.urgent : this.background;
      if (queue.length >= (urgent ? LIMITS.urgentQueue : LIMITS.backgroundQueue)) {
        reject(new ClientError('full', 'too many requests waiting'));
        return;
      }
      queue.push({
        bytes,
        urgent,
        sendBy,
        beforeSend,
        match,
        until,
        label,
        onWritten,
        resolve,
        reject,
      });
      this.wake();
    });
  }

  tooLate(op) {
    return op.sendBy !== undefined && this.now() > op.sendBy;
  }

  async runWrite(epoch, op) {
    const transport = this.transport;
    if (this.tooLate(op)) {
      op.reject(new ClientError('late', 'too late to send'));
      return;
    }
    // What came since the last read, before the clear erases it.
    try {
      const text = await this.readText(transport);
      if (epoch !== this.epoch) return;
      if (text !== undefined) this.take(text);
      await transport.request('GET', '/1?XB=M=1', { timeout: TIMINGS.httpTimeout });
      if (epoch !== this.epoch) return;
    } catch (err) {
      if (epoch !== this.epoch) return;
      op.reject(new ClientError('offline', `the hub did not answer (${err.message})`));
      this.failed(epoch, err);
      return;
    }
    this.failures = 0;
    this.last = 0;
    this.reader.reset();
    this.nextPollAt = this.now() + TIMINGS.firstPoll;
    // The last checks, right before the request.
    if (this.tooLate(op)) {
      op.reject(new ClientError('late', 'too late to send'));
      return;
    }
    if (op.beforeSend && !op.beforeSend()) {
      op.reject(new ClientError('withdrawn', 'withdrawn before sending'));
      return;
    }
    const waiter = op.match ? this.waiter(op) : undefined;
    const timeout = op.until
      ? Math.max(500, Math.min(TIMINGS.httpTimeout, op.until - this.now()))
      : TIMINGS.httpTimeout;
    try {
      await transport.request('POST', `/3?${op.bytes.toString('hex').toUpperCase()}=I=3`, {
        timeout,
      });
    } catch (err) {
      if (epoch !== this.epoch) return;
      const sent = err.sent !== false;
      if (waiter) waiter.cancel();
      op.reject(
        new ClientError(sent ? 'unconfirmed' : 'offline', `request failed (${err.message})`, {
          sent,
        }),
      );
      this.failed(epoch, err);
      return;
    }
    if (epoch !== this.epoch) return;
    this.failures = 0;
    op.onWritten?.();
    if (!waiter) {
      op.resolve(undefined);
      return;
    }
    waiter.start();
  }

  /** A waiter for the answer of `op`, offered every message read after the clear. */
  waiter(op) {
    const background = !op.urgent;
    if (background) this.backgroundBusy = true;
    let timer;
    const end = () => {
      this.waiters.delete(waiter);
      if (timer) this.timers.clearTimeout(timer);
      if (background) this.backgroundBusy = false;
      this.wake();
    };
    const waiter = {
      offer: (message, bytes) => {
        let result;
        try {
          result = op.match(message, bytes);
        } catch {
          result = undefined;
        }
        if (result === undefined) return;
        end();
        op.resolve(result);
      },
      fail: (err) => {
        end();
        op.reject(err);
      },
      cancel: end,
      start: () => {
        const left = (op.until ?? this.now() + TIMINGS.answer) - this.now();
        timer = this.timers.setTimeout(
          () => {
            end();
            op.reject(new ClientError('unconfirmed', 'no answer in time', { sent: true }));
          },
          Math.max(0, left),
        );
      },
    };
    this.waiters.add(waiter);
    return waiter;
  }
}
