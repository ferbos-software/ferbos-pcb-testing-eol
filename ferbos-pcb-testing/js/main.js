import { createRenderer, renderSequenceForm } from "./components/render.js";
import { SerialClient } from "./core/serialClient.js";
import { deriveIdentity } from "./core/identity.js";
import { redactLine, redactPayload } from "./core/redact.js";
import { classifyPlainLine, detectFirmwareFault } from "./core/serialLines.js";
import { createSequenceRunner } from "./core/sequenceRunner.js";
import { createStore } from "./core/state.js";
import { ACTIVE_PRODUCT, PRODUCTS, SEQUENCE_INPUTS, TESTS, getTestById } from "./core/productRegistry.js";
import { buildPayload, evaluateCriteria } from "./core/testRegistry.js";
import { flashFirmware, getFirmwareLabel, getFirmwareProfile, readDeviceMac } from "./flasher.js";

const elements = {
  productLabel: document.querySelector("#productLabel"),
  productSelect: document.querySelector("#productSelect"),
  productSummary: document.querySelector("#productSummary"),
  productWarning: document.querySelector("#productWarning"),
  identityCard: document.querySelector("#identityCard"),
  identityMac: document.querySelector("#identityMac"),
  identityGatewayId: document.querySelector("#identityGatewayId"),
  identityBleName: document.querySelector("#identityBleName"),
  identityMqttTopic: document.querySelector("#identityMqttTopic"),
  identityC6: document.querySelector("#identityC6"),
  identityC6Mac: document.querySelector("#identityC6Mac"),
  copyMacButton: document.querySelector("#copyMacButton"),
  copyIdentityButton: document.querySelector("#copyIdentityButton"),
  portGuide: document.querySelector("#portGuide"),
  forgetPortsButton: document.querySelector("#forgetPortsButton"),
  readMacButton: document.querySelector("#readMacButton"),
  flashAssistIdentity: document.querySelector("#flashAssistIdentity"),
  flashAssistMac: document.querySelector("#flashAssistMac"),
  startSequenceButton: document.querySelector("#startSequenceButton"),
  abortSequenceButton: document.querySelector("#abortSequenceButton"),
  sequenceForm: document.querySelector("#sequenceForm"),
  sequenceBanner: document.querySelector("#sequenceBanner"),
  sequenceBannerKicker: document.querySelector("#sequenceBannerKicker"),
  sequenceBannerTitle: document.querySelector("#sequenceBannerTitle"),
  sequenceBannerText: document.querySelector("#sequenceBannerText"),
  sequenceBannerList: document.querySelector("#sequenceBannerList"),
  connectButton: document.querySelector("#connectButton"),
  flashTesterS3Button: document.querySelector("#flashTesterS3Button"),
  flashTesterC6Button: document.querySelector("#flashTesterC6Button"),
  flashProductionS3Button: document.querySelector("#flashProductionS3Button"),
  flashProductionC6Button: document.querySelector("#flashProductionC6Button"),
  flashProgress: document.querySelector("#flashProgress"),
  flashPercentage: document.querySelector("#flashPercentage"),
  flashProgressBar: document.querySelector("#flashProgressBar"),
  flashAssistModal: document.querySelector("#flashAssistModal"),
  flashAssistTitle: document.querySelector("#flashAssistTitle"),
  flashStatusText: document.querySelector("#flashStatusText"),
  flashAssistIcon: document.querySelector("#flashAssistIcon"),
  flashAssistStatus: document.querySelector("#flashAssistStatus"),
  flashAssistMessage: document.querySelector("#flashAssistMessage"),
  flashAssistSteps: document.querySelector("#flashAssistSteps"),
  flashAssistRetryButton: document.querySelector("#flashAssistRetryButton"),
  flashAssistManualButton: document.querySelector("#flashAssistManualButton"),
  flashAssistCloseButton: document.querySelector("#flashAssistCloseButton"),
  connectionStatus: document.querySelector("#connectionStatus"),
  progressText: document.querySelector("#progressText"),
  lastMessage: document.querySelector("#lastMessage"),
  resetButton: document.querySelector("#resetButton"),
  testList: document.querySelector("#testList"),
  selectedTest: document.querySelector("#selectedTest"),
  parameterForm: document.querySelector("#parameterForm"),
  runButton: document.querySelector("#runButton"),
  cleanupButton: document.querySelector("#cleanupButton"),
  rs485ConnectButton: document.querySelector("#rs485ConnectButton"),
  sendRawButton: document.querySelector("#sendRawButton"),
  rawJsonInput: document.querySelector("#rawJsonInput"),
  exportLogButton: document.querySelector("#exportLogButton"),
  clearLogButton: document.querySelector("#clearLogButton"),
  eventLog: document.querySelector("#eventLog")
};

const MAIN_BAUD = 115200;
const BOOT_TIMEOUT_MS = 4000;
const PORT_PROBE_TIMEOUT_MS = 2500;
const JIG_BAUD = 9600;
// Namespaced per product: a gateway station and a climate station on the same PC
// must not inherit each other's ports or SSID.
const STORAGE_KEYS = {
  inputs: `ferbos.eol.${ACTIVE_PRODUCT.id}.sequenceInputs`,
  mainPort: `ferbos.eol.${ACTIVE_PRODUCT.id}.port.main`,
  jigPort: `ferbos.eol.${ACTIVE_PRODUCT.id}.port.jig`
};

