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

## Structure

- `index.html`: main layout.
- `styles.css`: all UI styling.
- `js/main.js`: UI wiring, port handling, flash flow, and event routing.
- `js/core/serialClient.js`: Web Serial connect/read/write JSON line.
- `js/core/testRegistry.js`: operator inputs, test list, phases, and pass criteria.
- `js/core/sequenceRunner.js`: runs the tests back to back without operator clicks.
- `js/core/identity.js`: derives the gateway id, MQTT topic, and BLE name from the MAC.
- `js/core/redact.js`: masks the WiFi password in the monitor and the exported report.
- `js/core/serialLines.js`: classifies non-JSON serial output and detects firmware crashes.
- `js/core/state.js`: small state store for test status, sequence status, and logs.
- `js/components/render.js`: renders the operator banner, test list, detail view, and serial monitor.
- `firmware/tester`: ESP32-S3 and ESP32-C6 firmware used only for PCB QC tests.
- `firmware/production`: final ESP32-S3 and ESP32-C6 firmware flashed after QC passes.

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
- `requiresJig`: skipped when the RS485 jig checkbox is off.
- `hostCheck`: run on the PC instead of sending a command (handler passed to
  the runner from `main.js`), e.g. the jig port check.
- `dependsOn`: skipped unless the listed tests passed earlier in the same run.

Manual per-test controls (connect, run one test, stop mode, raw JSON) are under
**Engineer details** in the Operator panel.

Production firmware offsets are not the same as tester firmware offsets. Keep
the folder split and update `js/flasher.js` when replacing production binaries
with a different partition layout.
