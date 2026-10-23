// -----------------------------------------------------------------------------
// The integration: one session with the Hub 2245 (src/insteon/hub.js), the
// devices of the hub and what the network says about them, the Gladys
// devices and states (src/devices.js), the button scene events, the
// commands. index.js only wires the SDK handlers to it.
//
// - Identity: the Insteon address of the hub (Get IM Info) is pinned in /data
//   at the first session (or typed in the configuration). Another hub at the
//   same IP address (a DHCP swap) stops everything; an unreadable identity is
//   not "another hub": it is asked again a minute later. The identity is read
//   again at every connection: until then nothing is read nor sent.
// - A device's type, once known, never changes on a message (only a reset of
//   /data, by another hub address, forgets it).
// - Devices: the database of the hub lists the linked devices, an ID request
//   tells what each one is (battery devices sleep: their type is learnt when
//   their set button is pressed, or at their next message). Kept in /data.
// - States: the broadcasts of the devices as they come, and a status round
//   every `poll_interval` minutes, never sooner (its start is written in /data
//   before it starts, so a restart or a reconnection does not read again).
// - Commands: lights and switches only for the devices declared safe; the
//   "Turn on" / "Turn off" buttons of the other ones only when the option
//   allows them. A command leaves within 3.5 s of the request or not at all
//   (the deadline and the option checked right before the request), is
//   confirmed only by the level the device answers, equal to the one asked,
//   and is otherwise "sent, without confirmation" with a read back. Its ack
//   never waits for the publication.
// - A refused password stops for good (persisted, a salted hash of the
//   refused pair only); other failures retry at 10 s, 30 s, 1, 2, then 5 min,
//   the next try persisted so a restart never tries sooner.
// - Every await of a session is followed by a check that it is still the
//   current one: a late answer of an old session publishes nothing.
// - The password is never logged.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, placeKey, sessionKey } from './config.js';
import { LIMITS, SCENE_TRIGGERS, TIMINGS } from './constants.js';
import {
  SAFE_KEYS,
  buildDevices,
  buildStates,
  parseFeatureId,
  percent,
  shownDevices,
} from './devices.js';
import { COMMAND_NAMES, T, fill, word } from './i18n.js';
import { ClientError, HubClient } from './insteon/hub.js';
import { httpTransport } from './insteon/http.js';
import {
  CMD,
  IM,
  TYPE,
  addressText,
  getFirstRecord,
  getImInfo,
  getNextRecord,
  sendStandard,
} from './insteon/messages.js';
import {
  BUTTON_KINDS,
  DEVICE_KINDS,
  READ_KINDS,
  onMeansClosed,
  productOf,
} from './insteon/products.js';
import { StatePublisher } from './publisher.js';
import { fileStore, newSalt, normalizeMemory, refusedHash } from './store.js';

/** A command refused before anything was sent. */
export class Refused extends Error {}

const ACTIONS_OF_COMMAND = new Map([
  [CMD.ON, 'on'],
  [CMD.ON_FAST, 'fast_on'],
  [CMD.OFF, 'off'],
  [CMD.OFF_FAST, 'fast_off'],
  [CMD.START_MANUAL_CHANGE, 'dim_start'],
  [CMD.STOP_MANUAL_CHANGE, 'dim_stop'],
]);

