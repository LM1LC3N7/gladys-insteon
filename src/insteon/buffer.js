// -----------------------------------------------------------------------------
// The Hub 2245 buffer (`/buffstatus.xml`), after pyinsteon's
// protocol/http_reader_writer.py (MIT, Tom Harris).
//
// The hub answers `<response><BS>…</BS></response>`: 200 hex digits of a ring
// buffer of the modem bytes, then 2 hex digits giving where the hub will
// write next (in hex digits, 0 to 200). What is new is what lies between the
// position of the previous read and this one, wrapping at 200. A buffer of
// zeros has been cleared.
// -----------------------------------------------------------------------------

const SIZE = 200;
const ZEROS = /^0*$/;

/** The 202 hex digits of a buffstatus answer, undefined if it is not one. */
export function bufferText(body) {
  const match = /^\s*<response>\s*<BS>\s*([0-9A-Fa-f]*)\s*<\/BS>\s*<\/response>\s*$/.exec(body);
  if (!match) return undefined;
  const text = match[1];
  return text.length === SIZE + 2 ? text : undefined;
}

/**
 * The bytes added since `last` (a position in hex digits).
 * -> { bytes: Buffer | undefined, next: position to keep, cleared }.
 */
export function readBuffer(text, last) {
  const data = text.slice(0, SIZE);
  const stop = Number.parseInt(text.slice(SIZE), 16);
  if (!Number.isInteger(stop) || stop > SIZE || stop % 2 !== 0) {
    return { bytes: undefined, next: 0, cleared: true, invalid: true };
  }
  if (ZEROS.test(data)) return { bytes: undefined, next: 0, cleared: true };
  let hex = '';
  if (stop > last) {
    hex = data.slice(last, stop);
  } else if (stop < last) {
    let high = data.slice(last, SIZE);
    // A run of zeros there: the buffer was cleared since the last read.
    if (ZEROS.test(high)) high = '';
    hex = `${high}${data.slice(0, stop)}`;
  }
  return { bytes: hex ? Buffer.from(hex, 'hex') : undefined, next: stop, cleared: false };
}
