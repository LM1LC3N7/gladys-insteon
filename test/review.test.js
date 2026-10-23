// The scenarios of review 1 (hostile hub, forged messages, outages), kept as
// regression tests: the real InsteonApp, the SDK fake Gladys, the fake hub.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { InsteonApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { FakeClock, FakeHub, quietLogger, settle, until } from './helpers/fakeHub.js';

const BASE = { host: '192.0.2.40', username: 'user', password: 'secret', language: 'en' };
const DIMMER = '1a2b3c';
const ON = '02621A2B3C0F11FF';
const net = (extra = []) => [
  { address: DIMMER, cat: 0x01, subcat: 0x20, level: 0x80 },
  { address: '2b3c4d', cat: 0x02, subcat: 0x2a, level: 0 },
  ...extra,
];

async function setup(t, { config = {}, store, hub, clock, ready = true, beforeConnect } = {}) {
  const gladys = createFakeGladys({ config: { ...BASE, ...config } });
  const logger = quietLogger();
  const app = new InsteonApp({
    gladys,
    logger,
    transportFactory: hub.transportFactory,
    store: store ?? memoryStore(),
    now: clock.now,
    timers: clock,
  });
  registerHandlers(gladys, app, logger);
  beforeConnect?.(app, gladys);
  await gladys.connect();
  t.after(() => app.stop());
  const ids = (address) => gladys.externalIds('insteon', address);
  const set = (address, key, value) =>
    gladys.fake.setValue(
      { external_id: ids(address).device, features: [] },
      { external_id: ids(address).feature(key) },
      value,
    );
  if (ready) {
    await until(() => app.client.connected);
    await clock.advance(60_000);
    await app.chain;
    await settle();
  }
  return { gladys, app, hub, clock, logger, ids, set };
}

test('restart with another hub at the IP: a command at "up" is refused, nothing sent', async (t) => {
  const store = memoryStore();
  const clock = new FakeClock();
  const config = { safe_devices: DIMMER };
  const a = await setup(t, { store, clock, config, hub: new FakeHub({ clock, devices: net() }) });
  a.app.stop();
  const other = new FakeHub({ clock, devices: net(), hub: '112233' });
  let pending;
  const b = await setup(t, {
    store,
    clock,
    config,
    hub: other,
    ready: false,
    beforeConnect: (app, gladys) =>
      app.client.once('up', () => {
        pending = gladys.fake.setValue(
          { external_id: gladys.externalIds('insteon', DIMMER).device, features: [] },
          { external_id: gladys.externalIds('insteon', DIMMER).feature('binary') },
          1,
        );
      }),
  });
  await until(() => pending !== undefined);
  await clock.advance(6_000);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.match(ack.error, /identity of the hub is not known yet: nothing was sent/);
  assert.equal(other.writes.filter((w) => w === ON).length, 0);
  await b.app.chain;
  assert.match(b.gladys.fake.connectionStatus.message.en, /Another hub answers/);
});

test('an outage, then another hub: the identity is read again before any command', async (t) => {
  const clock = new FakeClock();
  const hub = new FakeHub({ clock, devices: net() });
  const ctx = await setup(t, { clock, hub, config: { safe_devices: DIMMER } });
  hub.down = true;
  await clock.advance(5_000);
  await ctx.app.chain;
  assert.equal(ctx.app.client.connected, false);
  hub.down = false;
  hub.hub = '112233';
  let pending;
  ctx.app.client.once('up', () => {
    pending = ctx.set(DIMMER, 'binary', 1);
  });
  await clock.advance(15_000);
  await until(() => pending !== undefined);
  const ack = await pending;
  assert.equal(ack.success, false);
  assert.equal(hub.writes.filter((w) => w === ON).length, 0);
  assert.equal(ctx.app.identity, 'other');
});

class NoClearHub extends FakeHub {
  clear() {}
}

test('a hub that never clears its buffer: an old ACK never confirms a new command', async (t) => {
  const clock = new FakeClock();
  const hub = new NoClearHub({ clock, devices: [{ address: DIMMER, cat: 0x01, subcat: 0x20 }] });
  const ctx = await setup(t, { clock, hub, config: { safe_devices: DIMMER } });
  const p1 = ctx.set(DIMMER, 'binary', 0);
  await clock.advance(6_000);
  assert.equal((await p1).success, true, 'the answer after its own echo');
  hub.devices.get(DIMMER).silent = true;
  const p2 = ctx.set(DIMMER, 'binary', 0);
  await clock.advance(6_000);
  const second = await p2;
  assert.equal(second.success, false);
  assert.match(second.error, /sent, without confirmation/);
});

