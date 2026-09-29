import assert from "node:assert/strict";
import test from "node:test";
import { ROOT } from "./helpers.mjs";

const { createSequenceRunner } = await import(`${ROOT}js/core/sequenceRunner.js`);
const { createStore } = await import(`${ROOT}js/core/state.js`);
const { TESTS } = await import(`${ROOT}js/core/productRegistry.js`);
const { explainWifiDisconnect } = await import(`${ROOT}js/core/testRegistry.js`);

const ev = (t, state, detail = "") => ({ test: t, state, detail });

function fakeSerial(script) {
  const serial = new EventTarget();
  serial.isConnected = true;
  serial.sent = [];
  serial.sendCommand = async (cmd, payload) => {
    serial.sent.push(cmd);
    const handler = script[cmd];
    if (!handler) throw new Error(`Timed out waiting for ${cmd} response`);
    const { response, events = [] } = typeof handler === "function" ? handler(payload) : handler;
    for (const [delay, event] of events) {
      setTimeout(() => serial.dispatchEvent(new CustomEvent("rx", { detail: { message: { type: "event", ...event }, line: "" } })), delay);
    }
    return { type: "response", cmd, ...response };
  };
  return serial;
}

const jigCheck = (connected) => ({
  jig: async () => (connected ? { ok: true, detail: "jig connected" }
                              : { ok: false, detail: "RS485 jig serial port is not connected" })
});

const HEALTHY = {
  ping: { response: { ok: true } },
  info: { response: { ok: true, detail: "board=gateway chip_model=9 cores=2 free_heap=1" } },
  c6_ping: { response: { ok: true, detail: "processed_by=c6-zigbee" }, events: [[2, ev("c6", "rx_ok")]] },
  eth_start: { response: { ok: true }, events: [[2, ev("ethernet", "link_up")], [4, ev("ethernet", "got_ip")], [6, ev("ethernet", "link_down")]] },
  eth_stop: { response: { ok: true } },
  wifi_connect: { response: { ok: true }, events: [[2, ev("wifi", "got_ip")]] },
  wifi_stop: { response: { ok: true } },
  rs485_exchange: { response: { ok: true, detail: "tx=EOL_RS485_PING rx=EOL_RS485_PONG" }, events: [[2, ev("rs485", "rx")]] }
};

const states = (store) => Object.fromEntries(Object.entries(store.getState().tests).map(([k, v]) => [k, v.state]));

// Phase timeouts are shrunk so the suite runs in milliseconds; the shipped values are
// asserted separately below.
async function run(script, inputs = { ssid: "AP", password: "", rs485Enabled: true }, tests = TESTS, jig = true) {
  const serial = fakeSerial(script);
  const store = createStore(() => {});
  const logs = [];
  const runner = createSequenceRunner({ serial, store, log: (e) => logs.push(e), hostChecks: jigCheck(jig) });
  const fast = tests.map((t) => ({ ...t, phases: t.phases?.map((p) => ({ ...p, timeoutMs: 80, failGraceMs: p.failGraceMs ? 60 : 0 })) }));
  await runner.run(fast, inputs);
  return { store, logs, serial, runner };
}

test("a healthy board passes every test with no operator clicks", async () => {
  const { store, serial } = await run(HEALTHY);
  assert.ok(Object.values(states(store)).every((s) => s === "passed"), JSON.stringify(states(store)));
  assert.equal(store.getState().sequence.status, "done");
  assert.ok(serial.sent.includes("eth_stop") && serial.sent.includes("wifi_stop"), "follow-ups sent");
});

test("a failure does not stop the run, and the cleanup still goes out", async () => {
  const { store, serial } = await run({
    ...HEALTHY,
    eth_start: { response: { ok: true }, events: [[2, ev("ethernet", "link_up")], [4, ev("ethernet", "got_ip")]] }
  });
  assert.equal(states(store).ethernet, "failed");
  assert.match(store.getState().tests.ethernet.reason, /Timed out .* ethernet\/link_down/);
  assert.deepEqual(store.getState().tests.ethernet.criteria, [true, true, true, false]);
  assert.equal(states(store).wifi, "passed", "the run continues");
  assert.ok(serial.sent.includes("eth_stop"));
});

test("a dead board is reported once, not seven times", async () => {
  const { store, serial } = await run({});
  assert.equal(states(store).ping, "failed");
  assert.equal(serial.sent.filter((c) => c === "ping").length, 3, "1 try + 2 retries");
  assert.equal(store.getState().tests.info.reason, "S3 is not responding");
  assert.deepEqual(Object.values(states(store)).slice(2), Array(5).fill("skipped"));
});

test("an accessory that is not fitted skips rather than fails", async () => {
  const { store } = await run(HEALTHY, { ssid: "AP", password: "", rs485Enabled: false });
  assert.equal(states(store).jig, "skipped");
  assert.equal(states(store).rs485, "skipped");
  assert.equal(store.getState().tests.rs485.reason, "RS485 jig disabled on this station");
});

test("a jig that is enabled but absent fails the check and skips what depends on it", async () => {
  const { store, serial } = await run(HEALTHY, { ssid: "AP", password: "", rs485Enabled: true }, TESTS, false);
  assert.equal(states(store).jig, "failed");
  assert.equal(states(store).rs485, "skipped");
  assert.equal(store.getState().tests.rs485.reason, "RS485 Jig Check did not pass");
  assert.equal(states(store).wifi, "passed", "the board tests still run");
  assert.ok(!serial.sent.includes("rs485_exchange"), "no point sending it without a jig");
});

