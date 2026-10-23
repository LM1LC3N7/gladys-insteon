# gladys-insteon

External integration for [Gladys Assistant](https://gladysassistant.com):
an Insteon network through the **Insteon Hub 2245** on the local network.
Dimmers and switches (lights and switches only when declared safe), motion,
door and leak sensors, Smoke Bridge, I/O Linc (read only), and keypad, remote
and paddle presses as a scene trigger.

Unofficial, not affiliated with Insteon. Never tested with a real device.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Project rules and architecture: [CLAUDE.md](CLAUDE.md); status and
  decisions: [TODO.md](TODO.md); changes: [CHANGELOG.md](CHANGELOG.md).
- The protocol of the hub is ported from
  [pyinsteon](https://github.com/pyinsteon/pyinsteon) (MIT, Tom Harris): see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm run audit
npx github:GladysAssistant/integration-store .
```

Runtime dependency: the Gladys integration SDK only. Licence: Apache-2.0.
