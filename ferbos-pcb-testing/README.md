# Ferbos PCB EOL Web Tester

Static website for PCB testing through the Web Serial API.

## How to Run

Run from the repository root:

```bash
python3 serve.py
```

Use `serve.py`, not `python3 -m http.server`. The stock server sends only
`Last-Modified`, with no `Cache-Control` and no `ETag`, so Chrome heuristically
caches the ES module imports under `js/core/` and can serve stale ones even after
the entry module was re-fetched — which surfaces as `x is not a function` after an
edit. `serve.py` sends `no-store` on every response, so a plain reload is enough.

It binds to localhost only; pass `--bind 0.0.0.0` to reach it from another machine,
and `--port` to change the port.

Then open:

```text
http://localhost:8080/ferbos-pcb-testing/
```

Use Chrome or Edge on desktop because the Web Serial API requires
`navigator.serial` support and the page must be opened from `localhost` or HTTPS.

## Boards

One deployment serves every board. The station picks its product from the URL:

```text
http://localhost:8080/ferbos-pcb-testing/                    Gateway (default)
http://localhost:8080/ferbos-pcb-testing/?product=climate    Climate Control
```

Each station bookmarks its own URL, so the board under test is part of the address
rather than a setting someone can leave wrong. An unknown or missing `product`
falls back to the gateway, so existing bookmarks keep working. The board name is
shown in the header, goes into the exported report, and the selector there switches
product by reloading with the new URL.

Remembered ports and operator inputs are namespaced per product, so a gateway
station and a climate station on the same PC do not inherit each other's settings.

| | Gateway | Climate Control |
| --- | --- | --- |
| Tests | jig, ping, info, c6, ethernet, wifi, rs485 | ping, info, c6, ethernet, wifi, gsm |
| UART2 | RS485, tested with a jig adapter | SIM7080G modem, tested as a loopback |
| Firmware bundled | yes | not yet |

### Climate hardware

From the production firmware
(`ferbos-gateway-main/components/climate_control/CMakeLists.txt`):

| Peripheral | Bus | Pins |
| --- | --- | --- |
| SHT20 | I2C0 @100 kHz, addr `0x40` | SDA 16, SCL 15 |
| LD2412 mmWave | UART0 @115200 | RX 4, TX 5 |
| SIM7080G GSM | UART2 @115200 | TX 17, RX 18, RESET 21 |
| S3↔C6 | UART1 | 41/42 (gateway: 42/40) |
| IR LED | — | GPIO 7 |

UART0 carries the mmWave sensor because this board's console runs over
USB-Serial-JTAG. The EOL tester firmware currently uses UART0 as its host link,
so a climate build has to talk to the host over USB-Serial-JTAG instead — on this
board those pins belong to the LD2412.

mmWave and GSM were both on UART2 once and it caused an Interrupt WDT panic in
`Ld2412::rxLoop()`: ESP-IDF keys the UART driver by port number, not by GPIO, so
two `uart_driver_install()` calls on one port fight over a single hardware
instance. Keep them on different ports.

### GSM loopback

A jumper across the GSM header's TX and RX turns the modem connector into a
loopback, so the test needs no modem fitted and no network in range. The firmware
writes a payload on UART2 and must read the same bytes back; an exact echo is the
pass criterion, since anything else means a broken trace, a swapped pair, or the
wrong pins. Stations without the jumper untick the box and the test is skipped
rather than failed.

Firmware contract, mirroring `rs485_exchange` minus the DE/RE pin:

```json
{"id":"8","cmd":"gsm_loopback","payload":"EOL_GSM_LOOPBACK","timeout_ms":1000}
{"type":"event","test":"gsm","state":"rx","detail":"tx=EOL_GSM_LOOPBACK rx=EOL_GSM_LOOPBACK"}
{"type":"response","id":"8","cmd":"gsm_loopback","ok":true,"detail":"tx=EOL_GSM_LOOPBACK rx=EOL_GSM_LOOPBACK"}
```

Hold the modem in reset (GPIO 21, inverting: HIGH asserts) while looping back, so
it cannot inject AT chatter into the echo.

Climate Control is scaffolding at this point. Its tester firmware does not exist —
the EOL tester hardcodes the gateway's S3<->C6 pins (42/40, where climate uses
41/42) — so the flash buttons are disabled and the page says why. SHT20, mmWave and
GSM tests are deliberately absent rather than present and always failing.

### Wrong-board protection

`info` carries a board-identity criterion: if the firmware reports `board=<id>` and
it does not match the product, the test fails and names the mismatch. Firmware that
does not report a board still passes, so this ships safely ahead of the firmware
side. This is the only check that can catch a board flashed with another product's
firmware — no UI can.

### Adding a product

Add a module under `js/core/products/` exporting `{ id, label, summary, boardId,
tests, inputs, firmware }`, and register it in `js/core/productRegistry.js`. Compose
`tests` with `createTests({ boardId, rs485 })` and `inputs` with
`createSequenceInputs({ rs485 })` from `js/core/testRegistry.js`. Put binaries under
`firmware/<product>/<profile>/<target>/`. A product with no firmware yet sets
`firmware: null` and explains itself in `firmwareNote`.

