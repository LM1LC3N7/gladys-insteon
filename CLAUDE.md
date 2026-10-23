# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It drives an Insteon network through the Hub 2245 (HTTP, port 25105).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "dimmer"  # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
node scripts/generate-product-table.mjs <pyinsteon>/pyinsteon/device_types/ipdb.py
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   the SDK handlers, shared with the tests
src/app.js                        InsteonApp: lifecycle, identity, scan, rounds, messages, commands
src/insteon/http.js               HTTP to the hub: basic auth, bounded answers, `sent` flag
src/insteon/hub.js                one session: the buffer read every 500 ms, one request at a time,
                                  read + clear before each message, deadlines, waiters
src/insteon/buffer.js             the 200-digit ring buffer of buffstatus.xml
src/insteon/messages.js           modem messages: lengths, flags, linear bounded reader, encoders
src/insteon/product-table.js      GENERATED from pyinsteon's ipdb.py: never edit by hand
src/insteon/products.js           category / sub-category -> description, model, kind (Maps)
src/devices.js                    model -> Gladys devices and states (pure)
src/publisher.js                  states and scene events under the Gladys rate limits
src/store.js                      /data: stop, pause, hub identity, devices, round times
src/config.js                     DEFAULTS (mirror the manifest defaults) + normalization
src/constants.js, src/i18n.js     keys, timings, limits; French and English texts
scripts/generate-product-table.mjs builds the product table (dev only, not in the image)
gladys-assistant-integration.json manifest: name, config_schema, actions, scene trigger...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, the SDK's fake Gladys + test/helpers/fakeHub.js
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Safety rules of this integration (see TODO.md "Decisions"): a dimmer or a
switch is a light or a switch only when declared safe; the others are a
read-only state with "Turn on" / "Turn off" buttons behind an option off by
default, checked when asked and right before the request; nothing that may
open a garage door or a lock is commanded; a command leaves before its
deadline or not at all and is confirmed only by the level the device answers;
a command that may have left is never reported "not sent"; the ack never
waits for the publication; an answer is only taken after the echo of its own message;
the hub identity is pinned and read again at every connection, nothing read
nor sent before; a
refused password stops for good; never a read sooner than the interval
(restart, reconnection, test button); Maps only for what the network or the
configuration names (no prototype pollution).

## Rules

- **External ids are forever.** `gladys.externalIds('insteon', <address>)`,
  the address being 6 lower-case hex digits; feature keys are listed in
  `src/devices.js`. Changing one creates a new device or feature and orphans
  the old one. The same goes for every key users store: manifest
  `config_schema`, `actions`, scene trigger keys and fields.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions -> Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (0.1.0 was set once, before any release). `test/manifest.test.js`
  checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading: the Release workflow moves
  the section.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French), kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (the HTTP tests use a server on
  127.0.0.1).
