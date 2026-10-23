// -----------------------------------------------------------------------------
// The network model -> Gladys devices and states (pure).
//
// One device per Insteon device, keyed by its Insteon address
// (`ext:<selector>:insteon:1a2b3c`, 6 lower-case hex digits): the address is
// burnt into each device, printed on its label, and every message carries it.
// Features (keys are forever):
// - a dimmer or a relay DECLARED SAFE in the configuration: `binary` (light)
//   and `brightness` for a dimmer; `switch` or `light` for a relay;
// - any other dimmer or relay (the load behind it is unknown: a lamp, but also
//   a pump, a heater, a freezer, a garage door...; "turn everything off" of a
//   voice assistant or a scene reaches every switch and light): `state`
//   (read only), `level` for a dimmer (read only), and the push buttons
//   `turn_on` / `turn_off`, refused unless the configuration allows them;
// - I/O Linc: `input` (the sensor input) and `relay` (read only in this
//   version: it may open a garage door);
// - sensors: `motion`, `opening`, `leak`, `smoke`, `co`, `battery_low`.
// A device published again never loses a feature the user created (Gladys
// would mark it changed, and "Update" would drop its history): the features
// of the created device that are no longer offered are kept.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { FEATURE_NAMES, word } from './i18n.js';
import { addressText } from './insteon/messages.js';
import { DEVICE_KINDS, onMeansClosed } from './insteon/products.js';

const command = (category, type, extra = {}) => ({
  category,
  type,
  read_only: false,
  has_feedback: true,
  keep_history: true,
  ...extra,
});

const reading = (category, type, extra = {}) => ({
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
  ...extra,
});

const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  read_only: false,
  has_feedback: false,
  keep_history: false,
  min: 0,
  max: 1,
});

/** Feature definitions by key (the last part of their external id). */
export const FEATURES = {
  binary: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  brightness: command(C.LIGHT, T.LIGHT.BRIGHTNESS, { min: 0, max: 100 }),
  switch: command(C.SWITCH, T.SWITCH.BINARY, { min: 0, max: 1 }),
  light: command(C.LIGHT, T.LIGHT.BINARY, { min: 0, max: 1 }),
  // A state only: no voice assistant, scene or "turn everything off" can drive it.
  state: reading(C.UNKNOWN, T.SENSOR.BINARY),
  level: reading(C.UNKNOWN, T.SENSOR.UNKNOWN, { max: 100 }),
  turn_on: button(),
  turn_off: button(),
  input: reading(C.UNKNOWN, T.SENSOR.BINARY),
  relay: reading(C.UNKNOWN, T.SENSOR.BINARY),
  motion: reading(C.MOTION_SENSOR, T.SENSOR.BINARY),
  opening: reading(C.OPENING_SENSOR, T.SENSOR.BINARY),
  leak: reading(C.LEAK_SENSOR, T.SENSOR.BINARY),
  smoke: reading(C.SMOKE_SENSOR, T.SENSOR.BINARY),
  co: reading(C.CO_SENSOR, T.SENSOR.BINARY),
  battery_low: reading(C.BATTERY_LOW, T.BATTERY_LOW.BINARY),
};

/** Keys that obey Gladys as a switch or a light: only for a device declared safe. */
export const SAFE_KEYS = new Set(['binary', 'brightness', 'switch', 'light']);

export const ids = (gladys, address) => gladys.externalIds('insteon', address);

/** `ext:sel:insteon:1a2b3c:brightness` -> { address, key }. */
export function parseFeatureId(externalId) {
  const match = /:insteon:([0-9a-f]{6}):([a-z_]+)$/.exec(String(externalId ?? ''));
  return match ? { address: match[1], key: match[2] } : undefined;
}

/** The keys offered for a device now. */
export function featureKeys(config, device) {
  const kind = device.product.kind;
  const declared = config.safe.get(device.address);
  if (kind === 'dimmer') {
    return declared ? ['binary', 'brightness'] : ['state', 'level', 'turn_on', 'turn_off'];
  }
  if (kind === 'relay') return declared ? [declared] : ['state', 'turn_on', 'turn_off'];
  if (kind === 'iolinc') return ['input', 'relay'];
  if (kind === 'motion') return ['motion', 'battery_low'];
  if (kind === 'opening') {
    // The door sensors report their battery (group 3); the open/close sensor does not.
    return onMeansClosed(device.product) ? ['opening'] : ['opening', 'battery_low'];
  }
  if (kind === 'leak') return ['leak'];
  if (kind === 'smoke') return ['smoke', 'co', 'battery_low'];
  return [];
}

