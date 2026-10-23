# TODO - Insteon v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/fr.md`, `docs/en.md`, `CHANGELOG.md` and this file.
- No forum topic of its own, no forum post from a module session (lot 14,
  thread /t/10385); the main session posts one recap per wave.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 - core** (2026-10-23): own HTTP client of the Hub 2245
      ported from pyinsteon 1.7.0 (buffer, modem messages, database read, ID
      and status requests); product table generated from pyinsteon's
      `ipdb.py`; dimmers and relays (lights / switches when declared safe,
      read-only state and opt-in buttons otherwise), motion, door, open/close
      and leak sensors, Smoke Bridge, I/O Linc read only; button presses as a
      scene trigger; hub identity pinned; "Test the connection"; fr/en.
      Tested against an in-memory hub and a local HTTP server only.
- [ ] **Milestone 2 - real hub**: run against a Hub 2245; capture real buffers
      (anonymised) as fixtures; fix what differs (see below).
- [ ] **Milestone 3 - more**: thermostats (extended get 0x2E, °F/°C, set
      points behind an option, bounded); I/O Linc relay (garage door: opt-in
      buttons, decided on the sensor read just before, "Close" also behind
      the option, guard persisted); dual outlets (On/Off Outlet, i3 Outlet:
      second outlet by extended messages); window coverings (shutter);
      FanLinc fan speed; motion sensor light level; heartbeats of the
      sensors (a sensor silent for too long).
- [ ] **Milestone 4 - first release**: Docker image check, Release workflow,
      topic, GHCR package public.

## To check on a real hub

- That a `/3?…=I=3` request clears the buffer (pyinsteon resets its position
  to 0 after it): the integration clears it itself before each message, so
  either way an answer is only taken from what came after; but messages that
  arrive between the read and the clear are lost.
- POST (pyinsteon) or GET for the messages: POST is used here.
- The hub's "strong NAK" (a run of 0x15 instead of the echo, handled by
  pyinsteon): here the command waits for the device's answer, else "sent,
  without confirmation".
- The answer of an ID request of a KeypadLinc, a FanLinc, an I/O Linc.
- The polarity of the open/close sensor 2843 (pyinsteon: ON = closed) and of
  the door sensors 2845 (ON = open), and of the I/O Linc sensor input (its
  wiring decides: shown as a raw state).
- The time the hub takes to answer an HTTP request (the deadline of a
  command allows 3 requests: read, clear, message).
- The pace of the database read on a large network (one record per message).
- A device that answers a status request with a level the dimmer quantizes
  (the confirmation compares the percentage).

## Decisions

- **Hub 2245 only, over HTTP**: the brief excludes USB and serial; the Hub
  2242 (raw TCP 9761) is rare and not ported.
- **Own client, no dependency**: no maintained Insteon client on npm under a
  usable licence; pyinsteon (MIT, its `LICENSE.rst`; its `pyproject.toml`
  also lists an Apache classifier, both named in the notice) is ported and
  credited in `THIRD_PARTY_NOTICES.md` (copied into the image with
  `LICENSE`). Runtime dependency: the SDK only.
