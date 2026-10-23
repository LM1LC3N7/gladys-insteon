// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS } from './constants.js';
import { parseAddress } from './insteon/messages.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  port: DEFAULT_PORT,
  poll_interval: 10,
  allow_output_buttons: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** What a declared relay becomes: a switch (default) or a light. */
export const SAFE_KINDS = ['switch', 'light'];

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const integer = (value, fallback, min, max) => {
  const number = Number(value);
  return value !== null && value !== '' && value !== undefined && Number.isFinite(number)
    ? Math.round(Math.max(min, Math.min(max, number)))
    : fallback;
};

/** `192.168.1.9`, `hub.lan:25105`, `http://192.168.1.9` -> { host, port? }. */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  const scheme = /^([a-z]+):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (scheme && scheme !== 'http') return { host: '' };
  text = text.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  // `user:password@host` is not taken: they have their own fields.
  if (text.includes('@')) return { host: '' };
  const match = /^(\[[0-9a-f:.]+\]|[^:\s]+)(?::(\d{1,5}))?$/i.exec(text);
  if (!match) return { host: '' };
  const port = match[2] ? Number(match[2]) : undefined;
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: port >= 1 && port <= 65535 ? port : undefined,
  };
}

/**
 * Devices declared safe: `1A.2B.3C, 4D.5E.6F:light` -> Map('1a2b3c' -> 'switch' | 'light').
 * A dimmer declared becomes a light whatever the kind; a relay a switch, or a
 * light with `:light`. Wrong entries are reported, not fatal.
 */
export function parseSafeDevices(raw) {
  const safe = new Map();
  const errors = [];
  for (const entry of String(raw ?? '').split(/[,;\n]+/)) {
    const text = entry.trim();
    if (text === '') continue;
    // The kind is a word after `:`, `=` or a space; dots or colons may separate the address bytes.
    const match = /^(.{1,20}?)(?:\s*[:=\s]\s*(switch|light))?$/i.exec(text);
    const address = parseAddress(match?.[1]);
    const kind = (match?.[2] ?? 'switch').toLowerCase();
    if (!address || safe.size >= LIMITS.maxSafe) {
      errors.push(text.slice(0, 40));
      continue;
    }
    safe.set(address, kind);
  }
  return { safe, errors };
}

export function normalizeConfig(raw = {}) {
  const { host, port: hostPort } = parseHost(raw?.host);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  const devices = parseSafeDevices(raw?.safe_devices);
  const typedHub = String(raw?.hub_address ?? '').trim();
  return {
    host,
    // A port typed with the address wins over the port field (which has a default).
    port: hostPort ?? integer(raw?.port, DEFAULTS.port, 1, 65535),
    username: typeof raw?.username === 'string' ? raw.username.trim() : '',
    // As typed.
    password: typeof raw?.password === 'string' ? raw.password : '',
    hubAddress: parseAddress(typedHub),
    hubAddressInvalid: typedHub !== '' && parseAddress(typedHub) === undefined,
    safe: devices.safe,
    safeErrors: devices.errors,
    interval:
      integer(raw?.poll_interval, DEFAULTS.poll_interval, LIMITS.minInterval, LIMITS.maxInterval) *
      60_000,
    allowButtons: bool(raw?.allow_output_buttons, DEFAULTS.allow_output_buttons),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}

/** What the session depends on: a change reconnects. */
export const sessionKey = (config) =>
  JSON.stringify([config.host, config.port, config.username, config.password]);

/** Where the session goes, without the credentials. */
export const placeKey = (config) => `${config.host}:${config.port}`;
