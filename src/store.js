// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), file readable by the container user only (0600):
// - the stop after the hub refused the user name or password, with a salted
//   SHA-256 of the refused pair only (never of a pair the hub accepted; erased
//   at the first success), so a restart never sends a refused password again
//   while a new password is tried at once;
// - the end of the pause after failures (bounded), so a restart never tries
//   sooner;
// - the Insteon address of the hub (its identity), so a hub answering at the
//   same address after a DHCP swap is told apart, even before the first read;
// - the devices found (address, category, sub-category, firmware) and the
//   addresses of the hub database, so a restart needs no new scan;
// - when the last scan and the last status round started (written before
//   they start, at most once a minute), so a restart never reads sooner.
// No password, no secret, no personal data.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { LIMITS } from './constants.js';

export const STATE_FILE = '/data/insteon-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** In-memory store, for the tests. */
export function memoryStore(initial = null) {
  let data = initial;
  return {
    saves: 0,
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(next) {
      this.saves += 1;
      data = JSON.parse(JSON.stringify(next));
    },
    get data() {
      return data;
    },
  };
}

/** A salted hash of a refused user name and password. */
export function refusedHash(salt, username, password) {
  return createHash('sha256').update(`${salt}\u0000${username}\u0000${password}`).digest('hex');
}

export const newSalt = () => randomBytes(16).toString('hex');

const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);
const isPlace = (value) => typeof value === 'string' && value.length > 0 && value.length <= 300;
const time = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
const byte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;

/** The persisted state, repaired; anything unexpected is dropped. */
export function normalizeMemory(raw) {
  const stop = raw?.stop;
  const hub = raw?.hub;
  const place = isPlace(raw?.place) ? raw.place : '';
  const devices = [];
  const seen = new Set();
  for (const device of Array.isArray(raw?.devices) ? raw.devices : []) {
    if (devices.length >= LIMITS.maxDevices) break;
    if (!HEX(6).test(device?.address ?? '') || seen.has(device.address)) continue;
    if (!byte(device.cat) || !byte(device.subcat)) continue;
    seen.add(device.address);
    devices.push({
      address: device.address,
      cat: device.cat,
      subcat: device.subcat,
      fw: byte(device.fw) ? device.fw : 0,
    });
  }
  const addresses = [
    ...new Set(
      (Array.isArray(raw?.addresses) ? raw.addresses : []).filter(
        (a) => typeof a === 'string' && HEX(6).test(a),
      ),
    ),
  ].slice(0, LIMITS.maxDevices);
  return {
    stop:
      isPlace(stop?.place) &&
      stop.kind === 'credentials_refused' &&
      HEX(32).test(stop.salt ?? '') &&
      HEX(64).test(stop.refused ?? '')
        ? {
            place: stop.place,
            kind: stop.kind,
            at: time(stop.at),
            salt: stop.salt,
            refused: stop.refused,
          }
        : null,
    retryAt: time(raw?.retryAt),
    failures: Number.isInteger(raw?.failures) && raw.failures >= 0 ? Math.min(raw.failures, 99) : 0,
    hub:
      isPlace(hub?.place) && HEX(6).test(hub?.address ?? '')
        ? { place: hub.place, address: hub.address }
        : null,
    place,
    devices: place ? devices : [],
    addresses: place ? addresses : [],
    lastScanAt: time(raw?.lastScanAt),
    lastRoundAt: time(raw?.lastRoundAt),
  };
}
