# Ferbos PCB EOL Web Tester

Static website for PCB testing through the Web Serial API.

## How to Run

Run from the repository root:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/ferbos-pcb-testing/
```

Use Chrome or Edge on desktop because the Web Serial API requires
`navigator.serial` support and the page must be opened from `localhost` or HTTPS.

## Structure

- `index.html`: main layout.
- `styles.css`: all UI styling.
- `js/main.js`: UI wiring, command flow, and event routing.
- `js/core/serialClient.js`: Web Serial connect/read/write JSON line.
- `js/core/testRegistry.js`: test point list and pass criteria.
- `js/core/state.js`: small state store for test status and logs.
- `js/components/render.js`: renders the test list, detail view, form, and timeline.
- `firmware/tester`: ESP32-S3 and ESP32-C6 firmware used only for PCB QC tests.
- `firmware/production`: final ESP32-S3 and ESP32-C6 firmware flashed after QC passes.

To add a new test mode, add a new item in `js/core/testRegistry.js`.

## QC Flow

1. Flash PCB Testing Firmware for ESP32-S3 and ESP32-C6.
2. Connect Serial and run the PCB Test Sequence.
3. Flash Production Firmware for ESP32-S3 and ESP32-C6 from the final card.

Production firmware offsets are not the same as tester firmware offsets. Keep
the folder split and update `js/flasher.js` when replacing production binaries
with a different partition layout.
