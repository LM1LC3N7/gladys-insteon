import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseHost, parseSafeDevices } from '../src/config.js';
import { normalizeMemory, refusedHash } from '../src/store.js';

test('the address of the hub', () => {
  assert.deepEqual(parseHost('192.168.1.5'), { host: '192.168.1.5', port: undefined });
  assert.deepEqual(parseHost('http://hub.lan:8080/'), { host: 'hub.lan', port: 8080 });
  assert.equal(parseHost('https://hub.lan').host, '');
  assert.equal(parseHost('user:pass@hub.lan').host, '');
  const config = normalizeConfig({
    host: '192.0.2.1:9999',
    port: 25105,
    username: ' u ',
    password: ' p ',
  });
  assert.equal(config.port, 9999);
  assert.equal(config.username, 'u');
  assert.equal(config.password, ' p ', 'the password as typed');
});

test('devices declared safe', () => {
  const { safe, errors } = parseSafeDevices(
    '1A.2B.3C, 4d5e6f light; AA:BB:CC=switch, 12.34, x.y.z:light',
  );
  assert.deepEqual(
    [...safe],
    [
      ['1a2b3c', 'switch'],
      ['4d5e6f', 'light'],
      ['aabbcc', 'switch'],
    ],
  );
  assert.deepEqual(errors, ['12.34', 'x.y.z:light']);
  assert.equal(parseSafeDevices('__proto__').safe.size, 0);
});

test('defaults and bounds', () => {
  const config = normalizeConfig({});
  assert.equal(config.port, 25105);
  assert.equal(config.interval, 10 * 60_000);
  assert.equal(config.allowButtons, false);
  assert.equal(normalizeConfig({ poll_interval: 0 }).interval, 2 * 60_000);
  assert.equal(normalizeConfig({ poll_interval: '' }).interval, 10 * 60_000);
  assert.equal(normalizeConfig({ allow_output_buttons: 'true' }).allowButtons, false);
  assert.equal(normalizeConfig({ hub_address: 'zz' }).hubAddressInvalid, true);
});

test('/data is repaired: nothing unexpected is kept', () => {
  const memory = normalizeMemory({
    stop: {
      place: 'h:1',
      kind: 'credentials_refused',
      salt: 'a'.repeat(32),
      refused: 'b'.repeat(64),
      password: 'x',
    },
    hub: { place: 'h:1', address: 'AABBCC' },
    place: 'h:1',
    devices: [
      { address: '1a2b3c', cat: 1, subcat: 32, fw: 65 },
      { address: '1a2b3c', cat: 2, subcat: 1 },
      { address: '__proto__', cat: 1, subcat: 1 },
      { address: '2b3c4d', cat: 300, subcat: 1 },
    ],
    addresses: ['1a2b3c', 'nope'],
    retryAt: 'soon',
  });
  assert.deepEqual(Object.keys(memory.stop).sort(), ['at', 'kind', 'place', 'refused', 'salt']);
  assert.equal(memory.hub, null, 'upper case is not what is written');
  assert.deepEqual(memory.devices, [{ address: '1a2b3c', cat: 1, subcat: 32, fw: 65 }]);
  assert.deepEqual(memory.addresses, ['1a2b3c']);
  assert.equal(memory.retryAt, 0);
  assert.notEqual(refusedHash('s', 'u', 'p'), refusedHash('t', 'u', 'p'), 'salted');
});