const serial = new SerialClient();
const rs485Serial = new SerialClient();
const render = createRenderer(elements, {
  onSelectTest: (testId) => store.selectTest(testId)
});
const store = createStore(render);
const runner = createSequenceRunner({
  serial,
  store,
  log: (entry) => store.addLog(entry),
  hostChecks: {
    jig: async () => (rs485Serial.isConnected
      ? { ok: true, detail: `RS485 jig connected (${describePort(rs485Serial.port)}, ${JIG_BAUD} baud)` }
      : { ok: false, detail: "RS485 jig serial port is not connected" })
  }
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flashAssistModal = new bootstrap.Modal(elements.flashAssistModal);
let flashSession = null;
const flashActionButtons = [
  elements.flashTesterS3Button,
  elements.flashTesterC6Button,
  elements.flashProductionS3Button,
  elements.flashProductionC6Button
];

const FLASH_PROFILE_LABELS = {
  tester: getFirmwareLabel("tester"),
  production: getFirmwareLabel("production")
};

// Derived from the profiles themselves, so it can never drift from what is written.
function flashFileCount(profile, target) {
  return getFirmwareProfile(profile)?.targets?.[target]?.files?.length ?? 1;
}

renderProductBar();
renderSequenceForm(elements.sequenceForm, SEQUENCE_INPUTS, loadJson(STORAGE_KEYS.inputs) ?? {});
refreshPortMemory();
wireUi();
wireSerial();
wireRs485();
render(store.getState());

// One product per page, chosen by ?product= so each station can bookmark its own.
// Switching reloads rather than re-rendering: the test list, firmware profiles and
// stored ports all belong to the product, and a reload is the honest way to swap them.
function renderProductBar() {
  elements.productLabel.textContent = ACTIVE_PRODUCT.label;
  elements.productSummary.textContent = ACTIVE_PRODUCT.summary ?? "";

  elements.productSelect.replaceChildren(
    ...PRODUCTS.map((product) => {
      const option = document.createElement("option");
      option.value = product.id;
      option.textContent = product.label;
      option.selected = product.id === ACTIVE_PRODUCT.id;
      return option;
    })
  );
  elements.productSelect.addEventListener("change", (event) => {
    const url = new URL(location.href);
    url.searchParams.set("product", event.target.value);
    location.assign(url);
  });

  const unavailable = !ACTIVE_PRODUCT.firmware;
  elements.productWarning.classList.toggle("d-none", !unavailable);
  if (unavailable) {
    elements.productWarning.textContent = ACTIVE_PRODUCT.firmwareNote
      ?? `No firmware is bundled for ${ACTIVE_PRODUCT.label} yet.`;
  }
  for (const button of flashActionButtons) {
    button.disabled = unavailable;
    if (unavailable) {
      button.title = ACTIVE_PRODUCT.firmwareNote ?? "No firmware bundled for this board";
    }
  }
  document.title = `${ACTIVE_PRODUCT.label} - Ferbos EOL PCB Tester`;
}

function wireUi() {
  elements.startSequenceButton.addEventListener("click", () => startSequence());
  elements.abortSequenceButton.addEventListener("click", () => runner.abort());
  elements.sequenceForm.addEventListener("input", () => saveJson(STORAGE_KEYS.inputs, readSequenceInputs()));

  elements.connectButton.addEventListener("click", async () => {
    try {
      if (serial.isConnected) {
        await serial.disconnect();
        return;
      }
      await connectMainSerial({ allowPicker: true });
    } catch (error) {
      pushError(error);
    }
  });

  elements.rs485ConnectButton.addEventListener("click", async () => {
    try {
      if (rs485Serial.isConnected) {
        await rs485Serial.disconnect();
        return;
      }
      await connectJigSerial({ allowPicker: true });
    } catch (error) {
      pushError(error);
    }
  });

  async function handleFlashClick(profile, target) {
    if (runner.isRunning()) {
      pushError(new Error("Wait for the test sequence to finish or abort it before flashing."));
      return;
    }
    if (serial.isConnected) {
      await serial.disconnect();
      await wait(250);
    }

    prepareManualFlash(profile, target);
  }

  elements.flashTesterS3Button.addEventListener("click", () => handleFlashClick("tester", "s3"));
  elements.flashTesterC6Button.addEventListener("click", () => handleFlashClick("tester", "c6"));
  elements.flashProductionS3Button.addEventListener("click", () => handleFlashClick("production", "s3"));
  elements.flashProductionC6Button.addEventListener("click", () => handleFlashClick("production", "c6"));
  elements.flashAssistRetryButton.addEventListener("click", () => startAutoFlash());
  elements.flashAssistManualButton.addEventListener("click", () => startManualBootFlash());
  elements.flashAssistCloseButton.addEventListener("click", () => cancelPendingManualFlash());

  elements.resetButton.addEventListener("click", () => {
    elements.parameterForm.dataset.testId = "";
    store.reset();
  });

  elements.clearLogButton.addEventListener("click", () => store.clearLog());
  elements.exportLogButton.addEventListener("click", () => exportLog());
  elements.runButton.addEventListener("click", () => runSelectedTest());
  elements.cleanupButton.addEventListener("click", () => stopSelectedTest());
  elements.sendRawButton.addEventListener("click", () => sendRaw());
  elements.copyMacButton.addEventListener("click", () => copyIdentity("mac"));
  elements.copyIdentityButton.addEventListener("click", () => copyIdentity("all"));
  elements.readMacButton.addEventListener("click", () => readMacFromBoard());
  elements.forgetPortsButton.addEventListener("click", () => forgetAllPorts());

  elements.parameterForm.addEventListener("input", () => {
    const test = getTestById(store.getState().selectedTestId);
    if (test) {
      elements.rawJsonInput.value = JSON.stringify({ id: "preview", cmd: test.command, ...buildPayload(test, readParameters()) }, null, 2);
    }
  });
}

// ---------------------------------------------------------------------------
// Automatic test sequence
// ---------------------------------------------------------------------------

async function startSequence() {
  if (runner.isRunning()) {
    return;
  }

  const inputs = readSequenceInputs();
  saveJson(STORAGE_KEYS.inputs, inputs);

  try {
    store.setSequence({ status: "running", currentTestId: null, hint: "Connecting to the board..." });
    await connectMainSerial({ allowPicker: true });
  } catch (error) {
    store.setSequence({ status: "idle", currentTestId: null, hint: "" });
    if (error.name === "NotFoundError") {
      store.addLog({ kind: "error", title: "Sequence", message: "Port selection cancelled. Click Start Test Sequence again." });
    } else {
      pushError(error);
    }
    return;
  }

  // A missing jig is reported by the RS485 Jig Check step rather than blocking the whole run.
  if (inputs.rs485Enabled) {
    try {
      store.setSequence({ hint: "Connecting to the RS485 jig..." });
      await connectJigSerial({ allowPicker: true });
    } catch (error) {
      const message = error.name === "NotFoundError"
        ? "Jig port selection cancelled."
        : error.name === "SecurityError"
          ? "The browser needs a fresh click to open a second port. Use 'Connect RS485 Jig' under Engineer details, then Start again."
          : error.message;
      store.addLog({ kind: "error", title: "RS485 Jig", message });
    }
  }

  try {
    await runner.run(TESTS, inputs);
  } catch (error) {
    pushError(error);
  }
}

function readSequenceInputs() {
  const form = elements.sequenceForm;
  const values = {};
  for (const input of SEQUENCE_INPUTS) {
    const field = form.elements[input.name];
    if (!field) continue;
    values[input.name] = input.type === "checkbox" ? field.checked : field.value;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Port handling: reuse ports the browser already granted so steady-state runs
// need no picker. Port identity is remembered by USB vendor/product id.
// ---------------------------------------------------------------------------

// The browser's picker cannot be labelled by the page, so the panel behind it has to
// name the port being asked for -- in the product's own terms, since a climate station
// is choosing the board's native USB while a gateway station is choosing a bridge.
function describePortPick(key) {
  const ports = ACTIVE_PRODUCT.ports;
  const index = ports.findIndex((port) => port.key === key);
  const port = ports[index];
  if (!port) {
    return "Choose the serial port";
  }
  const position = ports.length > 1 ? ` (port ${index + 1} of ${ports.length})` : "";
  return `Choose the ${port.label} port${position} — ${port.note}`;
}

// Shows which port to pick and lets the browser paint before the modal picker steals focus.
async function announcePortPick(hint) {
  store.setSequence({ hint });
  store.addLog({ kind: "tx", title: "Port", message: hint });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function connectMainSerial({ allowPicker }) {
  if (serial.isConnected) {
    return;
  }
  const port = await findGrantedPort(STORAGE_KEYS.mainPort, [rs485Serial.port]);
  if (!port && !allowPicker) {
    throw new Error("S3 serial port is not connected");
  }
  if (!port) {
    await announcePortPick(describePortPick("main"));
  }

  await serial.connect({ baudRate: MAIN_BAUD, port });

  try {
    await prepareBoard();
  } catch (error) {
    await serial.disconnect().catch(() => {});
    // Drop the remembered port too, otherwise a cached wrong port would be retried forever
    // and the picker would never reappear.
    forgetPort(STORAGE_KEYS.mainPort);
    throw error;
  }

  rememberPort(STORAGE_KEYS.mainPort, serial.port);
}

/**
 * Reboots the board into its firmware and confirms this really is the S3.
 *
 * Flashing can leave the chip sitting in the ROM bootloader (always after Manual Boot Flash,
 * and after any Auto Flash whose final reset did not take), where it answers nothing. A reset
 * here recovers that without the operator touching the board, and waiting for the boot banner
 * means the first ping is not racing the firmware's startup.
 */
async function prepareBoard() {
  store.setSequence({ hint: "Resetting the board..." });
  // Listen before pulsing reset: the S3 can print its boot banner while the reset is still settling.
  const bootMessage = serial.waitForMessage((message) => message.type === "boot", BOOT_TIMEOUT_MS);

  try {
    await serial.resetIntoApplication();
  } catch (error) {
    store.addLog({ kind: "error", title: "Reset", message: `Auto reset unavailable (${error.message}). Continuing without it.` });
  }

  store.setSequence({ hint: "Waiting for the board to boot..." });
  const boot = await bootMessage;
  if (boot) {
    store.addLog({ kind: "ok", title: "Boot", message: `${boot.target ?? "s3"} ready` });
    return;
  }

  // No banner is not fatal on its own: the board may have booted before the listener attached.
  store.setSequence({ hint: "Checking the board responds..." });
  try {
    await serial.sendCommand("ping", {}, PORT_PROBE_TIMEOUT_MS);
    store.addLog({ kind: "ok", title: "Serial", message: "Board answered ping." });
  } catch {
    throw new Error(
      "This port did not answer as the ESP32-S3. Check it is the gateway port and not the RS485 adapter, "
      + "and if the board was just flashed in Manual Boot mode press RESET on the board, then Start again."
    );
  }
}

async function connectJigSerial({ allowPicker }) {
  if (rs485Serial.isConnected) {
    return;
  }
  const port = await findGrantedPort(STORAGE_KEYS.jigPort, [serial.port]);
  if (!port && !allowPicker) {
    throw new Error("RS485 jig port is not connected");
  }
  if (!port) {
    await announcePortPick(describePortPick("jig"));
  }
  await rs485Serial.connect({ baudRate: JIG_BAUD, port });
  rememberPort(STORAGE_KEYS.jigPort, rs485Serial.port);
}

async function findGrantedPort(storageKey, excludePorts) {
  const saved = loadJson(storageKey);
  if (!saved?.usbVendorId || !navigator.serial?.getPorts) {
    return null;
  }
  const ports = await navigator.serial.getPorts();
  const candidates = ports.filter((port) => {
    if (excludePorts.includes(port)) return false;
    const info = port.getInfo();
    return info.usbVendorId === saved.usbVendorId && info.usbProductId === saved.usbProductId;
  });
  // Ambiguous (two identical adapters) falls back to the picker.
  return candidates.length === 1 ? candidates[0] : null;
}

function describePort(port) {
  try {
    const info = port?.getInfo?.() ?? {};
    if (info.usbVendorId == null) return "serial port";
    const hex = (value) => value.toString(16).padStart(4, "0");
    return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId ?? 0)}`;
  } catch {
    return "serial port";
  }
}

function rememberPort(storageKey, port) {
  try {
    const info = port?.getInfo?.() ?? {};
    saveJson(storageKey, { usbVendorId: info.usbVendorId ?? null, usbProductId: info.usbProductId ?? null });
  } catch {
    // Port info is optional; the picker is still available.
  }
  refreshPortMemory();
}

function forgetPort(storageKey) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
  refreshPortMemory();
}

// Mirrors what is cached into state so the operator can see which ports are remembered.
function refreshPortMemory() {
  store.setPortMemory({
    main: describePortMemory(loadJson(STORAGE_KEYS.mainPort)),
    jig: describePortMemory(loadJson(STORAGE_KEYS.jigPort))
  });
}

function describePortMemory(saved) {
  if (!saved?.usbVendorId) {
    return null;
  }
  const hex = (value) => Number(value ?? 0).toString(16).padStart(4, "0");
  return `USB ${hex(saved.usbVendorId)}:${hex(saved.usbProductId)}`;
}

async function forgetAllPorts() {
  if (runner.isRunning()) {
    pushError(new Error("Abort the test sequence before changing ports."));
    return;
  }
  if (serial.isConnected) {
    await serial.disconnect().catch(() => {});
  }
  if (rs485Serial.isConnected) {
    await rs485Serial.disconnect().catch(() => {});
  }
  forgetPort(STORAGE_KEYS.mainPort);
  forgetPort(STORAGE_KEYS.jigPort);
  store.addLog({ kind: "ok", title: "Ports", message: "Saved ports cleared. The next Start will ask for them again." });
}

function loadJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage may be unavailable; inputs simply will not persist.
  }
}

// ---------------------------------------------------------------------------
// Log export (one file per PCB unit)
// ---------------------------------------------------------------------------

function exportLog() {
  const state = store.getState();
  const unitId = state.sequence.unitId || readSequenceInputs().unitId || "";
  const s3Identity = deriveIdentity(state.identity.s3?.macAddress);
  const report = {
    product: { id: ACTIVE_PRODUCT.id, label: ACTIVE_PRODUCT.label, boardId: ACTIVE_PRODUCT.boardId },
    unitId,
    exportedAt: new Date().toISOString(),
    identity: {
      s3: s3Identity ? { ...s3Identity, chipName: state.identity.s3?.chipName, readAt: state.identity.s3?.at } : null,
      c6: deriveIdentity(state.identity.c6?.macAddress)?.mac ?? null
    },
    sequence: {
      status: state.sequence.status,
      startedAt: state.sequence.startedAt,
      finishedAt: state.sequence.finishedAt
    },
    tests: TESTS.map((test) => {
      const result = state.tests[test.id];
      return {
        id: test.id,
        label: test.label,
        state: result.state,
        reason: result.reason,
        payload: redactPayload(result.payload),
        response: result.response,
        events: result.events,
        criteria: test.criteria.map((criterion, index) => ({ label: criterion.label, met: result.criteria[index] }))
      };
    }),
    logs: state.logs.map((log) => ({ at: log.at, kind: log.kind, title: log.title, line: log.line ?? null, message: log.message ?? null }))
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeUnit = (unitId || s3Identity?.gatewayId || "unit").replace(/[^\w.-]+/g, "_");
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ferbos-eol-${safeUnit}-${stamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  store.addLog({ kind: "ok", title: "Export", message: `Saved ${link.download}` });
}

// ---------------------------------------------------------------------------
// Firmware flashing (unchanged flow)
// ---------------------------------------------------------------------------

async function runFlashAttempt(port, target, modalCopy, options = {}) {
  updateFlashAssist({
    icon: "busy",
    title: modalCopy.title,
    status: modalCopy.status,
    message: modalCopy.message,
    showSteps: false,
    showRetry: false,
    showClose: false
  });

  return flashFirmware(port, target, updateFlashProgress, logFlashTool, {
    ...options,
    onIdentity: (info) => recordIdentity(target, info)
  });
}

// Called as soon as esptool identifies the chip, before any write, so a failed flash
// still leaves the operator with a MAC to put on the sticker.
function recordIdentity(target, { chipName, macAddress }) {
  if (!deriveIdentity(macAddress)) {
    return;
  }

  store.setIdentity(target, { chipName, macAddress });
  const identity = deriveIdentity(macAddress);
  elements.flashAssistMac.textContent = identity.mac;
  elements.flashAssistIdentity.classList.remove("d-none");
  store.addLog({
    kind: "ok",
    title: `${target.toUpperCase()} MAC`,
    message: target === "s3"
      ? `${identity.mac} — gateway id ${identity.gatewayId}, BLE ${identity.bleName}`
      : identity.mac
  });
}

// Read-only MAC recovery for a board that is already running production firmware:
// nothing is written, and the board is reset back into its application afterwards.
async function readMacFromBoard() {
  if (runner.isRunning()) {
    pushError(new Error("Wait for the test sequence to finish or abort it before reading the MAC."));
    return;
  }

  const wasConnected = serial.isConnected;
  const label = elements.readMacButton.textContent;
  elements.readMacButton.disabled = true;
  elements.readMacButton.textContent = "Reading...";

  try {
    if (wasConnected) {
      await serial.disconnect();
      await wait(250);
    }

    const port = await navigator.serial.requestPort();
    store.addLog({ kind: "tx", title: "Read MAC", message: "Connecting to the board without flashing." });
    const { chipName, macAddress, target } = await readDeviceMac(port, logFlashTool);

    if (!deriveIdentity(macAddress)) {
      throw new Error(`Chip answered but returned no usable MAC (${chipName ?? "unknown chip"})`);
    }
    if (!target) {
      throw new Error(`Unsupported chip for this product: ${chipName}`);
    }

    recordIdentity(target, { chipName, macAddress });
  } catch (error) {
    if (error.name === "NotFoundError") {
      store.addLog({ kind: "error", title: "Read MAC", message: "Port selection was cancelled." });
    } else {
      store.addLog({ kind: "error", title: "Read MAC Failed", message: formatFlashError(error) });
    }
  } finally {
    elements.readMacButton.textContent = label;
    elements.readMacButton.disabled = false;
    render(store.getState());
  }
}

async function copyIdentity(mode) {
  const identity = deriveIdentity(store.getState().identity.s3?.macAddress);
  if (!identity) {
    return;
  }

  const text = mode === "mac"
    ? identity.mac
    : [
        `MAC        ${identity.mac}`,
        `Gateway ID ${identity.gatewayId}`,
        `BLE name   ${identity.bleName}`,
        `MQTT       ${identity.mqttTopic}`
      ].join("\n");

  try {
    await navigator.clipboard.writeText(text);
    store.addLog({ kind: "ok", title: "Copied", message: mode === "mac" ? identity.mac : "Gateway identity copied to clipboard" });
  } catch (error) {
    pushError(new Error(`Could not copy: ${error.message}`));
  }
}

function prepareManualFlash(profile, target) {
  flashSession = { profile, target, complete: false };
  elements.flashAssistIdentity.classList.add("d-none");
  elements.flashProgress.style.display = "block";
  setFlashActionButtonsDisabled(true);
  elements.connectButton.disabled = true;
  elements.flashPercentage.innerText = "0%";
  elements.flashProgressBar.style.width = "0%";
  elements.flashStatusText.innerText = `Waiting for ${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}...`;
  elements.flashAssistRetryButton.textContent = "Auto Flash";
  elements.flashAssistManualButton.textContent = "Manual Boot Flash";
  elements.flashAssistCloseButton.textContent = "Cancel";
  elements.flashAssistRetryButton.disabled = false;
  elements.flashAssistManualButton.disabled = false;
  flashAssistModal.show();
  updateFlashAssist({
    icon: "busy",
    title: `Prepare ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`,
    status: "Choose flash method",
    message: "Use Auto Flash for normal boards. If automatic reset fails, use Manual Boot Flash and follow the BOOT/RESET steps.",
    steps: [
      "Click Auto Flash first for a healthy board.",
      "Choose the correct COM/tty port.",
      "If it cannot enter bootloader mode, switch to Manual Boot Flash."
    ],
    showSteps: true,
    showRetry: true,
    showManual: true,
    showClose: true
  });
  store.addLog({ kind: "tx", title: `Prepare ${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`, message: "Waiting for operator to choose automatic or manual boot flashing." });
}

async function startAutoFlash() {
  if (!flashSession) {
    return;
  }

  const { profile, target } = flashSession;

  try {
    elements.flashAssistRetryButton.disabled = true;
    elements.flashAssistManualButton.disabled = true;
    elements.flashAssistRetryButton.textContent = "Opening Port...";
    elements.flashAssistCloseButton.textContent = "Cancel";
    updateFlashAssist({
      icon: "busy",
      title: `Flashing ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`,
      status: "Select the serial port",
      message: "Choose the correct COM/tty port. The flasher will use automatic reset.",
      showSteps: false,
      showRetry: false,
      showManual: false,
      showClose: false
    });

    const port = await navigator.serial.requestPort();
    store.addLog({ kind: "tx", title: `Auto Flash ${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`, message: `Automatic reset flash started for ESP32-${target.toUpperCase()}.` });

    const result = await runFlashAttempt(port, target, {
      title: `Flashing ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`,
      status: "Trying automatic reset",
      message: "Keep the USB cable connected while firmware is written."
    }, {
      profile,
      resetMode: "default_reset",
      resetAfter: true
    });

    flashSession.complete = true;
    completeFlashUi(target, result.manualResetRequired, result.appDescriptor);
  } catch (error) {
    if (error.name === "NotFoundError") {
      showFlashPreparation(profile, target, "Port selection was cancelled. Click Auto Flash again when ready.");
      return;
    }

    store.addLog({ kind: "error", title: "Auto Flash Failed", message: error.message });
    showManualBootInstructions(profile, target, error);
  }
}

async function startManualBootFlash() {
  if (!flashSession) {
    return;
  }

  const { profile, target } = flashSession;

  try {
    elements.flashAssistRetryButton.disabled = true;
    elements.flashAssistManualButton.disabled = true;
    elements.flashAssistManualButton.textContent = "Opening Port...";
    elements.flashAssistCloseButton.textContent = "Cancel";
    updateFlashAssist({
      icon: "busy",
      title: `Manual Boot ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`,
      status: "Select the serial port",
      message: "Hold BOOT, press and release RESET once, keep holding BOOT, then choose the COM/tty port.",
      steps: [
        "Hold BOOT and keep holding it.",
        "Press and release RESET once.",
        "Choose the correct COM/tty port.",
        "Release BOOT only after the green success message appears."
      ],
      showSteps: true,
      showRetry: false,
      showManual: false,
      showClose: false
    });

    const port = await navigator.serial.requestPort();
    store.addLog({ kind: "tx", title: `Manual Boot Flash ${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`, message: `Manual no-reset flash started for ESP32-${target.toUpperCase()}.` });

    const result = await runFlashAttempt(port, target, {
      title: `Flashing ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`,
      status: "Connecting without reset",
      message: "Keep holding BOOT until the success message appears."
    }, {
      profile,
      resetMode: "no_reset",
      resetAfter: false
    });

    flashSession.complete = true;
    completeFlashUi(target, true, result.appDescriptor);
  } catch (error) {
    if (error.name === "NotFoundError") {
      showManualBootInstructions(profile, target, error, "Port selection was cancelled. Hold BOOT, press RESET once, then click Manual Boot Flash again.");
      return;
    }

    store.addLog({ kind: "error", title: "Manual Boot Flash Failed", message: error.message });
    showManualBootInstructions(profile, target, error);
  }
}

function showFlashPreparation(profile, target, message) {
  elements.flashAssistRetryButton.disabled = false;
  elements.flashAssistManualButton.disabled = false;
  elements.flashAssistRetryButton.textContent = "Auto Flash";
  elements.flashAssistManualButton.textContent = "Manual Boot Flash";
  elements.flashAssistCloseButton.textContent = "Cancel";
  updateFlashAssist({
    icon: "busy",
    title: `Prepare ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`,
    status: "Choose flash method",
    message,
    steps: [
      "Click Auto Flash first for a healthy board.",
      "Choose the correct COM/tty port.",
      "If it cannot enter bootloader mode, switch to Manual Boot Flash."
    ],
    showSteps: true,
    showRetry: true,
    showManual: true,
    showClose: true
  });
}

function showManualBootInstructions(profile, target, error, messageOverride) {
  elements.flashAssistRetryButton.disabled = false;
  elements.flashAssistManualButton.disabled = false;
  elements.flashAssistRetryButton.textContent = "Auto Flash";
  elements.flashAssistManualButton.textContent = "Manual Boot Flash";
  elements.flashAssistCloseButton.textContent = "Cancel";
  updateFlashAssist({
    icon: "warn",
    title: `ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]} Bootloader Not Ready`,
    status: "Manual boot may be required",
    message: messageOverride ?? `${formatFlashError(error)} Try Manual Boot Flash if Auto Flash keeps failing.`,
    steps: [
      "Hold BOOT and keep holding it.",
      "Press and release RESET once.",
      "Click Manual Boot Flash.",
      "Choose the correct COM/tty port.",
      "Release BOOT only after the green success message appears."
    ],
    showSteps: true,
    showRetry: true,
    showManual: true,
    showClose: true
  });
}

function completeFlashUi(target, manualResetNeeded, appDescriptor) {
  const profile = flashSession?.profile ?? "tester";
  const built = appDescriptor
    ? `${appDescriptor.project} ${appDescriptor.version} (built ${appDescriptor.built}, IDF ${appDescriptor.idf})`
    : null;
  store.addLog({
    kind: "ok",
    title: "Flash Success",
    message: built
      ? `${FLASH_PROFILE_LABELS[profile]} ${target.toUpperCase()} berhasil diflash: ${built}`
      : `${FLASH_PROFILE_LABELS[profile]} ${target.toUpperCase()} berhasil diflash.`
  });
  if (built) {
    // Printed so it can be compared against the boot banner: if they disagree, a stale
    // cached binary was written and the board is running something else.
    store.addLog({ kind: "ok", title: "Verify", message: `Boot banner should report: ${appDescriptor.built}, IDF ${appDescriptor.idf}` });
  }
  updateFlashProgress(flashFileCount(profile, target) - 1, 100);
  elements.flashAssistCloseButton.textContent = "OK";
  const identity = deriveIdentity(store.getState().identity[target]?.macAddress);
  updateFlashAssist({
    icon: "ok",
    title: `ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]} Complete`,
    status: built ?? (identity ? `MAC ${identity.mac}` : "Firmware verified successfully"),
    message: manualResetNeeded
      ? "Flash is complete. You can release BOOT now. Click OK to reload the tester; Start Test Sequence will reset the board into the firmware for you."
      : "Flash is complete. The board has been reset and is ready for serial testing.",
    showSteps: false,
    showRetry: false,
    showClose: true
  });
  endFlashControls();
}

function failFlashUi(target, error) {
  const message = formatFlashError(error);
  elements.flashAssistCloseButton.textContent = "Close";
  updateFlashAssist({
    icon: "error",
    title: `ESP32-${target.toUpperCase()} Flash Failed`,
    status: "Flashing stopped",
    message,
    showSteps: false,
    showRetry: false,
    showClose: true
  });
  endFlashControls();
}

function endFlashControls() {
  elements.flashProgress.style.display = "none";
  setFlashActionButtonsDisabled(false);
  elements.connectButton.disabled = false;
  elements.flashAssistRetryButton.disabled = false;
  elements.flashAssistManualButton.disabled = false;
  elements.flashAssistRetryButton.textContent = "Auto Flash";
  elements.flashAssistManualButton.textContent = "Manual Boot Flash";
}

function setFlashActionButtonsDisabled(disabled) {
  const unavailable = !ACTIVE_PRODUCT.firmware;
  for (const button of flashActionButtons) {
    button.disabled = disabled || unavailable;
  }
}

function cancelPendingManualFlash() {
  if (flashSession?.complete) {
    window.location.reload();
    return;
  }

  if (flashSession) {
    store.addLog({ kind: "error", title: "Flash Cancelled", message: "Firmware flashing was cancelled by operator." });
  }
  flashSession = null;
  endFlashControls();
}

function updateFlashProgress(fileIndex, percentage) {
  const { profile = "tester", target = "s3" } = flashSession ?? {};
  const fileCount = flashFileCount(profile, target);
  elements.flashPercentage.innerText = `${percentage}% (File ${fileIndex + 1}/${fileCount})`;
  elements.flashProgressBar.style.width = `${percentage}%`;
}

function logFlashTool(logData) {
  const message = String(logData ?? "").trim();
  if (message) {
    store.addLog({ kind: "tx", title: "ESPTool", message });
  }
}

function updateFlashAssist({ icon, title, status, message, steps, showSteps, showRetry, showManual, showClose }) {
  elements.flashAssistTitle.textContent = title;
  elements.flashAssistStatus.textContent = status;
  elements.flashAssistMessage.textContent = message;
  if (steps) {
    setFlashAssistSteps(steps);
  }
  elements.flashAssistSteps.classList.toggle("d-none", !showSteps);
  elements.flashAssistRetryButton.classList.toggle("d-none", !showRetry);
  elements.flashAssistManualButton.classList.toggle("d-none", !showManual);
  elements.flashAssistCloseButton.classList.toggle("d-none", !showClose);
  elements.flashAssistIcon.className = `flash-assist-icon is-${icon}`;
  elements.flashAssistIcon.innerHTML = icon === "busy"
    ? '<span class="spinner-border spinner-border-sm"></span>'
    : icon === "ok"
      ? "✓"
      : icon === "warn"
        ? "!"
        : "×";
}

function setFlashAssistSteps(steps) {
  elements.flashAssistSteps.replaceChildren(
    ...steps.map((step) => {
      const item = document.createElement("li");
      item.textContent = step;
      return item;
    })
  );
}

// ---------------------------------------------------------------------------
// Serial event routing
// ---------------------------------------------------------------------------

function wireSerial() {
  serial.addEventListener("connection", (event) => {
    store.setConnected(event.detail.connected);
    store.addLog({
      kind: event.detail.connected ? "ok" : "error",
      title: "Connection",
      message: event.detail.connected ? "Serial connected" : "Serial disconnected"
    });
    if (!event.detail.connected && runner.isRunning()) {
      runner.abort();
    }
  });

  serial.addEventListener("tx", (event) => {
    store.addLog({ kind: "tx", title: `TX ${event.detail.request.cmd}`, line: redactLine(event.detail.line) });
  });

  serial.addEventListener("rx", (event) => {
    const { message, line } = event.detail;
    store.addLog({
      kind: message.ok === false ? "error" : "rx",
      title: `RX ${message.type ?? "json"}`,
      line,
      message: message.detail ?? line
    });
    routeIncomingMessage(message);
  });

  serial.addEventListener("rx-invalid", (event) => {
    const line = event.detail.line;
    store.addLog({ ...classifyPlainLine(line), line });

    const fault = detectFirmwareFault(line);
    if (fault) {
      runner.reportFault(fault);
    }
  });

  serial.addEventListener("error", (event) => pushError(event.detail.error));
}

function wireRs485() {
  rs485Serial.addEventListener("connection", (event) => {
    store.setJigConnected(event.detail.connected);
    store.addLog({
      kind: event.detail.connected ? "ok" : "error",
      title: "RS485 Jig",
      message: event.detail.connected ? "Jig serial connected. Listening for PING..." : "Jig serial disconnected"
    });
  });

  // The PC acts as the RS485 jig: any line containing the PING payload gets a PONG reply.
  // The payload is a raw string, so it arrives through rx-invalid; rx covers a JSON-wrapped variant.
  const replyToPing = async (line) => {
    if (!line.includes("EOL_RS485_PING")) {
      return;
    }
    store.addLog({ kind: "rx", title: "RS485 IN", message: line });
    try {
      const reply = "EOL_RS485_PONG\n";
      await rs485Serial.sendString(reply);
      store.addLog({ kind: "tx", title: "RS485 OUT", message: reply.trim() });
    } catch (error) {
      pushError(error);
    }
  };

  rs485Serial.addEventListener("rx-invalid", (event) => replyToPing(event.detail.line || ""));
  rs485Serial.addEventListener("rx", (event) => replyToPing(event.detail.line || ""));
  rs485Serial.addEventListener("error", (event) => pushError(event.detail.error));
}

function routeIncomingMessage(message) {
  if (message.type === "boot") {
    store.addLog({
      kind: message.ready ? "ok" : "rx",
      title: "Boot",
      message: `${message.target ?? "target"} ${message.ready ? "ready" : "booted"}`
    });
    // Catches resets that print no panic dump, such as a watchdog or brownout.
    runner.reportFault({ type: "reboot", detail: "firmware restarted mid-test" });
    return;
  }

  if (message.type !== "event") {
    return;
  }

  const test = getTestById(message.test);
  if (!test) {
    return;
  }

  store.addTestEvent(test.id, message);
  refreshCriteria(test.id);
}

// Live criteria ticks while a test is in progress; the runner sets the final verdict.
function refreshCriteria(testId) {
  const test = getTestById(testId);
  const current = store.getState().tests[testId];
  if (!test || !current.response || (current.state !== "running" && current.state !== "waiting")) {
    return;
  }
  store.updateTest(testId, {
    criteria: evaluateCriteria(test, { response: current.response, events: current.events, payload: current.payload })
  });
}

// ---------------------------------------------------------------------------
// Engineer manual controls (single test through the same runner)
// ---------------------------------------------------------------------------

async function runSelectedTest() {
  const test = getTestById(store.getState().selectedTestId);
  if (!test || runner.isRunning()) {
    return;
  }

  const inputs = {
    ...readParameters(),
    rs485Enabled: true,
    unitId: readSequenceInputs().unitId
  };

  try {
    await runner.run([test], inputs);
  } catch (error) {
    pushError(error);
  }
}

async function stopSelectedTest() {
  if (runner.isRunning()) {
    runner.abort();
    return;
  }

  const test = getTestById(store.getState().selectedTestId);
  if (!test?.followUpCommand) {
    return;
  }

  try {
    const response = await serial.sendCommand(test.followUpCommand, {}, 3000);
    store.addLog({
      kind: response.ok ? "ok" : "error",
      title: `Cleanup ${test.followUpCommand}`,
      message: response.detail
    });
  } catch (error) {
    pushError(error);
  }
}

async function sendRaw() {
  try {
    const response = await serial.sendRaw(elements.rawJsonInput.value, 5000);
    store.addLog({ kind: response.ok ? "ok" : "error", title: `Raw response ${response.cmd}`, message: response.detail });
  } catch (error) {
    pushError(error);
  }
}

function readParameters() {
  return Object.fromEntries(new FormData(elements.parameterForm).entries());
}

function pushError(error) {
  store.addLog({ kind: "error", title: "Error", message: error.message });
}

function formatFlashError(error) {
  const message = error.message ?? String(error);
  if (message.includes("doesn't fit in the available flash")) {
    return "Firmware is larger than the detected flash area. For Ferbos PCB, retry after refresh; this build now uses flash size keep to avoid bad browser-side flash-size detection.";
  }
  return message;
}
