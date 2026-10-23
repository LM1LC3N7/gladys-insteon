# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Insteon Hub 2245 over HTTP on the local network (protocol ported from
  pyinsteon 1.7.0): the devices of the hub database, typed by an ID request
  or by their set button, kept in `/data`.
- Dimmers and switches: a light or a switch only when declared safe in the
  configuration; otherwise a read-only state and "Turn on" / "Turn off"
  buttons, disabled by default.
- Motion, door, open/close and leak sensors, Smoke Bridge, I/O Linc (read
  only), low battery.
- The scene trigger "Insteon button": keypad, remote and paddle presses.
- Commands sent within 3.5 s or not at all, confirmed by the level the device
  answers, else "sent, without confirmation" and a read back.
- The Insteon address of the hub pinned: another hub at the same IP address
  stops everything until its address is entered.
- A refused password stops for good (no automatic retry); other failures are
  retried at 10 s, 30 s, 1, 2, then 5 minutes, the pause kept across a
  restart. "Test the connection".

### Security

- The identity of the hub is read again at every connection; nothing is read
  nor sent before (a command at the start of a session could leave through
  another hub).
- An answer counts only after the echo of its own message: an old ACK left in
  a buffer the hub did not clear never confirms a new command, and the ACK of
  a command is never taken by the next one.
- A device's type never changes on a message (a forged broadcast could make
  an I/O Linc look like a switch).

### Fixed

- Brightness 100 % is confirmed only by 100 %.
- A command waiting behind a hanging request is refused at its deadline.
- Outages no longer add background loops (extra identity reads).
- Docs: battery sensors and the Smoke Bridge are never read again; the
  variable `name` and group 0 of the trigger.
