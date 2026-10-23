# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic and data ported to JavaScript from the project below. The
ported code was rewritten, not copied; the changes are described below.

## pyinsteon

<https://github.com/pyinsteon/pyinsteon> (package `pyinsteon`, version 1.7.0,
commit `2d48b41` of 2026-09-13), by Tom Harris and its contributors, the
library of the Home Assistant Insteon integration.

Its licence file `LICENSE.rst` is the **MIT License** reproduced below. Its
`pyproject.toml` declares `license = {text = "MIT License"}` but also lists
the classifier "License :: OSI Approved :: Apache Software License"; this
notice follows the `LICENSE.rst` file, and the Apache License 2.0 of this
integration applies to the rewritten code.

What was ported:

- the Hub 2245 HTTP protocol (`protocol/http_transport.py`,
  `protocol/http_reader_writer.py`, `protocol/msg_to_url.py`): the buffer
  `/buffstatus.xml` and its position, the clear `/1?XB=M=1`, the messages
  `/3?<hex>=I=3`, the 500 ms reading pace;
- the lengths and fields of the modem messages
  (`protocol/messages/message_definitions.py`), the message flags
  (`data_types/message_flags.py`) and the commands used (`constants.py`);
- the reading of the modem database (`managers/aldb_im_read_manager.py`), the
  ID request, the status request;
- the groups of the sensors and their meaning
  (`device_types/security_health_safety.py`,
  `device_types/open_close_controller_base.py`);
- the rule for repeated broadcasts (`handlers/from_device/broadcast_command.py`);
- the product database (`device_types/ipdb.py`): category, sub-category,
  description, model and device class of each product, generated into
  `src/insteon/product-table.js` by `scripts/generate-product-table.mjs`.

Changes: written in JavaScript for Node.js, without aiohttp nor asyncio; one
HTTP request at a time with bounded answers; the buffer read then cleared
before each message so that an answer is only taken from what came after it;
commands sent only before a deadline and confirmed by the level the device
answers; thermostats, locks, X10, linking and device configuration not
ported.

```
MIT License

Copyright (c) 2019 Tom Harris

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## The publisher of gladys-velbus

`src/publisher.js` comes from <https://github.com/LM1LC3N7/gladys-velbus>
(Apache License 2.0, same author as this integration).
