// -----------------------------------------------------------------------------
// An in-memory Hub 2245 and Insteon network: no socket, no network. Its
// `transportFactory` is given to the app in place of the HTTP transport; the
// hub keeps the 200-digit ring buffer of the real one, answers the messages
// the way pyinsteon expects them (bytes built by hand here, not with the
// encoders under test), records every request, and can refuse the password,
// fail, slow down, or let any device stay silent.
// -----------------------------------------------------------------------------

import { HubError } from '../../src/insteon/http.js';

/** Lets every queued delivery and the promise chains behind it run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export async function until(check, rounds = 400) {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await settle(5);
  }
  throw new Error('condition never met');
}

export class FakeClock {
  constructor(start = 1_000_000) {
    this.time = start;
    this.entries = new Map();
    this.ids = 0;
    this.now = () => this.time;
    this.setTimeout = (fn, ms) => this.add(fn, ms);
    this.clearTimeout = (id) => this.entries.delete(id);
  }

  add(fn, ms) {
    this.ids += 1;
    this.entries.set(this.ids, { at: this.time + Math.max(0, ms || 0), fn });
    return this.ids;
  }

  async advance(ms) {
    const end = this.time + ms;
    for (;;) {
      await settle(3);
      let next;
      for (const [id, entry] of this.entries) {
        if (entry.at <= end && (!next || entry.at < next[1].at)) next = [id, entry];
      }
      if (!next) break;
      const [id, entry] = next;
      this.time = Math.max(this.time, entry.at);
      this.entries.delete(id);
      entry.fn();
    }
    this.time = end;
    await settle();
  }
}

export const quietLogger = () => {
  const lines = [];
  const log = (level) => (message) => lines.push(`${level} ${message}`);
  return { lines, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
};

const hex2 = (n) => n.toString(16).padStart(2, '0');

/** Flags: type in the three high bits, 3 hops left, 3 max. */
const FLAGS = { ack: 0x2b, nak: 0xab, broadcast: 0x8b, allLink: 0xcb, cleanup: 0x4b };

export class FakeHub {
  constructor({
    hub = 'aabbcc',
    username = 'user',
    password = 'secret',
    devices = [],
    clock,
    latency = 0,
  } = {}) {
    this.hub = hub;
    this.username = username;
    this.password = password;
    this.clock = clock;
    this.latency = latency;
    /** address -> { cat, subcat, fw, level, input, asleep, silent, nak, answerLevel } */
    this.devices = new Map(devices.map((d) => [d.address, { level: 0, ...d }]));
    this.data = '0'.repeat(200);
    this.pos = 0;
    this.requests = [];
    this.down = false;
    this.status = 200;
    this.recordIndex = 0;
    this.transportFactory = (options) => {
      this.options = options;
      return { request: (method, path, opts) => this.request(method, path, opts), close() {} };
    };
  }

  /** Bytes the modem writes into its ring buffer. */
  put(hex) {
    const text = hex.toUpperCase();
    const chars = this.data.split('');
    for (const c of text) {
      chars[this.pos] = c;
      this.pos = (this.pos + 1) % 200;
    }
    this.data = chars.join('');
  }

  clear() {
    this.data = '0'.repeat(200);
    this.pos = 0;
  }

  get writes() {
    return this.requests.filter((r) => r.path.startsWith('/3?')).map((r) => r.path.slice(3, -4));
  }

  async request(method, path, { timeout = 5_000 } = {}) {
    this.requests.push({ method, path, at: this.clock?.now() });
    if (this.down) throw new HubError('network', 'ECONNREFUSED', { sent: false });
    if (this.latency > 0) {
      await new Promise((resolve) => this.clock.setTimeout(resolve, this.latency));
    }
    if (this.hang) {
      await new Promise((resolve) => this.clock.setTimeout(resolve, timeout));
      throw new HubError('timeout', 'the hub did not answer in time', { sent: true });
    }
    if (this.options.username !== this.username || this.options.password !== this.password) {
      throw new HubError('auth', 'HTTP 401', { sent: true, status: 401 });
    }
    if (this.status !== 200) {
      throw new HubError('status', `HTTP ${this.status}`, { sent: true, status: this.status });
    }
    if (method === 'GET' && path === '/buffstatus.xml') {
      return {
        status: 200,
        body: `<response><BS>${this.data}${hex2(this.pos).toUpperCase()}</BS></response>`,
      };
    }
    if (path === '/1?XB=M=1') {
      this.clear();
      return { status: 200, body: '' };
    }
    const match = /^\/3\?([0-9A-F]+)=I=3$/.exec(path);
    if (method === 'POST' && match) {
      this.clear();
      this.handle(match[1].toLowerCase());
      return { status: 200, body: '' };
    }
    throw new HubError('status', 'HTTP 404', { sent: true, status: 404 });
  }

  handle(hex) {
    const id = hex.slice(2, 4);
    if (id === '60') {
      this.put(`0260${this.hub}03339b06`);
      return;
    }
    if (id === '69' || id === '6a') {
      if (id === '69') this.recordIndex = 0;
      const address = [...this.devices.keys()][this.recordIndex];
      if (address === undefined) {
        this.put(`02${id}15`);
        return;
      }
      this.recordIndex += 1;
      this.put(`02${id}06`);
      this.put(`0257e201${address}000000`);
      return;
    }
    if (id !== '62') return;
    const address = hex.slice(4, 10);
    const cmd1 = Number.parseInt(hex.slice(12, 14), 16);
    const cmd2 = Number.parseInt(hex.slice(14, 16), 16);
    this.put(`${hex}06`);
    const device = this.devices.get(address);
    if (!device || device.asleep || device.silent) return;
    const reply = (flags, c1, c2) =>
      this.later(() => this.put(`0250${address}${this.hub}${hex2(flags)}${hex2(c1)}${hex2(c2)}`));
    if (device.nak) {
      reply(FLAGS.nak, cmd1, 0xff);
      return;
    }
    if (cmd1 === 0x19) {
      const value = device.kind === 'iolinc' && cmd2 === 1 ? device.input : device.level;
      reply(FLAGS.ack, 0x01, value ?? 0);
    } else if (cmd1 === 0x11) {
      device.level = device.answerLevel ?? cmd2;
      reply(FLAGS.ack, 0x11, device.level);
    } else if (cmd1 === 0x13) {
      device.level = 0;
      reply(FLAGS.ack, 0x13, 0);
    } else if (cmd1 === 0x10) {
      reply(FLAGS.ack, 0x10, 0);
      this.later(() => this.setButton(address));
    }
  }

  later(fn) {
    if (this.clock) this.clock.setTimeout(fn, 200);
    else fn();
  }

  /** A device's set button: its type, broadcast. */
  setButton(address) {
    const d = this.devices.get(address);
    this.put(
      `0250${address}${hex2(d.cat)}${hex2(d.subcat)}${hex2(d.fw ?? 0)}${hex2(FLAGS.broadcast)}0100`,
    );
  }

  /** An all-link broadcast of a device (a button, a sensor). */
  broadcast(address, group, cmd1, hops = 3) {
    const flags = 0xc0 | (hops << 2) | 3;
    this.put(`0250${address}0000${hex2(group)}${hex2(flags)}${hex2(cmd1)}00`);
  }

  /** The cleanup of a broadcast, direct to the hub. */
  cleanup(address, group, cmd1) {
    this.put(`0250${address}${this.hub}${hex2(FLAGS.cleanup)}${hex2(cmd1)}${hex2(group)}`);
  }
}