- **Version 0.1.0, set by hand once**: `package.json`, `package-lock.json`,
  the manifest `version` and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-insteon:0.1.0`) set together in milestone 1,
  before any release; the first patch release gives 0.1.1. The manifest test
  checks the semver form and that the four agree, never a fixed value.
- **HTTP**: `node:http`, an agent without keep-alive and one socket (one
  connection per request, as pyinsteon), no `createConnection`; answers
  bounded to 8 KB and each request to 5 s (the whole request); redirections
  not followed. `sent` is false only when the connection was never made.
  The hub only speaks plain HTTP: said in the manifest and the docs.
- **One request at a time**: commands first, then the buffer read when due
  (every 500 ms), then one background request (identity, database, ID,
  status), never two background requests waiting for an answer. Queues
  bounded (30 commands, 600 background requests). Three failed requests in a
  row end the session.
- **Read, clear, send**: before each message the buffer is read (nothing new
  lost) then cleared (`/1?XB=M=1`); a waiter only sees what was read after
  the clear, so an older answer that looks the same never confirms a new
  command.
- **Buffer and messages**: the buffstatus answer must be exactly 202 hex
  digits; the new part is between the previous position and the new one,
  wrapping at 200; the reader is one forward pass with a carry shorter than
  one message (25 bytes); unknown ids are skipped and counted, one warning a
  minute.
- **Identity**: Get IM Info gives the Insteon address of the hub, pinned in
  `/data` (with the place `host:port`) or typed in `hub_address`. Another
  address: the session is stopped, nothing published nor sent, the status
  shows both and says to type the new one. No answer: "unknown", asked again
  a minute later (never taken for another hub). Checked again every 10
  minutes. Direct messages to another address are ignored; a command is
  confirmed only by an ACK addressed to the pinned hub, and its last check
  before the request includes the hub.
- **Devices**: the hub database (0x69 / 0x6A, 2000 records, 400 devices at
  most) gives the addresses; an ID request (0x10) the category and
  sub-category (broadcast "set button pressed"). Battery devices that sleep
  are learnt from that broadcast when their set button is pressed, or asked
  again when they send something (at most every 10 minutes per device). Kept
  in `/data` with the place; another place empties them. The scan runs at
  the first session, and again on "Scan" at most every 10 minutes (its start
  in `/data`, so a reconnection never restarts it).
- **Ids**: `ext:<selector>:insteon:<address>` (6 lower-case hex digits, the
  address printed on the device). Feature keys: `binary`, `brightness`,
  `switch`, `light`, `state`, `level`, `turn_on`, `turn_off`, `input`,
  `relay`, `motion`, `opening`, `leak`, `smoke`, `co`, `battery_low`.
- **Declared safe** (Louis's rule, as gladys-qbus): a dimmer (cat 0x01) or a
  relay (cat 0x02) is `light/binary` + `light/brightness`, or
  `switch/binary` (`light/binary` with `light`), only when its address is in
  `safe_devices`; otherwise `unknown/binary` (`state`), `unknown/unknown`
  0-100 (`level`) and `button/push` `turn_on` / `turn_off`, refused unless
  `allow_output_buttons` (off). A feature created before the list changed is
  kept (never a lost feature) and still gets its state; a command on it is
  refused when not declared safe any more.
- **Not commanded in v1**: the I/O Linc relay (garage door: needs the sensor
  read just before and a toggle guard), locks, thermostats, load controllers
  (water heaters), window coverings. Shown read only, or listed "not
  supported yet".
- **Commands**: one turn per device, which ends when the request is made
  (the confirmation is awaited outside it); the deadline (3.5 s after the
  request) and the gate (declared safe / option, the hub) are checked right
  before the request; confirmed by the device's direct ACK of the same
  command, received before 4.5 s, whose level equals the one asked (off: 0;
  on: above 0; brightness: the same percentage); a NAK: "the device answered
  that it did not apply it"; no answer: "sent, without confirmation", read
  back 2 s later. Values strict (`null`, `''` are not 0; a button takes 1
  only).
- **Ack independent of the publication**: a command resolves on the device's
  answer, never on `publishStates` (test).
- **States**: from the all-link broadcasts and cleanups as they come (a
  dimmer turned on locally is read 1 s later, at most every 10 s per device,
  since its level is its own on-level), and from the status round every
  `poll_interval` minutes (2 to 60, 10 by default) of the dimmers, relays and
  I/O Linc. The start of the round is written in `/data` before it starts:
  restart, Gladys reconnection, test button and configuration saves never
  read sooner.
- **Sensors** (groups from pyinsteon): motion 1 = motion, 3 = low battery;
  door sensor 1 and heartbeat 4: ON = open, 3 = low battery; open/close
  sensor 1: ON = closed (pyinsteon's "normally open"); leak 1 ON = dry, 2 ON
  = wet, heartbeat 4 ON dry / OFF wet; Smoke Bridge 1 smoke, 2 CO, 5 all
  clear, 6 low battery. Gladys opening sensor: 1 = closed.
- **Units**: none (binary states, 0-100 levels without a unit, as the core
  lists none for `light` brightness).
- **Buttons**: the trigger `button` with `address` (upper case with dots, as
  the label), `button` (the group), `action` (`on`, `off`, `fast_on`,
  `fast_off`, `dim_start`, `dim_stop`) and the variable `name` (the model);
  for dimmers, relays, remotes and devices of unknown type, never for
  sensors. Repeats (hops) and cleanups are merged with pyinsteon's rule.
  120 events a minute, refused at the entry beyond. No `undefined` nor
  `NaN` in the data (made `null`).
- **Password refused** (401): final; the stop is persisted in
  `/data/insteon-state.json` with a salted SHA-256 of the refused user name
  and password (never of a pair the hub accepted), erased at the first
  success. Same pair after a restart: no request. New pair: tried at once.
  "Test the connection" tries once and erases the stop only on success.
- **Other failures**: 10 s, 30 s, 1 min, 2 min, then 5 min; the next try and
  the count persisted (at most once a minute unless the pause is a minute or
  more); a restart waits for it. The test button refuses during a pause
  (shows the status).
- **Late answers**: every await of the session code is followed by a check
  of the session number; a late answer of an old session publishes nothing
  and sets no status.
- **Gladys reconnection**: the status, the Discovery, the states and the
  transports are sent again; the hub session, the stop and the pause are
  kept.
- **Not checked**: Docker is not installed on this PC, so no image build and
  no end-to-end test in a container; never run against a real hub. The store
  validator could not be run from the development agent.