/** What a discovered feature declares (a created one also has ids, values, dates). */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'unit',
];

/** Adds to each device the features of its created twin it no longer has. */
export function keepCreatedFeatures(devices, created = []) {
  const byId = new Map((created ?? []).map((device) => [device.external_id, device]));
  return devices.map((device) => {
    const twin = byId.get(device.external_id);
    if (!twin?.features?.length) return device;
    const have = new Set(device.features.map((f) => f.external_id));
    const kept = twin.features
      .filter((f) => f?.external_id && !have.has(f.external_id))
      .map((f) =>
        Object.fromEntries(
          FEATURE_FIELDS.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [
            key,
            f[key],
          ]),
        ),
      );
    return kept.length === 0 ? device : { ...device, features: [...device.features, ...kept] };
  });
}

/** The devices shown, in address order. */
export const shownDevices = (model) =>
  [...model.devices.values()]
    .filter((d) => DEVICE_KINDS.includes(d.product.kind))
    .sort((a, b) => (a.address < b.address ? -1 : 1));

export function buildDevices(gladys, config, model, created = gladys.devices) {
  const devices = [];
  for (const device of shownDevices(model)) {
    const deviceIds = ids(gladys, device.address);
    const text = addressText(device.address);
    devices.push({
      name: `${device.product.description} ${text}`,
      external_id: deviceIds.device,
      model: device.product.model || device.product.description,
      should_poll: false,
      params: [
        { name: 'address', value: text },
        {
          name: 'category',
          value: `${device.cat.toString(16).padStart(2, '0')}.${device.subcat.toString(16).padStart(2, '0')}`,
        },
      ],
      features: featureKeys(config, device).map((key) => ({
        name: word(FEATURE_NAMES[key], config.language),
        external_id: deviceIds.feature(key),
        ...FEATURES[key],
      })),
    });
  }
  return keepCreatedFeatures(devices, created);
}

const flag = (value) => (value ? 1 : 0);

/** Insteon level (0-255) -> Gladys percentage. */
export const percent = (level) => Math.round((level * 100) / 255);

/** Every known state: `[{ device_feature_external_id, state }]`. */
export function buildStates(gladys, config, model, created = gladys.devices) {
  const states = [];
  const createdKeys = new Map(
    (created ?? []).map((device) => [
      device.external_id,
      (device.features ?? []).map((f) => parseFeatureId(f?.external_id)?.key),
    ]),
  );
  for (const device of shownDevices(model)) {
    const deviceIds = ids(gladys, device.address);
    // The keys offered now, and the older ones the user kept (a device declared safe since...).
    const keys = new Set(featureKeys(config, device));
    for (const key of createdKeys.get(deviceIds.device) ?? []) if (key) keys.add(key);
    const push = (key, value) => {
      if (!keys.has(key) || value === undefined || value === null || Number.isNaN(value)) return;
      states.push({ device_feature_external_id: deviceIds.feature(key), state: value });
    };
    const kind = device.product.kind;
    if ((kind === 'dimmer' || kind === 'relay') && device.level !== undefined) {
      const on = flag(device.level > 0);
      for (const key of ['binary', 'switch', 'light', 'state']) push(key, on);
      if (kind === 'dimmer') {
        push('brightness', percent(device.level));
        push('level', percent(device.level));
      }
    }
    if (kind === 'iolinc') {
      if (device.input !== undefined) push('input', flag(device.input));
      if (device.relay !== undefined) push('relay', flag(device.relay));
    }
    if (device.motion !== undefined) push('motion', flag(device.motion));
    // Gladys: 1 = closed, 0 = open.
    if (device.open !== undefined) push('opening', device.open ? 0 : 1);
    if (device.leak !== undefined) push('leak', flag(device.leak));
    if (device.smoke !== undefined) push('smoke', flag(device.smoke));
    if (device.co !== undefined) push('co', flag(device.co));
    if (device.batteryLow !== undefined) push('battery_low', flag(device.batteryLow));
  }
  return states;
}
