import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ROOT, appDescriptor } from "./helpers.mjs";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

const IDS = ["productLabel","productSelect","productSummary","productWarning","identityCard","identityMac",
  "identityGatewayId","identityBleName","identityMqttTopic","identityC6","identityC6Mac","copyMacButton",
  "copyIdentityButton","readMacButton","portGuide","forgetPortsButton","flashAssistIdentity","flashAssistMac",
  "startSequenceButton","abortSequenceButton","sequenceForm","sequenceBanner","sequenceBannerKicker",
  "sequenceBannerTitle","sequenceBannerText","sequenceBannerList","connectButton","connectionStatus",
  "progressText","lastMessage","resetButton","testList","selectedTest","parameterForm","runButton",
  "cleanupButton","rs485ConnectButton","sendRawButton","rawJsonInput","exportLogButton","clearLogButton","eventLog"];

/**
 * Boots the page for one product and returns its renderer, store and elements.
 *
 * Only one product per process: render.js imports productRegistry.js by a plain
 * specifier, so whichever product resolves first is cached for the rest of the run.
 * The climate page therefore lives in render-climate.test.mjs, which node --test runs
 * in its own process.
 */
async function mount(search) {
  const dom = new JSDOM(readFileSync(`${ROOT}index.html`, "utf8"),
    { url: `http://localhost:8080/ferbos-pcb-testing/${search}` });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.FormData = dom.window.FormData;
  globalThis.location = dom.window.location;

  const { createRenderer, renderSequenceForm } = await import(`${ROOT}js/components/render.js`);
  const { createStore } = await import(`${ROOT}js/core/state.js`);
  const registry = await import(`${ROOT}js/core/productRegistry.js`);

  const elements = Object.fromEntries(IDS.map((id) => [id, dom.window.document.querySelector(`#${id}`)]));
  for (const id of IDS) assert.ok(elements[id], `index.html is missing #${id}`);
  let selected = null;
  const render = createRenderer(elements, { onSelectTest: (id) => { selected = id; } });
  const store = createStore(render);
  renderSequenceForm(elements.sequenceForm, registry.SEQUENCE_INPUTS, {});
  render(store.getState());
  return { elements, store, registry, selected: () => selected };
}

const rows0 = (elements) => [...elements.portGuide.querySelectorAll("li")].map((li) => li.textContent);

test("gateway station: two ports, jig controls present", async () => {
  const { elements, store, registry } = await mount("");
  assert.equal(registry.ACTIVE_PRODUCT.id, "gateway");
  const rows = [...elements.portGuide.querySelectorAll("li")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Port 1 — ESP32-S3 gateway/);
  assert.match(rows[1].textContent, /Port 2 — USB-RS485 jig adapter/);
  assert.equal(elements.rs485ConnectButton.classList.contains("d-none"), false);
  assert.equal(elements.testList.querySelectorAll("li").length, 7);

  store.setPortMemory({ main: "USB 10c4:ea60", jig: null });
  assert.match(rows0(elements)[0], /remembered \(USB 10c4:ea60\)/);
  assert.equal(elements.forgetPortsButton.classList.contains("d-none"), false);
});

test("the banner separates skipped from failed", async () => {
  const { elements, store, registry } = await mount("");
  const TESTS = registry.TESTS;
  for (const t of TESTS) store.updateTest(t.id, { state: "passed" });
  store.updateTest("wifi", { state: "failed", reason: "Timed out after 60s waiting for wifi/got_ip" });
  store.updateTest("rs485", { state: "skipped", reason: "RS485 jig disabled on this station" });
  store.setSequence({ status: "done", currentTestId: null, hint: "", unitId: "PCB-0001" });
  assert.equal(elements.sequenceBanner.dataset.status, "fail");
  assert.match(elements.sequenceBannerKicker.textContent, /Unit PCB-0001/);
  assert.deepEqual([...elements.sequenceBannerList.querySelectorAll("li")].map((li) => li.textContent),
    ["WiFi STA: Timed out after 60s waiting for wifi/got_ip", "RS485 Connector: RS485 jig disabled on this station"]);

  // Only-skipped-optionals still reads PASS.
  store.updateTest("wifi", { state: "passed", reason: "" });
  store.setSequence({ status: "done" });
  assert.equal(elements.sequenceBanner.dataset.status, "pass");
});

