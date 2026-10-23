// The modem messages and the hub buffer, byte for byte (pyinsteon's
// message_definitions.py and http_reader_writer.py).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferText, readBuffer } from '../src/insteon/buffer.js';
import {
  MessageReader,
  TYPE,
  addressText,
  decodeFlags,
  parseAddress,
  sendStandard,
} from '../src/insteon/messages.js';
import { productOf } from '../src/insteon/products.js';

const collect = () => {
  const messages = [];
  let invalid = 0;
  const reader = new MessageReader({
    onMessage: (m, bytes) => messages.push([m, bytes.toString('hex')]),
    onInvalid: () => (invalid += 1),
  });
  return { reader, messages, invalid: () => invalid };
};

test('a standard message, split anywhere, is read once', () => {
  const hex = '02501a2b3caabbcc2b11ff';
  for (let cut = 1; cut < hex.length / 2; cut += 1) {
    const { reader, messages } = collect();
    reader.push(Buffer.from(hex.slice(0, cut * 2), 'hex'));
    reader.push(Buffer.from(hex.slice(cut * 2), 'hex'));
    assert.equal(messages.length, 1, `cut at ${cut}`);
    const [m] = messages[0];
    assert.equal(m.from, '1a2b3c');
    assert.equal(m.to, 'aabbcc');
    assert.equal(m.type, TYPE.DIRECT_ACK);
    assert.equal(m.cmd1, 0x11);
    assert.equal(m.cmd2, 0xff);
  }
});

test('the echo of an extended message is 23 bytes; garbage and unknown ids are skipped', () => {
  const { reader, messages, invalid } = collect();
  const extended = `02621a2b3c1f2e00${'00'.repeat(14)}06`;
  reader.push(Buffer.from(`15ff02ff${extended}02600a0b0c03339b06`, 'hex'));
  assert.deepEqual(
    messages.map(([m, hex]) => [m.id, hex.length / 2]),
    [
      [0x62, 23],
      [0x60, 9],
    ],
  );
  assert.equal(messages[0][0].ack, true);
  assert.equal(messages[1][0].address, '0a0b0c');
  assert.equal(invalid(), 1);
});

test('the carry never holds more than one message', () => {
  const { reader, messages } = collect();
  for (let i = 0; i < 1000; i += 1) {
    reader.push(Buffer.from(i % 2 ? 'ff' : '0251', 'hex'));
    assert.ok(reader.carry.length < 25);
  }
  for (let i = 0; i < 1000; i += 1) reader.push(Buffer.from('ffee15', 'hex'));
  assert.equal(reader.carry.length, 0, 'garbage is never kept');
  assert.ok(messages.length < 100);
});

test('flags, addresses, messages to send', () => {
  assert.deepEqual(decodeFlags(0xcb), {
    type: TYPE.ALL_LINK_BROADCAST,
    extended: false,
    hopsLeft: 2,
    maxHops: 3,
  });
  assert.equal(parseAddress('1A.2B.3C'), '1a2b3c');
  assert.equal(parseAddress('1a:2b:3c'), '1a2b3c');
  assert.equal(parseAddress('00.00.00'), undefined);
  assert.equal(parseAddress('1A.2B'), undefined);
  assert.equal(parseAddress('__proto__'), undefined);
  assert.equal(addressText('1a2b3c'), '1A.2B.3C');
  assert.equal(sendStandard('1a2b3c', 0x11, 0x80).toString('hex'), '02621a2b3c0f1180');
});

test('the buffer: new bytes only, wrapping at 200 digits, a cleared buffer', () => {
  const ring = (data, stop) =>
    bufferText(
      `<response><BS>${data}${stop.toString(16).toUpperCase().padStart(2, '0')}</BS></response>`,
    );
  const data = `0250${'a'.repeat(18)}`.padEnd(200, '0');
  const text = ring(data, 22);
  assert.equal(readBuffer(text, 0).bytes.toString('hex'), `0250${'a'.repeat(18)}`);
  assert.equal(readBuffer(text, 22).bytes, undefined);
  // Wrapped: from 190 to the end, then from 0 to 12.
  const wrapped = `${'1'.repeat(12)}${'0'.repeat(178)}${'2'.repeat(10)}`;
  assert.equal(
    readBuffer(ring(wrapped, 12), 190).bytes.toString('hex'),
    `${'2'.repeat(10)}${'1'.repeat(12)}`,
  );
  assert.equal(readBuffer(ring('0'.repeat(200), 0), 40).cleared, true);
  assert.equal(readBuffer(ring(data, 201), 0).invalid, true);
  assert.equal(bufferText('<response><BS>0102</BS></response>'), undefined);
  assert.equal(bufferText(`<html>${'0'.repeat(202)}</html>`), undefined);
});

test('products: kinds, unknown sub-categories, unsupported ones', () => {
  assert.equal(productOf(0x01, 0x20).kind, 'dimmer');
  assert.equal(productOf(0x02, 0x2a).kind, 'relay');
  assert.equal(productOf(0x07, 0x00).kind, 'iolinc');
  assert.equal(productOf(0x10, 0x01).kind, 'motion');
  assert.equal(productOf(0x05, 0x0b).kind, undefined, 'thermostats: not yet');
  assert.equal(productOf(0x0f, 0x06).kind, undefined, 'locks: not yet');
  assert.equal(productOf(0x02, 0x39).kind, undefined, 'the dual outlet: not yet');
  assert.equal(productOf(0x01, 0xfe).kind, 'dimmer');
  assert.match(productOf(0x01, 0xfe).description, /Dimmer 01\.FE/);
});