test("abort stops the run but still returns the board to idle", async () => {
  const serial = fakeSerial({ ...HEALTHY, eth_start: { response: { ok: true } } });
  const store = createStore(() => {});
  const runner = createSequenceRunner({ serial, store, log: () => {}, hostChecks: jigCheck(true) });
  const p = runner.run(TESTS, { rs485Enabled: true });
  setTimeout(() => runner.abort(), 40);
  await p;
  assert.equal(store.getState().tests.ethernet.reason, "Sequence aborted by operator");
  assert.equal(states(store).wifi, "skipped");
  assert.ok(serial.sent.includes("eth_stop"));
  assert.ok(!serial.sent.includes("wifi_connect"));
  assert.equal(store.getState().sequence.status, "aborted");
  assert.equal(runner.isRunning(), false);
});

test("events arriving before the response are not missed", async () => {
  const instant = Object.fromEntries(Object.entries(HEALTHY)
    .map(([k, v]) => [k, { ...v, events: v.events?.map(([, e]) => [0, e]) }]));
  const { store } = await run(instant);
  assert.ok(Object.values(states(store)).every((s) => s === "passed"), JSON.stringify(states(store)));
});

test("operator inputs reach the command payload", async () => {
  let seen;
  await run({ ...HEALTHY, wifi_connect: (payload) => { seen = payload; return HEALTHY.wifi_connect; } },
    { ssid: "Ferbos-Line1", password: "s3cret", rs485Enabled: true });
  assert.deepEqual(seen, { ssid: "Ferbos-Line1", password: "s3cret" });
});

test("a wifi disconnect ends the wait instead of running out the clock", async () => {
  const started = Date.now();
  const { store, logs } = await run({
    ...HEALTHY,
    wifi_connect: { response: { ok: true }, events: [[2, ev("wifi", "connecting")], [8, ev("wifi", "disconnected", "disconnected reason=15")]] }
  });
  assert.equal(states(store).wifi, "failed");
  assert.match(store.getState().tests.wifi.reason, /wrong WiFi password \(4-way handshake timed out\) \(reason=15\)/);
  assert.ok(Date.now() - started < 1000, "failed on the disconnect, not the timeout");
  assert.ok(logs.some((l) => l.title === "Cleanup wifi_stop"), "wifi_stop still sent");
});

test("a retry inside the grace window still passes", async () => {
  const { store } = await run({
    ...HEALTHY,
    wifi_connect: { response: { ok: true }, events: [[2, ev("wifi", "disconnected", "reason=15")], [30, ev("wifi", "got_ip")]] }
  });
  assert.equal(states(store).wifi, "passed");
});

test("a firmware crash is reported as a crash, and no cleanup is sent to a rebooting board", async () => {
  const CRASH = "assert failed: xQueueSemaphoreTake queue.c:1713 (pxQueue->uxItemSize == 0)";
  const serial = fakeSerial({ ...HEALTHY, wifi_connect: { response: { ok: true }, events: [[2, ev("wifi", "connecting")]] } });
  const store = createStore(() => {});
  const runner = createSequenceRunner({ serial, store, log: () => {}, hostChecks: jigCheck(true) });
  const wifi = TESTS.find((t) => t.id === "wifi");
  const p = runner.run([{ ...wifi, phases: wifi.phases.map((x) => ({ ...x, timeoutMs: 400, failGraceMs: 0 })) }],
    { ssid: "AP", password: "", rs485Enabled: true });
  setTimeout(() => runner.reportFault({ type: "crash", detail: CRASH }), 20);
  await p;
  assert.match(store.getState().tests.wifi.reason, /Firmware crashed and rebooted/);
  assert.match(store.getState().tests.wifi.reason, /xQueueSemaphoreTake/);
  assert.ok(!serial.sent.includes("wifi_stop"), "a rebooting board cannot answer cleanup");
});

test("the closing summary names what failed and what was skipped", async () => {
  const { logs } = await run({ ...HEALTHY, wifi_connect: { response: { ok: false, detail: "no ssid" } } },
    { ssid: "AP", password: "", rs485Enabled: false });
  const summary = logs.filter((l) => l.title === "Sequence").pop();
  assert.match(summary.message, /1 FAILED: WiFi STA/);
  assert.match(summary.message, /skipped: RS485 Jig Check, RS485 Connector/);
});

test("shipped wifi timings, which the harness shrinks above", () => {
  const phase = TESTS.find((t) => t.id === "wifi").phases[0];
  assert.equal(phase.waitFor, "got_ip");
  assert.equal(phase.timeoutMs, 60000);
  assert.deepEqual(phase.failOn, ["disconnected"]);
  assert.equal(phase.failGraceMs, 5000, "a real disconnect fails in 5s, not 60s");
});

test("wifi reason codes are translated for the operator", () => {
  assert.match(explainWifiDisconnect("disconnected reason=15"), /wrong WiFi password/);
  assert.match(explainWifiDisconnect("disconnected reason=201"), /SSID not found/);
  assert.equal(explainWifiDisconnect("disconnected reason=99"), "wifi disconnected (reason=99)");
  assert.equal(explainWifiDisconnect(""), "wifi disconnected");
});