## Structure

- `index.html`: main layout.
- `styles.css`: all UI styling.
- `js/main.js`: UI wiring, port handling, flash flow, and event routing.
- `js/core/serialClient.js`: Web Serial connect/read/write JSON line.
- `js/core/testRegistry.js`: shared test definitions, phases, pass criteria, and the
  factories products compose them with.
- `js/core/productRegistry.js`: the product list and the one resolved from `?product=`.
- `js/core/products/`: one module per board.
- `js/core/sequenceRunner.js`: runs the tests back to back without operator clicks.
- `js/core/identity.js`: derives the gateway id, MQTT topic, and BLE name from the MAC.
- `js/core/redact.js`: masks the WiFi password in the monitor and the exported report.
- `js/core/serialLines.js`: classifies non-JSON serial output and detects firmware crashes.
- `js/core/state.js`: small state store for test status, sequence status, and logs.
- `js/components/render.js`: renders the operator banner, test list, detail view, and serial monitor.
- `firmware/<product>/tester`: ESP32-S3 and ESP32-C6 firmware used only for PCB QC tests.
- `firmware/<product>/production`: final firmware flashed after QC passes.

## QC Flow

1. Flash PCB Testing Firmware for ESP32-S3 and ESP32-C6.
2. Fill in Step 2 once (unit ID, WiFi SSID/password, RS485 jig on/off) and click
   **Start Test Sequence**. Inputs are remembered in the browser.
3. The tests run automatically. Step 1 is a host-side check that the RS485 jig
   port is open; a missing jig fails that step and skips the RS485 connector test
   without stopping the rest. The Operator panel tells the operator when to plug
   and unplug the Ethernet cable; nothing else needs a click.
4. The panel ends with a big **PASS** or **FAIL** plus the reason for every failed
   or skipped test. Use **Export** in the serial monitor to save a JSON report per unit.
5. Flash Production Firmware for ESP32-S3 and ESP32-C6 from the final card.

## Gateway MAC for the sticker

esptool reads the chip base MAC over USB at the start of every flash, so the MAC
appears in the flash dialog and in the green identity card at the top of the page
as soon as Step 1 runs -- before the production firmware has ever booted. It is
read before any write, so even a failed flash still shows it.

Both firmware projects build with four universal MAC addresses, which makes the
base MAC identical to `esp_read_mac(ESP_MAC_WIFI_STA)` on the device. That is the
value `ferbos-gateway-main` uses in `load_mac_address()`, so the card shows exactly
what the running gateway will report:

| Card field | Firmware equivalent | Example |
| --- | --- | --- |
| MAC | `MAC_ADR` | `F4:12:FA:9B:2C:D0` |
| Gateway ID | `MAC_ID` | `f412fa9b2cd0` |
| BLE name | BLE advertised name | `FERBOS-9B2CD0` |
| MQTT | subscribed topic tree | `continuum/f412fa9b2cd0/#` |

### Reading the MAC from an already-flashed gateway

**Read MAC from board** on the identity card recovers the sticker MAC from a unit
that is already running production firmware — for a reprint, or to check a board
against its label. It stops after chip detection: no stub is uploaded, no firmware
is written, the flash is never touched. The board is hard reset afterwards and
boots straight back into its application. The chip type decides which slot the
result lands in, so it works with either the S3 or the C6 on the port.

**Copy MAC** copies just the address; **Copy all** copies all four lines. The
values also go into the exported JSON report, and the export filename falls back
to the gateway id when no unit ID was entered. The ESP32-C6 MAC is shown on a
separate line for reference; the gateway identity is always the S3 MAC. Reset
clears the card, because Reset means "next board".

### Ports

The station uses two serial ports:

1. **ESP32-S3 gateway** — the board under test, 115200 baud.
2. **USB-RS485 jig adapter** — 9600 baud, only when the jig checkbox is on.

The browser picker cannot be labelled by the page, so the Operator panel names
the port it is about to ask for ("Choose the ESP32-S3 GATEWAY port (port 1 of
2)") before each dialog opens, and Step 2 lists both permanently. Each port is
asked for once; afterwards the granted ports are reused automatically, matched
by USB vendor/product id. Two identical adapters are ambiguous, so the picker is
shown again in that case.

A port is only remembered after it proves itself (see below), so picking the
wrong one does not get cached — and a remembered port that later fails the
handshake is dropped, so the picker comes back instead of retrying it forever.

Step 2 shows which ports are currently remembered. **Forget saved ports** clears
both and disconnects, so the next Start asks again — use it when moving the
station to different adapters, or if a port was cached wrongly by an older build.

If no picker appears when you click Start, that is the normal steady state: both
ports are already remembered. Check the Step 2 list to confirm.

### Board reset and boot handshake

Before the first test the tester pulses DTR/RTS to reset the board into its
firmware, keeping GPIO0 high so it never re-enters the bootloader. This matters
because flashing can leave the chip in the ROM bootloader — always after Manual
Boot Flash, and after any Auto Flash whose closing reset did not take — where it
answers nothing and every test times out.

