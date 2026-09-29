import assert from "node:assert/strict";
import test from "node:test";
import { ROOT } from "./helpers.mjs";

const { SerialClient } = await import(`${ROOT}js/core/serialClient.js`);
const { redactLine, redactPayload, maskSecret } = await import(`${ROOT}js/core/redact.js`);
const { classifyPlainLine, detectFirmwareFault } = await import(`${ROOT}js/core/serialLines.js`);

test("reset drives EN low then high while GPIO0 stays high", async () => {
  // Same sequence esptool uses for a hard reset. GPIO0 must never be pulled low or
  // the chip comes back in the bootloader instead of the application.
  const signals = [];
  const serial = new SerialClient();
  serial.port = { setSignals: async (s) => { signals.push({ ...s }); } };
  await serial.resetIntoApplication({ pulseMs: 30, settleMs: 20 });
  assert.deepEqual(signals, [
    { dataTerminalReady: false, requestToSend: true },
    { dataTerminalReady: false, requestToSend: false }
  ]);
  assert.ok(signals.every((s) => s.dataTerminalReady === false), "never the bootloader");
});

test("reset surfaces a board with no reset circuit", async () => {
  const serial = new SerialClient();
  await assert.rejects(() => serial.resetIntoApplication(), /not connected/);
  serial.port = { setSignals: async () => { throw new Error("Failed to set control signals"); } };
  await assert.rejects(() => serial.resetIntoApplication(), /control signals/);
});

test("waitForMessage resolves on the first match and never rejects", async () => {
  const serial = new SerialClient();
  const rx = (message) => serial.dispatchEvent(new CustomEvent("rx", { detail: { message, line: "" } }));
  const pending = serial.waitForMessage((m) => m.type === "boot", 1000);
  rx({ type: "event", test: "wifi", state: "connecting" });
  rx({ type: "boot", target: "s3-main", ready: true });
  assert.equal((await pending).target, "s3-main");

  const before = Date.now();
  assert.equal(await serial.waitForMessage((m) => m.type === "boot", 60), null, "timeout yields null");
  assert.ok(Date.now() - before >= 55);
});

test("a boot banner arriving during the reset settle is still caught", async () => {
  // prepareBoard attaches the listener before pulsing reset for exactly this reason.
  const serial = new SerialClient();
  serial.port = {
    setSignals: async (s) => {
      if (s.requestToSend === false) {
        setTimeout(() => serial.dispatchEvent(new CustomEvent("rx", { detail: { message: { type: "boot", ready: true }, line: "" } })), 5);
      }
    }
  };
  const boot = serial.waitForMessage((m) => m.type === "boot", 1000);
  await serial.resetIntoApplication({ pulseMs: 10, settleMs: 80 });
  assert.ok(await boot);
});

test("the WiFi password is masked everywhere it is stored or shown", () => {
  assert.equal(redactLine('{"cmd":"wifi_connect","ssid":"AP","password":"s3cr3t12"}'),
               '{"cmd":"wifi_connect","ssid":"AP","password":"******** (8 chars)"}');
  assert.ok(!redactLine('{"password":"hunter2"}').includes("hunter2"));

  // The length is kept deliberately: an unexpected count, or (empty), is usually the
  // answer when a board reports reason=15.
  assert.equal(redactLine('{"password":""}'), '{"password":"(empty)"}');
  assert.equal(maskSecret(undefined), "(empty)");
  assert.equal(redactLine('{"password":"has\\"quote"}'), '{"password":"********* (9 chars)"}', "escapes count once");
  assert.match(redactLine('{"password":"secret "}'), /\(7 chars\)/, "a pasted trailing space shows up");
  assert.equal(redactLine('{"id":"1","cmd":"ping"}'), '{"id":"1","cmd":"ping"}');
  assert.equal(redactLine(null), "");
  assert.equal(redactLine(`{"password":"${"x".repeat(100)}"}`), '{"password":"************************ (100 chars)"}');
  assert.deepEqual(redactPayload({ ssid: "AP", password: "abc" }), { ssid: "AP", password: "*** (3 chars)" });
  assert.deepEqual(redactPayload({ payload: "EOL_RS485_PING", timeout_ms: 1000 }), { payload: "EOL_RS485_PING", timeout_ms: 1000 });
});

test("panics are recognised; healthy boot chatter is not", () => {
  const CRASH = "assert failed: xQueueSemaphoreTake queue.c:1713 (pxQueue->uxItemSize == 0)";
  assert.deepEqual(detectFirmwareFault(CRASH), { type: "crash", detail: CRASH });
  assert.deepEqual(classifyPlainLine(CRASH), { kind: "error", tag: "!!", title: "Firmware fault" });
  for (const line of ["Guru Meditation Error: Core 0 panic'ed (LoadProhibited)",
                      "abort() was called at PC 0x40081b2d on core 0",
                      "Stack canary watchpoint triggered (main_task)",
                      "Task watchdog got triggered."]) {
    assert.equal(detectFirmwareFault(line).type, "crash", line);
  }
  for (const line of ["Rebooting...", "ESP-ROM:esp32s3-20210327", "rst:0xc (RTC_SW_CPU_RST),boot:0xc"]) {
    assert.equal(detectFirmwareFault(line).type, "reboot", line);
  }
  // A register dump and the ROM loader's own chatter are normal parts of a boot.
  for (const line of ["I (26) boot: ESP-IDF v5.5.4 2nd stage bootloader",
                      "Backtrace: 0x40375e81:0x3fcb8cc0 0x403824f9:0x3fcb8ce0",
                      "load:0x3fce2810,len:0x1564", "entry 0x403c8928", "SPIWP:0xee", "", null]) {
    assert.equal(detectFirmwareFault(line), null, JSON.stringify(line));
  }
});

test("ESP_LOG lines keep their own severity", () => {
  // Marking all non-JSON output as an error made a healthy board look broken.
  assert.deepEqual(classifyPlainLine("I (26) boot: hello"), { kind: "rx", tag: "LOG", title: "Firmware log" });
  assert.deepEqual(classifyPlainLine("W (417) spi_flash: big"), { kind: "warn", tag: "LOG", title: "Firmware log" });
  assert.deepEqual(classifyPlainLine("E (12) uart: broken"), { kind: "error", tag: "LOG", title: "Firmware log" });
  assert.deepEqual(classifyPlainLine("load:0x3fce2810"), { kind: "rx", tag: "RAW", title: "Serial" });
});
