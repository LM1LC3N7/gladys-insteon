// InsteonApp with the SDK's fake Gladys (createFakeGladys), the in-memory hub
// (test/helpers/fakeHub.js) and a virtual clock: the whole chain from the hub
// buffer to the Gladys devices, states, scene events and commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { InsteonApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeClock, FakeHub, quietLogger, settle, until } from './helpers/fakeHub.js';

const BASE = { host: '192.0.2.40', username: 'user', password: 'secret', language: 'en' };
const DIMMER = '1a2b3c';
const RELAY = '2b3c4d';
const MOTION = '3c4d5e';
const KEYPAD = '4d5e6f';
const DOOR = '5e6f70';
const LEAK = '6f7081';

const network = () => [
  { address: DIMMER, cat: 0x01, subcat: 0x20, level: 0x80 }, // SwitchLinc dimmer
  { address: RELAY, cat: 0x02, subcat: 0x2a, level: 0 }, // SwitchLinc relay
  { address: MOTION, cat: 0x10, subcat: 0x01, asleep: true }, // motion sensor 2842
  { address: KEYPAD, cat: 0x01, subcat: 0x41, level: 0xff }, // KeypadLinc dimmer
  { address: DOOR, cat: 0x10, subcat: 0x11, asleep: true }, // door sensor 2845
  { address: LEAK, cat: 0x10, subcat: 0x08, asleep: true }, // leak sensor
];

async function setup(
  t,
  { config = {}, store, devices, hub: hubOptions = {}, clock = new FakeClock(), ready = true } = {},
) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config }, devices });
  const hub = new FakeHub({ clock, devices: network(), ...hubOptions });
  const logger = quietLogger();
  const memory = store ?? memoryStore();
  const app = new InsteonApp({
    gladys,
    logger,
    transportFactory: hub.transportFactory,
    store: memory,
    now: clock.now,
    timers: clock,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  t.after(() => app.stop());
  const ids = (address) => gladys.externalIds('insteon', address);
  const device = (address) =>
    gladys.fake.discoveredDevices.find((d) => d.external_id === ids(address).device);
  const ctx = {
    gladys,
    hub,
    app,
    clock,
    logger,
    store: memory,
    ids,
    device,
    keys: (address) => device(address)?.features.map((f) => f.external_id.split(':').at(-1)),
    state: (address, key) => gladys.fake.lastState(ids(address).feature(key)),
    status: () => gladys.fake.connectionStatus,
    set: (address, key, value) => {
      const d = device(address) ?? { external_id: ids(address).device, features: [] };
      const f = d.features.find((x) => x.external_id === ids(address).feature(key)) ?? {
        external_id: ids(address).feature(key),
      };
      return gladys.fake.setValue(d, f, value);
    },
    command: async (address, key, value, ms = 6_000) => {
      const pending = ctx.set(address, key, value);
      await ctx.clock.advance(ms);
      return pending;
    },
  };
  if (ready) await scanned(ctx);
  return ctx;
}

/** Identity, database, ID requests (sensors asleep: 3 misses of 4 s), status round. */
async function scanned(ctx) {
  await until(() => ctx.app.client.connected);
  await ctx.clock.advance(60_000);
  await ctx.app.chain;
  await settle();
}

test('the scan: hub pinned, devices typed, unknown sensors listed, states read', async (t) => {
  const ctx = await setup(t, { config: { safe_devices: `${RELAY}` } });
  const { store } = ctx;
  assert.equal(store.data.hub.address, 'aabbcc');
  assert.deepEqual(store.data.devices.map((d) => d.address).sort(), [DIMMER, KEYPAD, RELAY].sort());
  assert.equal(store.data.addresses.length, 6);
  assert.ok(store.data.lastRoundAt > 0 && store.data.lastScanAt > 0);
  // A dimmer not declared: a state, a level and two buttons; never a light.
  assert.deepEqual(ctx.keys(DIMMER), ['state', 'level', 'turn_on', 'turn_off']);
  const dimmer = ctx.device(DIMMER);
  assert.deepEqual(
    dimmer.features.map((f) => [f.category, f.type, f.read_only]),
    [
      ['unknown', 'binary', true],
      ['unknown', 'unknown', true],
      ['button', 'push', false],
      ['button', 'push', false],
    ],
  );
  assert.equal(dimmer.name, 'SwitchLinc Dimmer 1A.2B.3C');
  // The relay declared safe: a switch.
  assert.deepEqual(ctx.keys(RELAY), ['switch']);
  assert.equal(ctx.state(DIMMER, 'state'), 1);
  assert.equal(ctx.state(DIMMER, 'level'), 50);
  assert.equal(ctx.state(KEYPAD, 'level'), 100);
  assert.equal(ctx.state(RELAY, 'switch'), 0);
  // Sensors asleep: not published yet, listed in the status.
  assert.equal(ctx.device(MOTION), undefined);
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /3 devices\..*Type not known yet.*3C\.4D\.5E/);
  // The set button of the motion sensor: learnt, published, kept.
  ctx.hub.setButton(MOTION);
  await ctx.clock.advance(2_000);
  await ctx.app.chain;
  assert.deepEqual(ctx.keys(MOTION), ['motion', 'battery_low']);
  assert.ok(ctx.store.data.devices.some((d) => d.address === MOTION));
});