test('two commands back to back: each one is confirmed by its own ACK', async (t) => {
  const clock = new FakeClock();
  const hub = new FakeHub({ clock, devices: net() });
  const ctx = await setup(t, { clock, hub, config: { safe_devices: DIMMER } });
  const p1 = ctx.set(DIMMER, 'brightness', 40);
  const p2 = ctx.set(DIMMER, 'brightness', 80);
  await clock.advance(6_000);
  const [a1, a2] = await Promise.all([p1, p2]);
  assert.equal(a1.success, true, a1.error);
  assert.equal(a2.success, true, a2.error);
  await ctx.app.chain;
  assert.equal(ctx.gladys.fake.lastState(ctx.ids(DIMMER).feature('brightness')), 80);
});

test('brightness 100 is confirmed only by 100 %', async (t) => {
  const clock = new FakeClock();
  const hub = new FakeHub({ clock, devices: net() });
  const ctx = await setup(t, { clock, hub, config: { safe_devices: DIMMER } });
  hub.devices.get(DIMMER).answerLevel = 0x20;
  const p = ctx.set(DIMMER, 'brightness', 100);
  await clock.advance(6_000);
  assert.match((await p).error, /sent, without confirmation/);
  hub.devices.get(DIMMER).answerLevel = undefined;
  const on = ctx.set(DIMMER, 'binary', 1);
  await clock.advance(6_000);
  assert.equal((await on).success, true);
});

test('a broadcast claiming another type never makes an I/O Linc commandable', async (t) => {
  const clock = new FakeClock();
  const iolinc = { address: '0a0000', cat: 0x07, subcat: 0x00, kind: 'iolinc', level: 0 };
  const hub = new FakeHub({ clock, devices: [iolinc] });
  const ctx = await setup(t, {
    clock,
    hub,
    config: { safe_devices: '0a0000', allow_output_buttons: true },
  });
  assert.equal(ctx.app.devices.get('0a0000').product.kind, 'iolinc');
  hub.put('02500a0000020a008b0100');
  await clock.advance(1_000);
  await ctx.app.chain;
  assert.equal(ctx.app.devices.get('0a0000').product.kind, 'iolinc');
  assert.ok(ctx.logger.lines.some((l) => /0A\.00\.00 announced another type, ignored/.test(l)));
  for (const key of ['turn_on', 'switch', 'binary']) {
    const p = ctx.set('0a0000', key, 1);
    await clock.advance(6_000);
    assert.equal((await p).success, false, key);
  }
  assert.deepEqual(
    hub.writes.filter((w) => w.startsWith('0262') && !['10', '19'].includes(w.slice(12, 14))),
    [],
  );
});

test('a command behind a hanging read is refused at its deadline', async (t) => {
  const clock = new FakeClock();
  const hub = new FakeHub({ clock, devices: net() });
  const ctx = await setup(t, { clock, hub, config: { safe_devices: DIMMER } });
  hub.hang = true;
  await clock.advance(600);
  hub.hang = false;
  const asked = clock.now();
  let at;
  const p = ctx.set(DIMMER, 'binary', 1).then((r) => {
    at = clock.now();
    return r;
  });
  await clock.advance(10_000);
  const ack = await p;
  assert.match(ack.error, /too slow.*nothing was sent/);
  assert.ok(at - asked <= 3_600, `answered at +${at - asked} ms`);
  assert.equal(hub.writes.filter((w) => w === ON).length, 0);
});

test('outages never pile up work loops', async (t) => {
  const clock = new FakeClock();
  const hub = new FakeHub({ clock, devices: net() });
  const ctx = await setup(t, { clock, hub });
  for (let i = 0; i < 5; i += 1) {
    hub.down = true;
    await clock.advance(3_000);
    hub.down = false;
    await clock.advance(15_000);
    await ctx.app.chain;
  }
  assert.equal(ctx.app.client.connected, true);
  const start = hub.writes.length;
  await clock.advance(20 * 60_000);
  const writes = hub.writes.slice(start);
  assert.ok(writes.filter((w) => w === '0260').length <= 2, 'identity every 10 min');
  // Two devices read at most twice each (two rounds) in 20 minutes.
  assert.ok(writes.filter((w) => w.slice(12, 14) === '19').length <= 4);
});