/** A strict 0 / 1 (null, '' and the rest are not 0). */
function binaryOf(value) {
  if (value === 0 || value === '0') return 0;
  if (value === 1 || value === '1') return 1;
  return undefined;
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const newDevice = (address, cat, subcat, fw) => ({
  address,
  cat,
  subcat,
  fw,
  product: productOf(cat, subcat),
});

export class InsteonApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'insteon' }),
    transportFactory = httpTransport,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.client = new HubClient({ transportFactory, timers, now, logger });
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.key = undefined;
    this.session = 0;
    this.memory = undefined;
    /** address -> device (type known). */
    this.devices = new Map();
    /** Addresses of the hub database (types known or not). */
    this.addresses = new Set();
    this.seenHub = undefined;
    this.identity = 'unknown';
    this.started = false;
    this.lastStatus = undefined;
    this.lastTransport = undefined;
    this.published = undefined;
    this.chains = new Map();
    this.timersSet = new Set();
    this.idAskedAt = new Map();
    this.retypeLogged = new Set();
    this.eventReadAt = new Map();
    this.recent = new Map();
    this.pendingEvents = [];
    this.flushScheduled = false;
    this.starting = Promise.resolve();
    this.persistedAt = 0;
    // The session the event belongs to is taken when it comes, not when its turn comes.
    this.client.on('up', () => {
      const session = this.session;
      // A new session: the hub is unknown until Get IM Info is read again in it.
      this.forgetHub();
      this.guard(() => this.onUp(session));
    });
    this.client.on('down', (info) => {
      const session = this.session;
      this.forgetHub();
      this.guard(() => this.onDown(info, session));
    });
    this.client.on('message', (message) => this.applyMessage(message));
  }

  /** What talks to Gladys runs one after the other, in order. */
  guard(fn) {
    this.chain = (this.chain ?? Promise.resolve())
      .then(fn)
      .catch((err) => this.logger.error(`Insteon event failed: ${err.message}`));
    return this.chain;
  }

  get model() {
    return { devices: this.devices };
  }

  refused(entry) {
    return new Refused(word(entry, this.config.language));
  }

  error(entry) {
    return new Error(word(entry, this.config.language));
  }

  later(fn, ms) {
    const timer = this.timers.setTimeout(() => {
      this.timersSet.delete(timer);
      fn();
    }, ms);
    this.timersSet.add(timer);
    return timer;
  }

  // --- /data -------------------------------------------------------------------

  async loadMemory() {
    if (this.memory) return this.memory;
    try {
      this.memory = normalizeMemory(await this.store.load());
    } catch {
      this.memory = normalizeMemory(null);
    }
    return this.memory;
  }

  async saveMemory() {
    try {
      await this.store.save(this.memory);
    } catch (err) {
      this.logger.warn(`Saving the state to /data failed: ${err.message}`);
    }
  }

  /** The devices of this place, as known in /data. */
  loadDevices(memory, place) {
    this.devices = new Map();
    this.addresses = new Set();
    if (memory.place !== place) return;
    for (const d of memory.devices)
      this.devices.set(d.address, newDevice(d.address, d.cat, d.subcat, d.fw));
    for (const a of memory.addresses) this.addresses.add(a);
  }

  async saveDevices() {
    this.memory.place = placeKey(this.config);
    this.memory.devices = [...this.devices.values()]
      .slice(0, LIMITS.maxDevices)
      .map(({ address, cat, subcat, fw }) => ({ address, cat, subcat, fw }));
    this.memory.addresses = [...this.addresses].slice(0, LIMITS.maxDevices);
    await this.saveMemory();
  }

  // --- Lifecycle -----------------------------------------------------------------

  /** Starts (or restarts); two starts never overlap. */
  start(raw = {}) {
    const run = this.starting.then(() => this.startNow(raw));
    this.starting = run.catch(() => undefined);
    return run;
  }

  async startNow(raw = {}) {
    this.stop();
    const session = ++this.session;
    const next = normalizeConfig(raw);
    const memory = await this.loadMemory();
    if (session !== this.session) return;
    if (placeKey(next) !== placeKey(this.config) || !this.started) {
      this.loadDevices(memory, placeKey(next));
    }
    if (memory.place && memory.place !== placeKey(next)) {
      // Another hub address: what /data knew belongs to the old one.
      Object.assign(memory, {
        place: '',
        devices: [],
        addresses: [],
        lastScanAt: 0,
        lastRoundAt: 0,
      });
      await this.saveMemory();
      if (session !== this.session) return;
    }
    this.started = true;
    this.config = next;
    this.key = this.restartKey(next);
    this.seenHub = undefined;
    this.identity = 'unknown';
    if (next.safeErrors.length > 0) {
      this.logger.warn(`Devices declared safe not understood: ${next.safeErrors.join(', ')}`);
    }
    await this.publishDevices();
    await this.publishStates();
    if (session !== this.session) return;
    const problem = this.configProblem();
    if (problem) {
      await this.setStatus(false, problem);
      return;
    }
    const stop = memory.stop;
    if (
      stop &&
      stop.place === placeKey(next) &&
      refusedHash(stop.salt, next.username, next.password) === stop.refused
    ) {
      this.logger.warn(
        'Insteon: the hub refused these credentials before: no connection until they change or "Test the connection" succeeds',
      );
      await this.setStatus(false, T.refused);
      return;
    }
    const wait = Math.min(memory.retryAt - this.now(), TIMINGS.retries.at(-1));
    if (wait > 0) {
      this.logger.info(`Insteon: paused after failures, next try in ${Math.round(wait / 1000)} s`);
      await this.setStatus(false, fill(T.unreachable, 'pause', Math.round(wait / 1000)));
      this.retryTimer = this.later(() => this.connect(session), wait);
      return;
    }
    await this.setStatus(false, T.connecting);
    this.connect(session);
  }

  restartKey(config) {
    return JSON.stringify([sessionKey(config), config.hubAddress ?? null]);
  }

  connect(session) {
    if (session !== this.session) return;
    if (this.retryTimer !== undefined) {
      this.timers.clearTimeout(this.retryTimer);
      this.timersSet.delete(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.client.configure({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
    });
    this.client.start();
  }

  stop() {
    this.session += 1;
    this.client.stop();
    this.publisher.stop();
    for (const timer of this.timersSet) this.timers.clearTimeout(timer);
    this.timersSet.clear();
    this.retryTimer = undefined;
    this.wakeWork?.();
  }

  configProblem() {
    if (!this.config.host || !this.config.username || !this.config.password) return T.noConfig;
    if (this.config.hubAddressInvalid) return T.badHubAddress;
    return undefined;
  }

  /** First connection to Gladys: start; a reconnection (Gladys restarted): resend everything. */
  async connected(raw = {}) {
    if (!this.started) {
      await this.start(raw);
      return;
    }
    // Gladys keeps the connection status and the discovered devices in memory.
    this.published = undefined;
    this.lastTransport = undefined;
    const status = this.lastStatus;
    this.lastStatus = undefined;
    await this.configUpdated(raw);
    if (status && this.lastStatus === undefined) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.publisher.forget();
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports(
      this.client.connected ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
    );
  }

  /** New credentials, place or hub address: a new session; the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (this.restartKey(next) !== this.key) {
      // The option holds at once, even while the restart waits.
      this.config = { ...this.config, allowButtons: next.allowButtons, safe: next.safe };
      return this.start(raw);
    }
    this.config = next;
    await this.publishDevices();
    await this.publishStates();
    if (this.client.connected && this.identity !== 'other') {
      await this.setStatus(true, this.connectedMessage());
    }
    return undefined;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  connectedMessage() {
    const parts = [];
    const unknown = [...this.addresses].filter((a) => !this.devices.has(a));
    const list = (items) =>
      items
        .slice(0, 5)
        .join(', ')
        .concat(items.length > 5 ? '…' : '');
    if (unknown.length > 0) parts.push(fill(T.unknownTypes, list(unknown.map(addressText))));
    const unsupported = [...this.devices.values()].filter(
      (d) =>
        !DEVICE_KINDS.includes(d.product.kind) && !['remote', 'modem'].includes(d.product.kind),
    );
    if (unsupported.length > 0) {
      parts.push(
        fill(
          T.unsupported,
          list(unsupported.map((d) => `${d.product.description} ${addressText(d.address)}`)),
        ),
      );
    }
    if (this.config.safeErrors.length > 0) {
      parts.push(fill(T.safeErrors, list(this.config.safeErrors)));
    }
    const count = shownDevices(this.model).length;
    return Object.fromEntries(
      ['en', 'fr'].map((lang) => [
        lang,
        word(T.connected, lang)(count, parts.map((p) => p[lang]).join('')),
      ]),
    );
  }

  // --- Session events ---------------------------------------------------------------

  async onUp(session) {
    if (session !== this.session) return;
    const memory = await this.loadMemory();
    if (memory.stop || memory.retryAt || memory.failures) {
      // The first success erases the refusal and the pause.
      memory.stop = null;
      memory.retryAt = 0;
      memory.failures = 0;
      await this.saveMemory();
    }
    if (session !== this.session) return;
    this.logger.info('Insteon: connected to the hub');
    await this.setStatus(true, this.connectedMessage());
    await this.publishTransports(DEVICE_TRANSPORTS.LOCAL);
    if (session !== this.session) return;
    this.identityDueAt = this.now();
    this.work(session, this.workGeneration);
  }

  /** The identity read in a session holds for that session only; its work loop ends with it. */
  forgetHub() {
    if (this.identity !== 'other') this.identity = 'unknown';
    this.seenHub = undefined;
    this.workGeneration = (this.workGeneration ?? 0) + 1;
    this.wakeWork?.();
  }

  async onDown({ reason, refused }, session) {
    if (session !== this.session) return;
    const memory = await this.loadMemory();
    if (refused) {
      this.logger.error('Insteon: the hub refused the user name or the password; no new try');
      const salt = newSalt();
      memory.stop = {
        place: placeKey(this.config),
        kind: 'credentials_refused',
        at: this.now(),
        salt,
        refused: refusedHash(salt, this.config.username, this.config.password),
      };
      await this.saveMemory();
      if (session !== this.session) return;
      await this.setStatus(false, T.refused);
    } else {
      memory.failures = Math.min(memory.failures + 1, 99);
      const delay = TIMINGS.retries[Math.min(memory.failures, TIMINGS.retries.length) - 1];
      memory.retryAt = this.now() + delay;
      // Written at most once a minute, unless the pause itself is that long.
      if (delay >= TIMINGS.persistGap || this.now() - this.persistedAt >= TIMINGS.persistGap) {
        this.persistedAt = this.now();
        await this.saveMemory();
      }
      if (session !== this.session) return;
      this.logger.warn(`Insteon: ${reason}; next try in ${Math.round(delay / 1000)} s`);
      await this.setStatus(false, fill(T.unreachable, reason, Math.round(delay / 1000)));
      this.retryTimer = this.later(() => this.connect(session), delay);
    }
    if (session !== this.session) return;
    await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
  }

  // --- Background work: identity, scan, status rounds -------------------------------------

  sleepWork(ms) {
    return new Promise((resolve) => {
      const timer = this.later(() => done(), Math.max(0, ms));
      const done = () => {
        this.timers.clearTimeout(timer);
        this.timersSet.delete(timer);
        if (this.wakeWork === done) this.wakeWork = undefined;
        resolve();
      };
      this.wakeWork = done;
    });
  }

  /** One loop per session; a reconnection never restarts a read in progress (its start is in /data). */
  async work(session, generation) {
    // One loop per session and per connection: an older loop ends at its next turn.
    const alive = () =>
      session === this.session && generation === this.workGeneration && this.client.connected;
    while (alive()) {
      if (this.now() >= this.identityDueAt) {
        await this.checkIdentity(session, generation);
        if (this.identity === 'other') return;
        continue;
      }
      // Nothing is read before the identity of the hub is read in this session.
      if (this.identity !== 'ok') {
        await this.sleepWork(this.identityDueAt - this.now());
        continue;
      }
      const memory = this.memory;
      // Never scanned here: once, then never again sooner than 10 min (an
      // interrupted scan is not restarted by a reconnection).
      const scanDue =
        this.seenHub &&
        (this.scanWanted ||
          (memory.place !== placeKey(this.config) &&
            this.now() - memory.lastScanAt >= TIMINGS.scanGap));
      if (scanDue) {
        this.scanWanted = false;
        await this.scanHub(session);
        continue;
      }
      const roundAt = memory.lastRoundAt + this.config.interval;
      if (this.now() >= roundAt) {
        await this.round(session);
        continue;
      }
      await this.sleepWork(Math.min(roundAt, this.identityDueAt) - this.now());
    }
  }

  /** The address the hub must have: typed, else pinned for this place. */
  expectedHub() {
    if (this.config.hubAddress) return this.config.hubAddress;
    const hub = this.memory?.hub;
    return hub && hub.place === placeKey(this.config) ? hub.address : undefined;
  }

  /** The hub address the answers come to. */
  get hubAddress() {
    return this.identity === 'ok' ? this.seenHub : undefined;
  }

  async checkIdentity(session, generation) {
    let info;
    try {
      info = await this.client.send(getImInfo(), {
        match: (m) => (m.id === IM.GET_IM_INFO && m.ack ? m : undefined),
        until: this.now() + TIMINGS.answer,
      });
    } catch {
      info = undefined;
    }
    if (session !== this.session || generation !== this.workGeneration) return;
    if (!info) {
      // Unreadable is not "another hub": asked again in a minute.
      this.identityDueAt = this.now() + 60_000;
      return;
    }
    this.identityDueAt = this.now() + TIMINGS.identity;
    const expected = this.expectedHub();
    if (expected && expected !== info.address) {
      this.identity = 'other';
      this.seenHub = undefined;
      this.logger.error(
        `Insteon: another hub answers (${addressText(info.address)}, expected ${addressText(expected)}): stopped`,
      );
      this.client.stop();
      await this.setStatus(
        false,
        fill(T.otherHub, addressText(info.address), addressText(expected)),
      );
      await this.publishTransports(DEVICE_TRANSPORTS.UNREACHABLE);
      return;
    }
    this.identity = 'ok';
    this.seenHub = info.address;
    const memory = await this.loadMemory();
    if (memory.hub?.address !== info.address || memory.hub?.place !== placeKey(this.config)) {
      this.logger.info(`Insteon: hub ${addressText(info.address)} pinned`);
      memory.hub = { place: placeKey(this.config), address: info.address };
      await this.saveMemory();
    }
  }

  /** The database of the hub, then an ID request to each device of unknown type. */
  async scanHub(session) {
    const generation = this.workGeneration;
    const alive = () =>
      session === this.session && generation === this.workGeneration && this.client.connected;
    const memory = this.memory;
    memory.lastScanAt = this.now();
    await this.saveMemory();
    if (!alive()) return;
    await this.setStatus(true, fill(T.scanning, '0'));
    const found = new Set();
    let records = 0;
    let first = true;
    let misses = 0;
    while (alive() && records < LIMITS.maxRecords && misses < 3) {
      let answer;
      try {
        answer = await this.client.send(first ? getFirstRecord() : getNextRecord(), {
          match: (m) => {
            if (m.id === IM.ALL_LINK_RECORD) return m;
            if (
              (m.id === IM.GET_FIRST_ALL_LINK_RECORD || m.id === IM.GET_NEXT_ALL_LINK_RECORD) &&
              !m.ack
            ) {
              return { end: true };
            }
            return undefined;
          },
          until: this.now() + TIMINGS.answer,
        });
      } catch {
        misses += 1;
        continue;
      }
      if (!alive()) return;
      if (answer.end) break;
      misses = 0;
      first = false;
      records += 1;
      if (answer.inUse && answer.address !== this.seenHub && found.size < LIMITS.maxDevices) {
        found.add(answer.address);
      }
      if (records % 10 === 0) await this.setStatus(true, fill(T.scanning, String(records)));
    }
    if (!alive()) return;
    if (found.size > 0 || misses < 3) {
      for (const address of found) this.addresses.add(address);
    }
    let asked = 0;
    for (const address of this.addresses) {
      if (!alive()) return;
      if (this.devices.has(address)) continue;
      asked += 1;
      await this.setStatus(true, fill(T.scanning, `ID ${asked}`));
      await this.identify(session, address);
    }
    if (!alive()) return;
    await this.saveDevices();
    this.logger.info(
      `Insteon: ${this.addresses.size} linked device(s), ${this.devices.size} of known type`,
    );
    await this.guard(async () => {
      await this.publishDevices();
      await this.publishStates();
      await this.publishTransports(DEVICE_TRANSPORTS.LOCAL, { force: true });
      if (alive()) await this.setStatus(true, this.connectedMessage());
    });
  }

  /** ID request: the device answers with a "set button pressed" broadcast giving its type. */
  async identify(session, address) {
    this.idAskedAt.set(address, this.now());
    try {
      await this.client.send(sendStandard(address, CMD.ID_REQUEST, 0x00), {
        match: (m) =>
          m.id === IM.STANDARD_RECEIVED && m.from === address && m.type === TYPE.BROADCAST
            ? this.learnType(m)
            : undefined,
        until: this.now() + 4_000,
      });
    } catch {
      // A battery device asleep: learnt later (set button, next message).
    }
    return session === this.session && this.devices.has(address);
  }

  /** A device made known outside a scan: kept in /data, the Discovery sent again. */
  deviceLearnt() {
    this.guard(async () => {
      await this.saveDevices();
      await this.publishDevices();
      if (this.client.connected) await this.setStatus(true, this.connectedMessage());
    });
  }

  /** A "set button pressed" broadcast: the type of the device (true when new). */
  learnType(m) {
    if (m.cmd1 !== CMD.ASSIGN_TO_GROUP && m.cmd1 !== CMD.DELETE_FROM_GROUP) return undefined;
    const [cat, subcat, fw] = m.toBytes;
    const old = this.devices.get(m.from);
    if (old) {
      // A known type never changes on a message (forged or corrupted, it could make
      // an I/O Linc or a lock look like a switch): kept until /data is reset.
      if ((old.cat !== cat || old.subcat !== subcat) && !this.retypeLogged.has(m.from)) {
        this.retypeLogged.add(m.from);
        this.logger.warn(`Insteon: ${addressText(m.from)} announced another type, ignored`);
      }
      return false;
    }
    if (this.devices.size >= LIMITS.maxDevices) return false;
    this.devices.set(m.from, newDevice(m.from, cat, subcat, fw));
    if (this.addresses.size < LIMITS.maxDevices) this.addresses.add(m.from);
    return true;
  }

  /** The status round: every device that answers a status request. */
  async round(session) {
    const generation = this.workGeneration;
    const alive = () =>
      session === this.session && generation === this.workGeneration && this.client.connected;
    // Written before the round: a restart or a reconnection does not read again sooner.
    this.memory.lastRoundAt = this.now();
    await this.saveMemory();
    for (const device of [...this.devices.values()]) {
      if (!alive()) return;
      if (!READ_KINDS.has(device.product.kind)) continue;
      await this.readStatus(session, device);
    }
  }

  /** Status request(s) of one device; the model follows what it answers. */
  async readStatus(session, device) {
    const asks = device.product.kind === 'iolinc' ? [0x00, 0x01] : [0x00];
    for (const cmd2 of asks) {
      let level;
      try {
        level = await this.client.send(sendStandard(device.address, CMD.STATUS_REQUEST, cmd2), {
          match: (m) => (this.isAck(m, device.address) ? m.cmd2 : undefined),
          until: this.now() + TIMINGS.answer,
        });
      } catch {
        return;
      }
      if (session !== this.session) return;
      if (device.product.kind === 'iolinc') {
        if (cmd2 === 0x00) device.relay = level > 0;
        else device.input = level > 0;
      } else {
        device.level = level;
      }
      this.noteChange([]);
    }
  }

  /** A direct ACK of `address` to this hub. */
  isAck(m, address) {
    return (
      m.id === IM.STANDARD_RECEIVED &&
      m.type === TYPE.DIRECT_ACK &&
      m.from === address &&
      m.to === this.hubAddress
    );
  }

  /** "Scan" in Gladys: the devices sent again; the hub database read again, not more than every 10 min. */
  async scan() {
    await this.publishDevices({ force: true });
    const memory = await this.loadMemory();
    if (
      this.client.connected &&
      this.identity === 'ok' &&
      this.now() - memory.lastScanAt >= TIMINGS.scanGap
    ) {
      this.scanWanted = true;
      this.wakeWork?.();
    }
  }

  // --- Network messages ------------------------------------------------------------------

  /** A message of the hub, applied to the model at once; Gladys follows once per turn. */
  applyMessage(m) {
    // Nothing is taken from a hub whose identity was not read in this session.
    if (this.identity !== 'ok') return;
    if (m.id !== IM.STANDARD_RECEIVED && m.id !== IM.EXTENDED_RECEIVED) return;
    const direct = [
      TYPE.DIRECT,
      TYPE.DIRECT_ACK,
      TYPE.DIRECT_NAK,
      TYPE.ALL_LINK_CLEANUP,
      TYPE.ALL_LINK_CLEANUP_ACK,
      TYPE.ALL_LINK_CLEANUP_NAK,
    ].includes(m.type);
    // A direct message to another modem is not for this hub.
    if (direct && this.hubAddress && m.to !== this.hubAddress) return;
    if (m.type === TYPE.BROADCAST) {
      if (this.learnType(m) === true) {
        this.logger.info(
          `Insteon: device ${addressText(m.from)} is a ${this.devices.get(m.from).product.description}`,
        );
        this.deviceLearnt();
      }
      return;
    }
    if (m.type === TYPE.ALL_LINK_BROADCAST) {
      this.groupMessage(m.from, m.toLow, m.cmd1, m.hopsLeft, false);
    } else if (m.type === TYPE.ALL_LINK_CLEANUP) {
      this.groupMessage(m.from, m.cmd2, m.cmd1, m.hopsLeft, true);
    } else {
      return;
    }
    // A device of unknown type that speaks is awake: asked what it is (spaced).
    if (!this.devices.has(m.from) && this.client.connected && this.identity === 'ok') {
      const asked = this.idAskedAt.get(m.from);
      if (
        (asked === undefined || this.now() - asked >= TIMINGS.idRetry) &&
        this.idAskedAt.size < 1000
      ) {
        this.identify(this.session, m.from).then((known) => {
          if (known) this.deviceLearnt();
        });
      }
    }
  }

  /**
   * Duplicates: the network repeats a broadcast, then the device sends a
   * cleanup to each responder. pyinsteon's rule: the same command again is
   * new after 2 s, or with more hops left, or with as many after 0.7 s; a
   * cleanup is new only without a broadcast of it within 2 s.
   */
  isNew(from, group, cmd1, hopsLeft, cleanup) {
    const key = `${from}:${group}:${cmd1}`;
    const now = this.now();
    const previous = this.recent.get(key);
    if (this.recent.size > 500) {
      for (const [k, v] of this.recent)
        if (now - v.at >= TIMINGS.maxDuplicate) this.recent.delete(k);
    }
    let fresh;
    if (!previous || now - previous.at >= TIMINGS.maxDuplicate) fresh = true;
    else if (cleanup) fresh = false;
    else if (previous.cleanup) fresh = false;
    else
      fresh =
        hopsLeft > previous.hops ||
        (hopsLeft === previous.hops && now - previous.at > TIMINGS.minDuplicate);
    this.recent.delete(key);
    this.recent.set(key, { at: now, hops: hopsLeft, cleanup });
    return fresh;
  }

  groupMessage(from, group, cmd1, hopsLeft, cleanup) {
    const device = this.devices.get(from);
    const kind = device?.product.kind;
    const on = cmd1 === CMD.ON || cmd1 === CMD.ON_FAST;
    const off = cmd1 === CMD.OFF || cmd1 === CMD.OFF_FAST;
    const fresh = this.isNew(from, group, cmd1, hopsLeft, cleanup);
    let changed = false;
    const set = (field, value) => {
      if (device[field] !== value) changed = true;
      device[field] = value;
    };
    if (device && (on || off)) {
      if ((kind === 'relay' || kind === 'dimmer') && group === 1) {
        if (off) set('level', 0);
        else if (kind === 'relay' || cmd1 === CMD.ON_FAST) set('level', 255);
        // A dimmer turned on goes to its own on-level: read it.
        else if (fresh) this.eventRead(device);
      } else if (kind === 'iolinc' && group === 1) {
        set('input', on);
      } else if (kind === 'motion') {
        if (group === 1) set('motion', on);
        if (group === 3) set('batteryLow', on);
      } else if (kind === 'opening') {
        const closed = onMeansClosed(device.product);
        if (group === 1 || (group === 4 && !closed)) set('open', closed ? off : on);
        if (group === 3 && !closed) set('batteryLow', on);
      } else if (kind === 'leak') {
        if (group === 1 && on) set('leak', false);
        if (group === 2 && on) set('leak', true);
        if (group === 4) set('leak', off);
      } else if (kind === 'smoke' && on) {
        if (group === 1) set('smoke', true);
        if (group === 2) set('co', true);
        if (group === 5) {
          set('smoke', false);
          set('co', false);
        }
        if (group === 6) set('batteryLow', true);
      }
    }
    if (device && cmd1 === CMD.STOP_MANUAL_CHANGE && group === 1 && fresh) {
      if (kind === 'dimmer' || kind === 'relay') this.eventRead(device);
    }
    const events = [];
    const action = ACTIONS_OF_COMMAND.get(cmd1);
    if (fresh && action && (!device || BUTTON_KINDS.has(kind)) && this.publisher.reserveEvent()) {
      events.push({
        address: addressText(from),
        button: group,
        action,
        name: device ? device.product.description : '',
      });
    }
    if (changed || events.length > 0) this.noteChange(events);
  }

  /** A read after a change seen on the network (a dimmer's level), at most every 10 s per device. */
  eventRead(device) {
    const last = this.eventReadAt.get(device.address);
    if (last !== undefined && this.now() - last < TIMINGS.eventRead) return;
    this.eventReadAt.set(device.address, this.now());
    const session = this.session;
    this.later(() => {
      if (session === this.session && this.client.connected) this.readStatus(session, device);
    }, 1_000);
  }

  noteChange(events) {
    this.pendingEvents.push(...events);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.guard(() => this.flushChanges());
    });
  }

  async flushChanges() {
    const events = this.pendingEvents.splice(0);
    await this.publishStates();
    for (const event of events) await this.publisher.sceneEvent(SCENE_TRIGGERS.BUTTON, event);
  }

  // --- Gladys --------------------------------------------------------------------------

  async publishDevices({ force = false } = {}) {
    const devices = buildDevices(this.gladys, this.config, this.model);
    if (devices.length === 0 && !force) return;
    const json = JSON.stringify(devices);
    if (json === this.published && !force) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the devices failed: ${err.message}`);
    }
  }

  publishStates() {
    if (this.devices.size === 0) return Promise.resolve();
    return this.publisher.publish(buildStates(this.gladys, this.config, this.model));
  }

  async publishTransports(transport, { force = false } = {}) {
    if (transport === this.lastTransport && !force) return;
    const devices = buildDevices(this.gladys, this.config, this.model);
    if (devices.length === 0) return;
    const entries = devices.map((device) => ({ external_id: device.external_id, transport }));
    try {
      for (let i = 0; i < entries.length; i += 100) {
        await this.gladys.publishTransports(entries.slice(i, i + 100));
      }
      this.lastTransport = transport;
    } catch (err) {
      this.logger.warn(`Publishing the transports failed: ${err.message}`);
    }
  }

  /** The user created or updated a device: Gladys has none of its states yet. */
  async deviceChanged(device) {
    this.publisher.forget(device?.external_id);
    await this.publishStates();
  }

  // --- Commands ----------------------------------------------------------------------

  /** One turn at a time per device; a failed one never blocks the next. */
  serial(key, fn) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(key, tail);
    tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  async setValue(_device, feature, value) {
    const target = parseFeatureId(feature?.external_id);
    if (!target) throw new Error(`${feature?.external_id} is not an Insteon feature`);
    const asked = this.now();
    const device = this.devices.get(target.address);
    if (!device) throw this.refused(T.unknownDevice);
    const { key } = target;
    const kind = device.product.kind;
    const text = addressText(device.address);
    let level;
    let gate;
    if (SAFE_KEYS.has(key)) {
      const lightKeys = kind === 'dimmer' ? ['binary', 'brightness'] : ['switch', 'light'];
      if (!lightKeys.includes(key) || (kind !== 'dimmer' && kind !== 'relay')) {
        throw this.refused(T.readOnly);
      }
      gate = () => this.config.safe.has(device.address);
      if (!gate()) {
        this.logger.warn(`Command REFUSED on ${text}: not declared safe`);
        throw this.refused(T.notSafe);
      }
      if (key === 'brightness') {
        const n = numberOf(value);
        if (n === undefined || n < 0 || n > 100) {
          throw this.refused(fill(T.badValue, JSON.stringify(value)));
        }
        level = Math.round((Math.round(n) * 255) / 100);
      } else {
        const on = binaryOf(value);
        if (on === undefined) throw this.refused(fill(T.badValue, JSON.stringify(value)));
        level = on ? 255 : 0;
      }
    } else if (key === 'turn_on' || key === 'turn_off') {
      if (kind !== 'dimmer' && kind !== 'relay') throw this.refused(T.readOnly);
      gate = () => this.config.allowButtons;
      if (!gate()) {
        this.logger.warn(`Command REFUSED on ${text}: buttons disabled`);
        throw this.refused(T.buttonsOff);
      }
      if (binaryOf(value) !== 1) throw this.refused(fill(T.badValue, JSON.stringify(value)));
      level = key === 'turn_on' ? 255 : 0;
    } else {
      throw this.refused(T.readOnly);
    }
    // Only dimmers and switches (categories 01 and 02) ever take a command.
    if (device.cat !== 0x01 && device.cat !== 0x02) throw this.refused(T.readOnly);
    if (this.identity === 'other') throw this.refused(T.otherHubCommand);
    // The hub must have been identified in this very session.
    if (this.identity !== 'ok' || !this.hubAddress) throw this.refused(T.hubUnknown);
    return this.command(device, level, asked, gate, key === 'brightness');
  }

  /**
   * One command: written in the device's turn (the turn ends at the request,
   * the confirmation is awaited outside it), confirmed by the device's ACK
   * carrying a level equal to the one asked.
   */
  async command(device, level, asked, gate, exact) {
    const text = addressText(device.address);
    const what =
      level === 255
        ? fill(COMMAND_NAMES.on, text)
        : fill(COMMAND_NAMES.level, text, percent(level));
    const cmd1 = level === 0 ? CMD.OFF : CMD.ON;
    const bytes = sendStandard(device.address, cmd1, level);
    const hub = this.hubAddress;
    let done;
    await this.serial(device.address, async () => {
      let markWritten;
      const written = new Promise((resolve) => {
        markWritten = resolve;
      });
      this.logger.info(`Command from Gladys: ${what.en}`);
      done = this.client.send(bytes, {
        urgent: true,
        sendBy: asked + TIMINGS.sendBy,
        // Right before the request: the option or the declaration, and the hub.
        beforeSend: () => gate() && this.identity === 'ok' && this.seenHub === hub,
        match: (m) => {
          if (m.id !== IM.STANDARD_RECEIVED || m.from !== device.address || m.to !== hub)
            return undefined;
          if (m.type === TYPE.DIRECT_NAK) return { nak: true };
          if (m.type === TYPE.DIRECT_ACK && m.cmd1 === cmd1) return { level: m.cmd2 };
          return undefined;
        },
        until: asked + TIMINGS.answerBy,
        onWritten: () => markWritten(),
      });
      done.catch(() => undefined);
      await Promise.race([written, done.catch(() => undefined)]);
    });
    let answer;
    try {
      answer = await done;
    } catch (err) {
      throw this.sendError(err, what, device, gate);
    }
    if (answer.nak) {
      this.logger.warn(`Command REFUSED by the device (${what.en})`);
      this.scheduleReadBack(device);
      throw this.error(fill(T.deviceRefused, word(what, this.config.language)));
    }
    const confirmed =
      level === 0
        ? answer.level === 0
        : exact
          ? percent(answer.level) === percent(level)
          : answer.level > 0;
    if (!confirmed) {
      this.logger.warn(`Command sent, the device answered level ${answer.level} (${what.en})`);
      device.level = answer.level;
      this.noteChange([]);
      throw this.error(fill(T.unconfirmed, word(what, this.config.language)));
    }
    device.level = answer.level;
    this.noteChange([]);
    this.logger.info(`Command confirmed by the device (${what.en})`);
  }

  sendError(err, what, device, gate) {
    if (err instanceof ClientError && !err.sent) {
      this.logger.warn(`Command NOT sent (${what.en}): ${err.message}`);
      if (err.kind === 'late') return this.refused(T.tooLate);
      if (err.kind === 'full') return this.refused(T.queueFull);
      if (err.kind === 'withdrawn') {
        if (this.identity === 'other') return this.refused(T.otherHubCommand);
        if (!gate()) return this.refused(this.config.allowButtons ? T.notSafe : T.buttonsOff);
        return this.refused(T.hubUnknown);
      }
      return this.refused(T.offline);
    }
    this.logger.warn(`Command sent, NOT confirmed (${what.en}): ${err.message}`);
    this.scheduleReadBack(device);
    return this.error(fill(T.unconfirmed, word(what, this.config.language)));
  }

  scheduleReadBack(device) {
    const session = this.session;
    this.later(() => {
      if (session === this.session && this.client.connected) this.readStatus(session, device);
    }, TIMINGS.readBack);
  }

  // --- Configuration button -------------------------------------------------------------

  waitForLink(timeout) {
    if (this.client.connected) return Promise.resolve('up');
    return new Promise((resolve) => {
      const done = (result) => {
        this.client.off('up', onUp);
        this.client.off('down', onDown);
        this.timers.clearTimeout(timer);
        resolve(result);
      };
      const onUp = () => done('up');
      const onDown = () => done('down');
      const timer = this.timers.setTimeout(() => done('timeout'), timeout);
      this.client.on('up', onUp);
      this.client.on('down', onDown);
    });
  }

  /**
   * "Test the connection": one try when stopped (a refusal is erased only by
   * a success), never during a pause; never a device read.
   */
  async testConnection() {
    const problem = this.configProblem();
    if (problem) throw this.error(problem);
    if (this.identity === 'other') {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.otherHubCommand);
    }
    const memory = await this.loadMemory();
    if (!this.client.connected && !this.client.busy) {
      if (memory.retryAt > this.now()) {
        const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
        throw this.error(message ?? T.offline);
      }
      await this.setStatus(false, T.connecting);
      this.connect(this.session);
    }
    const result = await this.waitForLink(TIMINGS.testWait);
    await this.chain;
    if (result === 'timeout') throw this.error(T.stillConnecting);
    if (result !== 'up') {
      const [, message] = this.lastStatus ? JSON.parse(this.lastStatus) : [];
      throw this.error(message ?? T.offline);
    }
    const hub = this.hubAddress;
    return fill(T.testOk, hub ? addressText(hub) : '?', shownDevices(this.model).length);
  }
}