test('states follow the broadcasts; buttons become scene events once', async (t) => {
  const ctx = await setup(t);
  for (const address of [MOTION, DOOR, LEAK]) ctx.hub.setButton(address);
  await ctx.clock.advance(2_000);
  ctx.hub.broadcast(MOTION, 1, 0x11);
  ctx.hub.broadcast(DOOR, 1, 0x11);
  ctx.hub.broadcast(LEAK, 2, 0x11);
  await ctx.clock.advance(1_000);
  await ctx.app.chain;
  assert.equal(ctx.state(MOTION, 'motion'), 1);
  assert.equal(ctx.state(DOOR, 'opening'), 0, 'open: 0 in Gladys');
  assert.equal(ctx.state(LEAK, 'leak'), 1);
  // A keypad button: the broadcast, a repeat, then the cleanup: one event.
  ctx.hub.broadcast(KEYPAD, 3, 0x11, 3);
  ctx.hub.broadcast(KEYPAD, 3, 0x11, 2);
  ctx.hub.cleanup(KEYPAD, 3, 0x11);
  await ctx.clock.advance(1_000);
  await ctx.app.chain;
  const events = ctx.gladys.fake.sceneEvents.filter((e) => e.data.address === '4D.5E.6F');
  assert.deepEqual(events, [
    {
      key: 'button',
      data: { address: '4D.5E.6F', button: 3, action: 'on', name: 'Keypad Dimmer' },
    },
  ]);
  // Sensors are no buttons.
  assert.ok(!ctx.gladys.fake.sceneEvents.some((e) => e.data.address === '3C.4D.5E'));
  // The same press 3 s later is a new one.
  await ctx.clock.advance(3_000);
  ctx.hub.broadcast(KEYPAD, 3, 0x13);
  await ctx.clock.advance(1_000);
  await ctx.app.chain;
  assert.equal(ctx.gladys.fake.sceneEvents.filter((e) => e.data.address === '4D.5E.6F').length, 2);
});

test('a declared dimmer: brightness sent, confirmed by the level the device answers', async (t) => {
  const ctx = await setup(t, { config: { safe_devices: `1A.2B.3C, ${RELAY} light` } });
  assert.deepEqual(ctx.keys(DIMMER), ['binary', 'brightness']);
  assert.deepEqual(ctx.keys(RELAY), ['light']);
  const ack = await ctx.command(DIMMER, 'brightness', 30);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ctx.hub.writes.at(-1), '02621A2B3C0F114D');
  await ctx.app.chain;
  assert.equal(ctx.state(DIMMER, 'brightness'), 30);
  const off = await ctx.command(RELAY, 'light', 0);
  assert.equal(off.success, true, off.error);
  assert.equal(ctx.hub.writes.at(-1), '02622B3C4D0F1300');
  // The buffer is read, cleared and read again right before each message.
  const i = ctx.hub.requests.findLastIndex((r) => r.path.startsWith('/3?'));
  assert.deepEqual(
    ctx.hub.requests.slice(i - 3, i).map((r) => r.path),
    ['/buffstatus.xml', '/1?XB=M=1', '/buffstatus.xml'],
  );
});