It then waits up to 4s for the firmware's `{"type":"boot"}` banner, so the first
`ping` is not racing startup. If no banner arrives it falls back to a single
`ping` probe. If that also fails the port is rejected with an actionable message
rather than running the whole sequence against a board that cannot answer.

Boards without an auto-reset circuit log a warning and continue; the handshake
still decides whether the port is usable.

Failure policy: a failed test does not stop the sequence; the follow-up command
(`eth_stop`, `wifi_stop`) is still sent and the next test starts. Only when
`ping` fails after retries are the remaining tests skipped, because the S3 is
not responding at all.

## Serial Monitor

A terminal view of everything on the wire, oldest at the top and newest appended
at the bottom:

```text
16:42:03.184 TX  {"id":"1","cmd":"ping"}
16:42:03.210 RX  {"type":"response","id":"1","cmd":"ping","ok":true}
16:42:03.212 OK  S3 Firmware Alive: PASSED
16:43:07.880 ERR WiFi STA: FAILED - Timed out after 60s waiting for wifi/got_ip
```

Timestamps are local time with milliseconds, which is enough resolution to see
firmware turnaround. Raw serial lines are printed verbatim; host-side status
entries show `title: message`. Colours follow the tag: TX cyan, RX white, OK
green, ERR red.

The view follows the newest line, but scrolling up to read history pins it in
place until you scroll back to within 48px of the bottom. Lines are appended
incrementally rather than re-rendered, so a fast serial stream does not rebuild
the whole panel on every frame. The buffer keeps the last `LOG_LIMIT` (250)
lines; **Export** saves the full buffer with the test results.

## Reading a failure

Failures name the cause, not just the timeout. WiFi disconnect reason codes are
decoded, because `reason=15` on its own tells an operator nothing:

```text
WiFi STA: FAILED - WiFi could not connect: wrong WiFi password
                   (4-way handshake timed out) (reason=15)
```

`reason=201` becomes "SSID not found", `reason=202` "authentication failed", and
so on; unknown codes are still reported with their number. The closing summary
names every failed and skipped test, so `2 FAILED` is never a mystery:

```text
Sequence: Finished - 1 FAILED: WiFi STA (skipped: RS485 Jig Check, RS485 Connector)
```

Skipped is not failed. A run whose only non-passes are skips still reads PASS.

The WiFi password is sent to the firmware in clear text, as the protocol requires,
but it is masked everywhere it would be stored or displayed — the monitor's TX line
and the exported report both show `"password":"******** (8 chars)"`. The length is
deliberately kept: an unexpected count, or `(empty)`, is usually the answer when a
board reports `reason=15`.

Firmware `ESP_LOG` output is not JSON, so it arrives as plain text and is tagged
`LOG` in the monitor, coloured by its own level — `E (...)` red, `W (...)` amber,
`I (...)` normal. Only real errors look like errors.

### Firmware crashes

A panic is not a timeout, and reporting it as one hides the actual defect. Panic
output (`assert failed:`, `Guru Meditation Error`, `abort() was called`, a stack
canary or watchdog trip) and reset markers (`Rebooting...`, `ESP-ROM:`, `rst:0x`)
are recognised in the serial stream, tagged `!!` on a dark red row, and end the
running test immediately:

```text
RS485 Connector: FAILED - Firmware crashed and rebooted:
  assert failed: xQueueSemaphoreTake queue.c:1713 (pxQueue->uxItemSize == 0)
```

An unexpected `{"type":"boot"}` mid-test counts too, which catches resets that
print no panic dump at all, such as a watchdog or brownout. No follow-up command
is sent to a board that has just rebooted — it cannot answer, and asking only adds
another timeout. The sequence then carries on with the next test as usual.

## Adding or changing a test

Edit `js/core/testRegistry.js`. Each test declares:

- `command` and `parameters`: the JSON sent to S3. Parameter values are
  overridden by `SEQUENCE_INPUTS` entries of the same name (e.g. `ssid`).
- `phases`: async events to wait for after the response, each with a `hint`
  shown to the operator and a `timeoutMs`. `failOn` lists states that end the
  wait early (a board reporting `wifi/disconnected` will not then produce
  `got_ip`), `failGraceMs` keeps a window open in case the firmware retries, and
  `describeFailure` turns the event into the message the operator reads.
- `followUpCommand`: always sent after the test to return the board to idle.
- `criteria`: `{ label, check }` pairs; all must be met to pass.
- `gate`: skip the remaining tests when this one fails.
- `requiresInput`: skipped when that operator input is off — an accessory this
  station does not have fitted. Pair with `optional` (skipping it still allows an
  overall PASS) and `skipNote` (what the report says).
- `hostCheck`: run on the PC instead of sending a command (handler passed to
  the runner from `main.js`), e.g. the jig port check.
- `dependsOn`: skipped unless the listed tests passed earlier in the same run.

Manual per-test controls (connect, run one test, stop mode, raw JSON) are under
**Engineer details** in the Operator panel.

Production firmware offsets are not the same as tester firmware offsets. Keep
the folder split and update `js/flasher.js` when replacing production binaries
with a different partition layout.
