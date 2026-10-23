// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also keep
// the texts clean (no mojibake, no BOM, no control byte) and honest (never
// tested, unofficial, a secret field is not "encrypted").
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, BUTTON_ACTIONS, DEFAULT_PORT, SCENE_TRIGGERS } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const values = (field) => field.options.map((o) => o.value);
const sources = (dir) =>
  readdirSync(new URL(`../${dir}/`, import.meta.url), { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => `${dir}/${f.replaceAll('\\', '/')}`);
const TEXT_FILES = [
  'gladys-assistant-integration.json',
  'docs/fr.md',
  'docs/en.md',
  'README.md',
  'CHANGELOG.md',
  'TODO.md',
  'CLAUDE.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'index.js',
  ...sources('src'),
  ...sources('test'),
];

test('the store basics; one version everywhere, never a fixed one', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.gladys_version, '>=5.1.0', 'scene triggers need Gladys 5.1');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-insteon:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.version, lock.packages[''].version);
  assert.deepEqual(manifest.transports, ['local']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /not\s+affiliated\s+with\s+Insteon|sans\s+lien\s+avec\s+Insteon/i);
    assert.match(
      docs,
      /never\s+tested\s+with\s+a\s+real\s+device|jamais\s+testée?\s+avec\s+un\s+vrai\s+appareil/i,
      `docs/${lang}.md`,
    );
  }
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real device/);
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai appareil/);
});

test('no double-encoded UTF-8 (mojibake), no BOM, no control byte in the texts', () => {
  // U+00C3 U+00A9 for an e acute, U+00C2 U+00AB for a guillemet, U+00E2 U+20AC
  // for the dash family: UTF-8 read as Windows-1252 and written again. Built
  // from code points so this file never holds one.
  const c = (code) => String.fromCharCode(code);
  const mojibake = new RegExp(
    `[${c(0xc2)}${c(0xc3)}][${c(0x80)}-${c(0xbf)}${c(0x20ac)}${c(0x201a)}-${c(0x2122)}]|${c(0xe2)}${c(0x20ac)}`,
  );
  assert.match(`caf${c(0xc3)}${c(0xa9)}`, mojibake, 'the guard catches a double encoding');
  assert.match(`${c(0xe2)}${c(0x20ac)}${c(0x201d)}`, mojibake, 'and the dash family');
  const control = new RegExp(`[${c(0)}-${c(8)}${c(11)}${c(12)}${c(14)}-${c(31)}${c(127)}]`);
  assert.match(`a${c(27)}b`, control, 'the guard catches a control byte');
  for (const path of TEXT_FILES) {
    const text = read(path);
    assert.doesNotMatch(text, mojibake, path);
    assert.doesNotMatch(text, control, path);
    assert.notEqual(text.charCodeAt(0), 0xfeff, `${path} starts with a BOM`);
  }
});

test('a secret field is never said to be encrypted', () => {
  for (const path of TEXT_FILES.filter((p) => !p.startsWith('test/'))) {
    // "chiffres" (digits) is fine, the past participle (encrypted) is not.
    assert.doesNotMatch(read(path), /chiffré|chiffrement|\bencrypt/i, path);
  }
});

test('the licence names nobody; the reference is credited and shipped', () => {
  const licence = read('LICENSE');
  assert.match(licence, /Apache License/);
  assert.match(licence, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(licence, /Copyright (?:\(c\) )?\d{4}/i);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /pyinsteon[\s\S]*1\.7\.0[\s\S]*Tom Harris/);
  assert.match(notices, /MIT License[\s\S]*Permission is hereby granted/);
  assert.match(read('Dockerfile'), /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.equal(fields.allow_output_buttons.default, false, 'the buttons are opt-in');
  assert.equal(fields.password.type, 'secret', 'the password is never sent back to the browser');
  assert.equal(fields.port.default, DEFAULT_PORT);
  assert.deepEqual(values(fields.language), LANGUAGES);
  for (const key of ['host', 'username', 'password']) assert.equal(fields[key].required, true);
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required ?? section.default ?? section.placeholder, undefined);
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} too long`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
  for (const field of manifest.config_schema.filter((f) => f.placeholder)) {
    assert.equal(typeof field.placeholder, 'object', `${field.key}: multi-language placeholder`);
  }
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  const button = manifest.scene_triggers.find((t) => t.key === SCENE_TRIGGERS.BUTTON);
  const declared = [...button.fields, ...button.variables].map((f) => f.key);
  assert.deepEqual(declared, [
    'address',
    'button',
    'action',
    'address',
    'button',
    'action',
    'name',
  ]);
  for (const key of new Set(declared)) {
    assert.match(app, new RegExp(`\\b${key}[:,\\s}]`), `${key} is never sent`);
  }
  assert.deepEqual(values(button.fields.find((f) => f.key === 'action')), BUTTON_ACTIONS);
});
