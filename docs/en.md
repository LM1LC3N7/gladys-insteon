# Insteon for Gladys Assistant

This integration connects Gladys to an Insteon network through the **Insteon
Hub 2245**, on your local network. It reads the devices linked to the hub and
what they report, and drives the lights and switches you declare safe.

> Unofficial integration, not affiliated with Insteon.
>
> **Never tested with a real device**: it was written from the pyinsteon
> library (the one of Home Assistant) and tested against a simulated hub only.
> Feedback welcome.

## What you get

| Insteon device                                                            | In Gladys                                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Dimmer (SwitchLinc, LampLinc, KeypadLinc, FanLinc light...) declared safe | a light: on/off and brightness                                                            |
| Switch, plug-in or in-line relay declared safe                            | a switch (or a light)                                                                     |
| Dimmer or switch **not** declared safe                                    | its state (and level), read only, and "Turn on" / "Turn off" buttons, disabled by default |
| Motion sensor                                                             | motion, low battery                                                                       |
| Door sensor, open/close sensor                                            | opening, low battery (door sensors)                                                       |
| Leak sensor                                                               | leak                                                                                      |
| Smoke Bridge                                                              | smoke, carbon monoxide, low battery                                                       |
| I/O Linc                                                                  | the sensor input and the relay, read only                                                 |
| Keypad buttons, remotes, switch paddles                                   | the scene trigger "Insteon button"                                                        |

Not supported yet: thermostats, locks (MorningLinc), the I/O Linc relay
command (garage doors), dual outlets (On/Off Outlet), window coverings, load
controllers, X10, the USB / serial modems (PowerLinc Modem) and the old Hub 2242. They are listed in the status of the integration.

## Setting it up

1. Give the hub a fixed IP address in your router.
2. In Gladys, open the integration and enter:
   - the **address of the hub** (its IP address);
   - the **user name** and **password** printed on the label under the hub
     (not your Insteon account). The password is kept by Gladys in its
     database, never shown again, sent only to the hub, never written in the
     logs. The hub only speaks plain HTTP: anyone who can read your local
     network can read it;
   - optionally the **Insteon address of the hub** (printed on it). Left
     empty, the hub found at the first connection is remembered.
3. Save, then click **Test the connection**.

At the first connection the integration reads the database of the hub (the
devices linked to it), then asks each device what it is. Battery devices
(sensors, remotes) sleep and do not answer: **press their set button once**,
or wait for their next message (motion, door opened...), and they appear.
Then add the devices from the **Discovery** tab.

## Lights and switches: declare them safe

A light or a switch in Gladys obeys Google Home, Alexa, the MCP ("turn
everything off") and every scene. An Insteon switch or dimmer may drive
anything: a lamp, but also a pump, a heater, a freezer, a garage door. So a
dimmer or a switch is a light or a switch **only if you list its address in
"Devices declared safe"**, for example:

```
1A.2B.3C, 4D.5E.6F light
```

A dimmer is always a light; a switch is a switch, or a light when followed by
`light`. The other ones show their state, and two buttons "Turn on" and "Turn
off" that only work once **"Allow the Turn on / Turn off buttons"** is ticked.
When you declare a device safe later, its new features appear in the
Discovery; delete the old ones you no longer want (their history goes with
them).

## Commands

A command leaves within 3.5 seconds or not at all ("nothing was sent"). It is
confirmed only when the device answers the level asked; otherwise Gladys shows
"sent, without confirmation" and the device is read again 2 seconds later.
Every command is written in the integration logs.

## Scene trigger "Insteon button"

Each press of a keypad button, a remote button or a switch paddle (a device
linked to the hub) fires the trigger with:

- `address`: the address of the device, upper case with dots, as on its label
  (`1A.2B.3C`): it is compared as written;
- `button`: the button (Insteon group): 1 for a paddle, 1 to 8 on a keypad;
- `action`: `on`, `off`, `fast_on`, `fast_off` (double press), `dim_start`
  (held), `dim_stop` (released).

120 events per minute at most.

## Readings and limits

- The hub is read twice a second (as pyinsteon does); the devices tell their
  changes as they happen. Every **status reading** interval (10 minutes by
  default) the dimmers, switches and I/O Linc are read again. A restart of
  the integration never reads sooner.
- Messages that arrive in the hub just before a command is sent may be lost
  (the hub buffer is cleared before each message); the next reading catches
  up.
- **Another hub** answering at the same IP address (after a router change):
  nothing is read nor sent until you enter its Insteon address.
- **Password refused**: the integration stops and never tries again by
  itself. Correct the password, or click "Test the connection" once the hub
  accepts it.
- **Hub unreachable**: new tries after 10 s, 30 s, 1, 2, then every 5
  minutes; the pause is kept across a restart.

## Credits

The protocol of the hub and the product database come from
[pyinsteon](https://github.com/pyinsteon/pyinsteon) (MIT, Tom Harris), see
`THIRD_PARTY_NOTICES.md`.
