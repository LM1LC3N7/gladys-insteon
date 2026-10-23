// -----------------------------------------------------------------------------
// What a device is, from the category and sub-category it gives in answer to
// an ID request (or when its set button is pressed): its name, its model and
// the kind this integration shows. Read-only lookups over the generated
// table (a Map: nothing a device sends becomes an object key).
// -----------------------------------------------------------------------------

import { PRODUCTS } from './product-table.js';

const BY_KEY = new Map(PRODUCTS.map((row) => [row[0] * 256 + row[1], row]));

/**
 * pyinsteon class -> kind shown here. The classes not listed (thermostats,
 * locks, load controllers, window coverings, dual outlets, X10, unknown
 * actuators) are recognised but not supported in this version.
 */
const KIND_OF_CLASS = [
  // Two outlets on one address, the second one driven by extended messages.
  [/^SwitchedLightingControl_(OnOffOutlet|I3Outlet)$/, undefined],
  [/^DimmableLightingControl/, 'dimmer'],
  [/^SwitchedLightingControl/, 'relay'],
  [/^SensorsActuators_IOLink$/, 'iolinc'],
  [/^SecurityHealthSafety_MotionSensor$/, 'motion'],
  [/^SecurityHealthSafety_(DoorSensor|OpenCloseSensor)$/, 'opening'],
  [/^SecurityHealthSafety_LeakSensor$/, 'leak'],
  [/^SecurityHealthSafety_Smokebridge$/, 'smoke'],
  [/^GeneralController/, 'remote'],
  [/^(Hub|PLM)$/, 'modem'],
];

/** Category -> what an unknown sub-category of it most likely is. */
const KIND_OF_CATEGORY = new Map([
  [0x00, 'remote'],
  [0x01, 'dimmer'],
  [0x02, 'relay'],
  [0x03, 'modem'],
]);

const CATEGORY_NAMES = new Map([
  [0x00, 'Controller'],
  [0x01, 'Dimmer'],
  [0x02, 'Switch'],
  [0x03, 'Network bridge'],
  [0x04, 'Irrigation'],
  [0x05, 'Thermostat'],
  [0x06, 'Pool and spa'],
  [0x07, 'Sensor / actuator'],
  [0x09, 'Energy management'],
  [0x0e, 'Window covering'],
  [0x0f, 'Access control'],
  [0x10, 'Security sensor'],
]);

/** cat, subcat -> { description, model, kind } (kind undefined: not supported). */
export function productOf(cat, subcat) {
  const row = BY_KEY.get(cat * 256 + subcat);
  if (row) {
    const [, , description, model, deviceClass] = row;
    const rule = KIND_OF_CLASS.find(([pattern]) => pattern.test(deviceClass));
    return { description, model, deviceClass, kind: rule ? rule[1] : undefined };
  }
  const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  return {
    description: `${CATEGORY_NAMES.get(cat) ?? 'Device'} ${hex(cat)}.${hex(subcat)}`,
    model: '',
    deviceClass: '',
    kind: KIND_OF_CATEGORY.get(cat),
  };
}

/**
 * The open/close sensor of pyinsteon is "normally open": ON is closed, OFF
 * open. The door sensors (hidden or not): ON is open.
 */
export const onMeansClosed = (product) =>
  product.deviceClass === 'SecurityHealthSafety_OpenCloseSensor';

/** The kinds shown as Gladys devices. */
export const DEVICE_KINDS = ['dimmer', 'relay', 'iolinc', 'motion', 'opening', 'leak', 'smoke'];

/** Kinds whose all-link broadcasts are button presses (scene triggers). */
export const BUTTON_KINDS = new Set(['dimmer', 'relay', 'remote']);

/** Kinds read with a status request (always powered, they answer). */
export const READ_KINDS = new Set(['dimmer', 'relay', 'iolinc']);
