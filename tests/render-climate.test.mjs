import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

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

test("climate station: one port, nothing jig-shaped anywhere", async () => {
  // The jig row used to be a module constant, so it appeared on a board with no RS485.
  const { elements, store, registry } = await mount("?product=climate");
  assert.equal(registry.ACTIVE_PRODUCT.id, "climate");
  const rows = rows0(elements);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.ok(!/RS485|jig/i.test(rows[0]), "no jig wording");
  assert.match(rows[0], /ESP32-S3 climate board/);
  assert.match(rows[0], /USB-Serial-JTAG/, "operators must be told to pick the native USB");
  assert.ok(!rows[0].startsWith("Port 1"), "no numbering for a single port");
  assert.equal(elements.rs485ConnectButton.classList.contains("d-none"), true);
  assert.equal(elements.testList.querySelectorAll("li").length, 8);
  assert.equal(elements.progressText.textContent, "0 / 8 passed");
  store.setConnected(true);
  assert.equal(elements.connectionStatus.textContent, "Board connected");
});