test("the identity card derives what goes on the sticker", async () => {
  const { elements, store } = await mount("");
  assert.equal(elements.identityCard.dataset.state, "empty");
  assert.equal(elements.copyMacButton.disabled, true);

  store.setIdentity("s3", { chipName: "ESP32-S3", macAddress: "f4:12:fa:9b:2c:d0" });
  assert.equal(elements.identityCard.dataset.state, "known");
  assert.equal(elements.identityMac.textContent, "F4:12:FA:9B:2C:D0");
  assert.equal(elements.identityGatewayId.textContent, "f412fa9b2cd0");
  assert.equal(elements.identityBleName.textContent, "FERBOS-9B2CD0");
  assert.equal(elements.identityMqttTopic.textContent, "continuum/f412fa9b2cd0/#");

  // A C6-only read cannot fill in the gateway identity.
  store.clearIdentity();
  store.setIdentity("c6", { chipName: "ESP32-C6", macAddress: "40:4C:CA:11:22:33" });
  assert.match(elements.identityMac.textContent, /ESP32-S3/);
  assert.equal(elements.copyMacButton.disabled, true);
  assert.equal(elements.identityC6Mac.textContent, "40:4C:CA:11:22:33");

  // Reset means "next board", but must not drop the open ports.
  store.setConnected(true);
  store.reset();
  assert.deepEqual(store.getState().identity, {});
  assert.equal(store.getState().connected, true);
});

test("the serial monitor is a terminal: oldest first, appended, capped", async () => {
  const { elements, store } = await mount("");
  const lines = () => [...elements.eventLog.querySelectorAll(".log-line")];
  store.clearLog();
  assert.equal(elements.eventLog.classList.contains("is-empty"), true);

  store.addLog({ kind: "tx", title: "TX ping", line: '{"id":"1","cmd":"ping"}' });
  store.addLog({ kind: "ok", title: "S3 Firmware Alive", message: "PASSED" });
  store.addLog({ kind: "error", tag: "!!", title: "Firmware fault", line: "assert failed: ..." });
  assert.deepEqual(lines().map((l) => l.querySelector(".log-tag").textContent), ["TX", "OK", "!!"]);
  assert.equal(lines()[0].querySelector(".log-text").textContent, '{"id":"1","cmd":"ping"}', "raw lines verbatim");
  assert.equal(lines()[1].querySelector(".log-text").textContent, "S3 Firmware Alive: PASSED");
  assert.equal(lines()[2].dataset.fault, "yes", "a panic must not scroll past as ordinary red text");
  for (const line of lines()) assert.match(line.querySelector(".log-time").textContent, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);

  const first = lines()[0];
  store.addLog({ kind: "rx", title: "t", line: "another" });
  assert.equal(lines()[0], first, "nodes are reused, not rebuilt on every render");

  const { LOG_LIMIT } = await import(`${ROOT}js/core/state.js`);
  for (let i = 0; i < LOG_LIMIT + 20; i += 1) store.addLog({ kind: "rx", title: "t", line: `line-${i}` });
  assert.equal(lines().length, LOG_LIMIT, "DOM trimmed with the buffer");
  assert.equal(lines().at(-1).querySelector(".log-text").textContent, `line-${LOG_LIMIT + 19}`, "newest at the bottom");
});

test("the password field can be revealed", async () => {
  const { elements } = await mount("");
  const field = elements.sequenceForm.elements.password;
  const toggle = elements.sequenceForm.querySelector(".password-toggle");
  assert.equal(field.type, "password");
  assert.equal(toggle.type, "button", "must not submit the form");
  toggle.click();
  assert.equal(field.type, "text");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  toggle.click();
  assert.equal(field.type, "password");
  assert.equal(elements.sequenceForm.querySelectorAll(".password-toggle").length, 1, "only the password field");
});

test("the bundled app images are the ones the profiles name", () => {
  const s3 = appDescriptor(`${ROOT}firmware/gateway/tester/s3/ferbos-pcb-testing-eol-main.bin`);
  assert.equal(s3.project, "ferbos-pcb-testing-eol-main");
  assert.equal(appDescriptor(`${ROOT}firmware/gateway/production/s3/ferbos-gateway-main.bin`).project, "ferbos-gateway-main");
  for (const name of ["bootloader.bin", "partition-table.bin", "ota_data_initial.bin"]) {
    assert.equal(appDescriptor(`${ROOT}firmware/gateway/tester/s3/${name}`), null, `${name} is not an app`);
  }
});