test('not declared safe: refused, nothing sent; the buttons only when allowed', async (t) => {
  const ctx = await setup(t, { config: { safe_devices: '' } });
  const before = ctx.hub.writes.length;
  // A light key forged on a device not declared: refused.
  const forged = await ctx.command(DIMMER, 'binary', 1);
  assert.equal(forged.success, false);
  assert.match(forged.error, /not declared safe in the configuration: nothing was sent/);
  const button = await ctx.command(DIMMER, 'turn_on', 1);
  assert.match(button.error, /disabled in the configuration: nothing was sent/);
  assert.equal(ctx.hub.writes.length, before);
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_output_buttons: true });
  const on = await ctx.command(DIMMER, 'turn_on', 1);
  assert.equal(on.success, true, on.error);
  assert.equal(ctx.hub.writes.at(-1), '02621A2B3C0F11FF');
  const bad = await ctx.command(DIMMER, 'turn_off', 0);
  assert.match(bad.error, /Invalid value/);
});

test('a silent device: "sent, without confirmation", then read back', async (t) => {
  const ctx = await setup(t, { config: { safe_devices: DIMMER } });
  ctx.hub.devices.get(DIMMER).silent = true;
  const ack = await ctx.command(DIMMER, 'binary', 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /sent, without confirmation/);
  ctx.hub.devices.get(DIMMER).silent = false;
  await ctx.clock.advance(5_000);
  assert.equal(ctx.hub.writes.at(-1), '02621A2B3C0F1900');
  // Another level answered: not confirmed either.
  ctx.hub.devices.get(DIMMER).answerLevel = 0x40;
  const other = await ctx.command(DIMMER, 'brightness', 80);
  assert.match(other.error, /sent, without confirmation/);
});

test('too slow a hub: refused before the deadline, nothing sent', async (t) => {
  const ctx = await setup(t, { config: { safe_devices: DIMMER } });
  const before = ctx.hub.writes.length;
  ctx.hub.latency = 2_000;
  const ack = await ctx.command(DIMMER, 'binary', 1, 10_000);
  assert.equal(ack.success, false);
  assert.match(ack.error, /too slow.*nothing was sent/);
  assert.equal(ctx.hub.writes.length, before);
});

test('the option switched off while the command waits: withdrawn before the request', async (t) => {
  const ctx = await setup(t, { config: { allow_output_buttons: true } });
  const before = ctx.hub.writes.length;
  ctx.hub.latency = 400;
  const pending = ctx.set(DIMMER, 'turn_on', 1);
  await ctx.clock.advance(100);
  await ctx.gladys.fake.configUpdated({ ...BASE, allow_output_buttons: false });
  await ctx.clock.advance(6_000);
  const ack = await pending;
  assert.match(ack.error, /disabled in the configuration: nothing was sent/);
  assert.equal(ctx.hub.writes.length, before);
});

test('the ack of a command never waits for the publication', async (t) => {
  const ctx = await setup(t, { config: { safe_devices: DIMMER } });
  ctx.gladys.publishStates = () => new Promise(() => {});
  const ack = await ctx.command(DIMMER, 'binary', 1);
  assert.equal(ack.success, true, ack.error);
});

test('refused credentials: stop persisted (hash of the refused pair only), no new try', async (t) => {
  const clock = new FakeClock();
  const store = memoryStore();
  const ctx = await setup(t, { config: { password: 'wrong' }, store, clock, ready: false });
  await ctx.clock.advance(1_000);
  await ctx.app.chain;
  assert.match(ctx.status().message.en, /refused the user name or the password/);
  const stop = store.data.stop;
  assert.equal(stop.kind, 'credentials_refused');
  assert.ok(!JSON.stringify(store.data).includes('wrong'));
  assert.ok(!ctx.logger.lines.some((l) => l.includes('wrong')));
  const count = ctx.hub.requests.length;
  await ctx.clock.advance(3_600_000);
  assert.equal(ctx.hub.requests.length, count, 'never tried again');
  // A restart with the same pair: still stopped, nothing sent.
  ctx.app.stop();
  const again = await setup(t, { config: { password: 'wrong' }, store, clock, ready: false });
  await clock.advance(10_000);
  assert.equal(again.hub.requests.length, 0);
  // The right password: tried at once; the success erases the stop.
  await again.gladys.fake.configUpdated({ ...BASE });
  await clock.advance(2_000);
  await again.app.chain;
  assert.equal(again.status().connected, true);
  assert.equal(store.data.stop, null);
});

test('the test button erases a refusal only after a success', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { config: { password: 'wrong' }, store, ready: false });
  await ctx.clock.advance(1_000);
  await ctx.app.chain;
  const pending = ctx.gladys.fake.action('test_connection');
  await ctx.clock.advance(2_000);
  const result = await pending;
  assert.equal(result.success, false);
  assert.ok(store.data.stop, 'still stopped');
  // The hub accepts it now (the password was changed on the hub side).
  ctx.hub.password = 'wrong';
  const ok = ctx.gladys.fake.action('test_connection');
  await ctx.clock.advance(2_000);
  const answer = await ok;
  assert.equal(answer.success, true, answer.error);
  assert.equal(store.data.stop, null);
});

