// -----------------------------------------------------------------------------
// Insteon modem (IM) messages, ported from pyinsteon (MIT, Tom Harris):
// protocol/messages/message_definitions.py (lengths), data_types/
// message_flags.py (flags), constants.py (commands).
//
// The hub hands over the bytes the modem produced; every message starts with
// 0x02 and its id, the id gives the length (the "send" echo 0x62 is longer
// when the extended bit of its flags is set). The reader is one forward pass
// with a carry of 24 bytes at most: an unknown id or a lone byte is skipped,
// the reader restarts at the next 0x02.
// -----------------------------------------------------------------------------

export const START = 0x02;
export const ACK = 0x06;
export const NAK = 0x15;

export const IM = {
  STANDARD_RECEIVED: 0x50,
  EXTENDED_RECEIVED: 0x51,
  ALL_LINK_RECORD: 0x57,
  GET_IM_INFO: 0x60,
  SEND: 0x62,
  GET_FIRST_ALL_LINK_RECORD: 0x69,
  GET_NEXT_ALL_LINK_RECORD: 0x6a,
};

/** Insteon commands (cmd1) used here. */
export const CMD = {
  ASSIGN_TO_GROUP: 0x01,
  DELETE_FROM_GROUP: 0x02,
  ID_REQUEST: 0x10,
  ON: 0x11,
  ON_FAST: 0x12,
  OFF: 0x13,
  OFF_FAST: 0x14,
  START_MANUAL_CHANGE: 0x17,
  STOP_MANUAL_CHANGE: 0x18,
  STATUS_REQUEST: 0x19,
};

/** Message types (the three high bits of the flags). */
export const TYPE = {
  DIRECT: 0,
  DIRECT_ACK: 1,
  ALL_LINK_CLEANUP: 2,
  ALL_LINK_CLEANUP_ACK: 3,
  BROADCAST: 4,
  DIRECT_NAK: 5,
  ALL_LINK_BROADCAST: 6,
  ALL_LINK_CLEANUP_NAK: 7,
};

/** Total length (0x02 and id included) of each message the modem sends. */
const LENGTHS = new Map([
  [0x50, 11],
  [0x51, 25],
  [0x52, 4],
  [0x53, 10],
  [0x54, 3],
  [0x55, 2],
  [0x56, 7],
  [0x57, 10],
  [0x58, 3],
  [0x59, 12],
  [0x60, 9],
  [0x61, 6],
  [0x62, 9],
  [0x63, 5],
  [0x64, 5],
  [0x65, 3],
  [0x66, 6],
  [0x67, 3],
  [0x68, 4],
  [0x69, 3],
  [0x6a, 3],
  [0x6b, 4],
  [0x6c, 3],
  [0x6d, 3],
  [0x6e, 3],
  [0x6f, 12],
  [0x70, 4],
  [0x71, 5],
  [0x72, 3],
  [0x73, 6],
  [0x75, 5],
  [0x76, 13],
]);

const MAX_LENGTH = 25;

/** 3 bytes -> '1a2b3c' (the id of a device here: lower case, no dots). */
export const addressOf = (bytes, offset) =>
  Buffer.from(bytes.subarray(offset, offset + 3)).toString('hex');

/** '1a2b3c' -> '1A.2B.3C', as the Insteon app and the device label show it. */
export const addressText = (address) => address.toUpperCase().match(/../g).join('.');

/** '1A.2B.3C', '1a2b3c', '1A:2B:3C' -> '1a2b3c', undefined if not an address. */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/[.:\s-]/g, '')
    .toLowerCase();
  return /^[0-9a-f]{6}$/.test(text) && text !== '000000' ? text : undefined;
}

export function decodeFlags(flags) {
  return {
    type: flags >> 5,
    extended: (flags & 0x10) !== 0,
    hopsLeft: (flags >> 2) & 0x03,
    maxHops: flags & 0x03,
  };
}

/** One message of the modem -> a plain object (undefined for those not used here). */
export function decodeMessage(bytes) {
  const id = bytes[1];
  if (id === IM.STANDARD_RECEIVED || id === IM.EXTENDED_RECEIVED) {
    return {
      id,
      from: addressOf(bytes, 2),
      to: addressOf(bytes, 5),
      // The low byte of the "to" address: the group of an all-link broadcast.
      toLow: bytes[7],
      toBytes: [bytes[5], bytes[6], bytes[7]],
      ...decodeFlags(bytes[8]),
      cmd1: bytes[9],
      cmd2: bytes[10],
    };
  }
  if (id === IM.SEND) {
    const extended = (bytes[5] & 0x10) !== 0;
    return {
      id,
      to: addressOf(bytes, 2),
      flags: bytes[5],
      cmd1: bytes[6],
      cmd2: bytes[7],
      extended,
      ack: bytes[extended ? 22 : 8] === ACK,
    };
  }
  if (id === IM.GET_IM_INFO) {
    return {
      id,
      address: addressOf(bytes, 2),
      cat: bytes[5],
      subcat: bytes[6],
      ack: bytes[8] === ACK,
    };
  }
  if (id === IM.ALL_LINK_RECORD) {
    return {
      id,
      inUse: (bytes[2] & 0x80) !== 0,
      controller: (bytes[2] & 0x40) !== 0,
      group: bytes[3],
      address: addressOf(bytes, 4),
      data: [bytes[7], bytes[8], bytes[9]],
    };
  }
  if (id === IM.GET_FIRST_ALL_LINK_RECORD || id === IM.GET_NEXT_ALL_LINK_RECORD) {
    return { id, ack: bytes[2] === ACK };
  }
  return { id };
}

/** Linear reader of the modem bytes; `onMessage` gets each whole message. */
export class MessageReader {
  constructor({ onMessage, onInvalid = () => {} }) {
    this.onMessage = onMessage;
    this.onInvalid = onInvalid;
    this.carry = Buffer.alloc(0);
  }

  reset() {
    this.carry = Buffer.alloc(0);
  }

  push(chunk) {
    // The carry is shorter than one message: this copy stays bounded.
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk;
    let i = 0;
    while (i < data.length) {
      if (data[i] !== START) {
        // A lone byte (a NAK of the modem, garbage): skipped.
        i += 1;
        continue;
      }
      if (i + 1 >= data.length) break;
      let length = LENGTHS.get(data[i + 1]);
      if (length === undefined) {
        this.onInvalid();
        i += 1;
        continue;
      }
      if (data[i + 1] === IM.SEND) {
        if (i + 5 >= data.length) break;
        if (data[i + 5] & 0x10) length = 23;
      }
      if (i + length > data.length) break;
      const message = data.subarray(i, i + length);
      i += length;
      this.onMessage(decodeMessage(message), message);
    }
    const rest = data.subarray(i);
    // Never more than one message waits for its end.
    this.carry = rest.length < MAX_LENGTH ? Buffer.from(rest) : Buffer.alloc(0);
  }
}

/** A standard direct message to a device (flags 0x0F: 3 hops). */
export function sendStandard(address, cmd1, cmd2) {
  return Buffer.from([
    START,
    IM.SEND,
    ...Buffer.from(address, 'hex'),
    0x0f,
    cmd1 & 0xff,
    cmd2 & 0xff,
  ]);
}

export const getImInfo = () => Buffer.from([START, IM.GET_IM_INFO]);
export const getFirstRecord = () => Buffer.from([START, IM.GET_FIRST_ALL_LINK_RECORD]);
export const getNextRecord = () => Buffer.from([START, IM.GET_NEXT_ALL_LINK_RECORD]);