test('an unreachable hub: tries spaced, the pause kept across a restart', async (t) => {
  const clock = new FakeClock();
  const store = memoryStore();
  const ctx = await setup(t, { store, clock, ready: false });
  ctx.hub.down = true;
  ctx.app.stop();
  const app2 = await setup(t, { store, clock, ready: false, hub: {} });
  app2.hub.down = true;
  await clock.advance(1_000);
  await app2.app.chain;
  assert.match(app2.status().message.en, /unreachable.*next try in 10 s/);
  const first = app2.hub.requests.length;
  await clock.advance(9_000);
  assert.equal(app2.hub.requests.length, first);
  await clock.advance(2_000);
  assert.equal(app2.hub.requests.length, first + 1);
  await clock.advance(31_000);
  await app2.app.chain;
  // 3 failures: a pause of 60 s, written in /data.
  assert.ok(store.data.retryAt > clock.now() + 50_000);
  app2.app.stop();
  const app3 = await setup(t, { store, clock, ready: false });
  await clock.advance(20_000);
  assert.equal(app3.hub.requests.length, 0, 'the pause holds after a restart');
  await clock.advance(45_000);
  assert.ok(app3.hub.requests.length > 0);
});

test('another hub at the same address: nothing read nor sent until its address is typed', async (t) => {
  const store = memoryStore();
  const ctx = await setup(t, { store, config: { safe_devices: DIMMER } });
  ctx.app.stop();
  const other = await setup(t, {
    store,
    config: { safe_devices: DIMMER },
    hub: { hub: '112233' },
    ready: false,
  });
  await other.clock.advance(5_000);
  await other.app.chain;
  assert.match(other.status().message.en, /Another hub answers.*11\.22\.33, expected AA\.BB\.CC/);
  const ack = await other.command(DIMMER, 'binary', 1);
  assert.equal(ack.success, false);
  assert.equal(other.hub.writes.filter((w) => w.includes('0F11')).length, 0);
  await other.gladys.fake.configUpdated({ ...BASE, safe_devices: DIMMER, hub_address: '11.22.33' });
  await other.clock.advance(5_000);
  await other.app.chain;
  assert.equal(other.status().connected, true);
  assert.equal(store.data.hub.address, '112233');
});

test('never read again sooner than the interval: restart, Gladys reconnection, test button', async (t) => {
  const store = memoryStore();
  const clock = new FakeClock();
  const ctx = await setup(t, { store, clock });
  const statusReads = (hub) => hub.writes.filter((w) => w.slice(12, 14) === '19').length;
  ctx.app.stop();
  const again = await setup(t, { store, clock, ready: false });
  await clock.advance(60_000);
  await again.app.chain;
  assert.equal(statusReads(again.hub), 0, 'a restart does not read sooner');
  assert.ok(again.device(DIMMER), 'the devices come from /data');
  // Gladys restarted: status and devices sent again, no read.
  await again.gladys.disconnect();
  await again.gladys.connect();
  await clock.advance(1_000);
  assert.equal(statusReads(again.hub), 0);
  assert.equal(again.status().connected, true);
  const test = again.gladys.fake.action('test_connection');
  await clock.advance(1_000);
  assert.match((await test).data.message.en, /The hub answers \(Insteon address AA\.BB\.CC\)/);
  assert.equal(statusReads(again.hub), 0);
  // The interval (10 min) passed: one round.
  await clock.advance(10 * 60_000);
  assert.ok(statusReads(again.hub) >= 2);
});

test('a scene event never carries undefined; a burst is bounded', async (t) => {
  const ctx = await setup(t);
  // 150 different buttons within a minute (a device of unknown type: still a button).
  for (let i = 1; i <= 150; i += 1) {
    ctx.hub.broadcast('777777', i, 0x11);
    await ctx.clock.advance(300);
  }
  await ctx.app.chain;
  const events = ctx.gladys.fake.sceneEvents.filter((e) => e.data.address === '77.77.77');
  assert.equal(events.length, 120, 'the budget of the minute');
  for (const event of events) {
    for (const value of Object.values(event.data)) assert.notEqual(value, undefined);
  }
});
