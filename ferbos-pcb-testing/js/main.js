import { createRenderer } from "./components/render.js";
import { SerialClient } from "./core/serialClient.js";
import { createStore } from "./core/state.js";
import { TESTS, getTestById } from "./core/testRegistry.js";
import { flashFirmware } from "./flasher.js";

const elements = {
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
  clearLogButton: document.querySelector("#clearLogButton"),
  eventLog: document.querySelector("#eventLog")
};

const serial = new SerialClient();
const rs485Serial = new SerialClient();
const render = createRenderer(elements, {
  onSelectTest: (testId) => store.selectTest(testId)
});
const store = createStore(render);

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
  tester: "PCB Testing Firmware",
  production: "Production Firmware"
};

const FLASH_FILE_COUNTS = {
  tester: { s3: 3, c6: 3 },
  production: { s3: 4, c6: 4 }
};

wireUi();
wireSerial();
wireRs485();
render(store.getState());

function wireUi() {
  elements.connectButton.addEventListener("click", async () => {
    try {
      if (serial.isConnected) {
        await serial.disconnect();
        return;
      }
      await serial.connect({ baudRate: 115200 });
    } catch (error) {
      pushError(error);
    }
  });

  async function handleFlashClick(profile, target) {
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
    render(store.getState());
  });

  elements.clearLogButton.addEventListener("click", () => store.clearLog());
  elements.runButton.addEventListener("click", () => {
    const test = getTestById(store.getState().selectedTestId);
    if (!test) return;
    const testState = store.getState().tests[test.id]?.state;
    if (test.manualDone && (testState === "running" || testState === "waiting")) {
      finishManualTest(test);
    } else {
      runSelectedTest();
    }
  });
  elements.cleanupButton.addEventListener("click", () => runCleanupCommand());
  
  elements.rs485ConnectButton.addEventListener("click", async () => {
    try {
      if (rs485Serial.isConnected) {
        await rs485Serial.disconnect();
        elements.rs485ConnectButton.textContent = "Connect RS485 Jig";
        elements.rs485ConnectButton.classList.replace("btn-danger", "btn-info");
        return;
      }
      await rs485Serial.connect({ baudRate: 9600 });
      elements.rs485ConnectButton.classList.replace("btn-info", "btn-danger");
      store.addLog({ kind: "ok", title: "RS485", message: "Jig connected. Listening for PING..." });
    } catch (error) {
      pushError(error);
    }
  });

  elements.sendRawButton.addEventListener("click", () => sendRaw());

  elements.parameterForm.addEventListener("input", () => {
    const test = getTestById(store.getState().selectedTestId);
    if (test) {
      elements.rawJsonInput.value = JSON.stringify({ id: "preview", cmd: test.command, ...readParameters(test) }, null, 2);
    }
  });
}

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

  return flashFirmware(port, target, updateFlashProgress, logFlashTool, options);
}

function prepareManualFlash(profile, target) {
  flashSession = { profile, target, complete: false };
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
    completeFlashUi(target, result.manualResetRequired);
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

    await runFlashAttempt(port, target, {
      title: `Flashing ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]}`,
      status: "Connecting without reset",
      message: "Keep holding BOOT until the success message appears."
    }, {
      profile,
      resetMode: "no_reset",
      resetAfter: false
    });

    flashSession.complete = true;
    completeFlashUi(target, true);
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

function completeFlashUi(target, manualResetNeeded) {
  const profile = flashSession?.profile ?? "tester";
  store.addLog({ kind: "ok", title: "Flash Success", message: `${FLASH_PROFILE_LABELS[profile]} ${target.toUpperCase()} berhasil diflash.` });
  updateFlashProgress((FLASH_FILE_COUNTS[profile]?.[target] ?? 1) - 1, 100);
  elements.flashAssistCloseButton.textContent = "OK";
  updateFlashAssist({
    icon: "ok",
    title: `ESP32-${target.toUpperCase()} ${FLASH_PROFILE_LABELS[profile]} Complete`,
    status: "Firmware verified successfully",
    message: manualResetNeeded
      ? "Flash is complete. You can release BOOT now. Click OK to reload the tester before serial testing."
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
  for (const button of flashActionButtons) {
    button.disabled = disabled;
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
  const fileCount = FLASH_FILE_COUNTS[profile]?.[target] ?? 3;
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

function wireSerial() {
  serial.addEventListener("connection", (event) => {
    store.setConnected(event.detail.connected);
    store.addLog({
      kind: event.detail.connected ? "ok" : "error",
      title: "Connection",
      message: event.detail.connected ? "Serial connected" : "Serial disconnected"
    });
  });

  serial.addEventListener("tx", (event) => {
    store.addLog({ kind: "tx", title: `TX ${event.detail.request.cmd}`, line: event.detail.line });
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
    store.addLog({ kind: "error", title: "Invalid JSON", line: event.detail.line, message: "Invalid JSON received" });
  });

  serial.addEventListener("error", (event) => pushError(event.detail.error));
}

function wireRs485() {
  rs485Serial.addEventListener("connection", (event) => {
    store.addLog({
      kind: event.detail.connected ? "ok" : "error",
      title: "RS485 Jig",
      message: event.detail.connected ? "Jig serial connected" : "Jig serial disconnected"
    });
  });

  // Since EOL_RS485_PING is a raw string, not JSON, it will trigger rx-invalid on the SerialClient parser
  rs485Serial.addEventListener("rx-invalid", async (event) => {
    const text = event.detail.line || "";
    if (text.includes("EOL_RS485_PING")) {
      store.addLog({ kind: "rx", title: "RS485 IN", message: text });
      try {
        const reply = "EOL_RS485_PONG\n";
        await rs485Serial.sendString(reply);
        store.addLog({ kind: "tx", title: "RS485 OUT", message: reply.trim() });
      } catch (err) {
        pushError(err);
      }
    }
  });

  // Just in case they send a valid JSON instead of a raw string, catch it here too
  rs485Serial.addEventListener("rx", async (event) => {
    const line = event.detail.line || "";
    if (line.includes("EOL_RS485_PING")) {
      store.addLog({ kind: "rx", title: "RS485 IN", message: line });
      try {
        await rs485Serial.sendString("EOL_RS485_PONG\n");
      } catch (err) {
        pushError(err);
      }
    }
  });

  rs485Serial.addEventListener("error", (event) => pushError(event.detail.error));
}

async function runSelectedTest() {
  const test = getTestById(store.getState().selectedTestId);
  if (!test) {
    return;
  }

  if (test.id === "rs485" && !rs485Serial.isConnected) {
    store.addLog({ kind: "error", title: "RS485 Test", message: "Please click 'Connect RS485 Jig' before running this test." });
    pushError(new Error("RS485 Jig adapter is not connected."));
    return;
  }

  const payload = readParameters(test);
  const eventsBeforeRun = store.getState().tests[test.id].events.length;
  
  // Use a longer timeout for the Web UI promise to allow firmware to finish
  const uiTimeoutMs = payload.timeout_ms ? Number(payload.timeout_ms) + 2000 : (test.timeoutMs || 3000);
  
  store.updateTest(test.id, {
    state: "running",
    response: null,
    chainedResponses: [],
    criteria: test.criteria.map(() => false),
    lastDetail: "Sending command"
  });

  try {
    const response = await serial.sendCommand(test.command, payload, uiTimeoutMs);
    const events = getEventsSince(test.id, eventsBeforeRun);
    const chainedResponses = [];

    if (test.blocked?.({ response, events })) {
      updateTestResult(test, response, chainedResponses, events, "manual");
      return;
    }

    for (const chained of test.chainedCommands ?? []) {
      const chainedPayload = resolveChainedPayload(chained, payload);
      const chainedResponse = await serial.sendCommand(chained.command, chainedPayload, test.timeoutMs);
      chainedResponses.push(chainedResponse);
    }

    const finalEvents = getEventsSince(test.id, eventsBeforeRun);
    const state = test.pass({ response, chainedResponses, events: finalEvents, payload }) ? "passed" : getPendingState(test, response, finalEvents);
    updateTestResult(test, response, chainedResponses, finalEvents, state);
  } catch (error) {
    store.updateTest(test.id, {
      state: "failed",
      lastDetail: error.message,
      criteria: test.criteria.map(() => false)
    });
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


function routeIncomingMessage(message) {
  if (message.type === "boot") {
    store.addLog({
      kind: message.ready ? "ok" : "rx",
      title: "Boot",
      message: `${message.target ?? "target"} ${message.ready ? "ready" : "booted"}`
    });
    return;
  }

  if (message.type !== "event") {
    return;
  }

  const test = TESTS.find((item) => item.id === message.test || item.command.startsWith(message.test));
  if (!test) {
    return;
  }

  store.addTestEvent(test.id, message);
  const current = store.getState().tests[test.id];
  if (current.state === "running" && test.waitingStates?.includes(message.state)) {
    store.updateTest(test.id, { state: "waiting", lastDetail: message.detail ?? message.state });
  }

  refreshCriteria(test.id);
}

async function runCleanupCommand() {
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
    
    const current = store.getState().tests[test.id];
    if (test.manualDone && (current.state === "running" || current.state === "waiting")) {
      store.updateTest(test.id, {
        state: "failed",
        lastDetail: "Interrupted by user"
      });
    }
  } catch (error) {
    pushError(error);
  }
}

async function finishManualTest(test) {
  try {
    if (test.followUpCommand) {
      const response = await serial.sendCommand(test.followUpCommand, {}, 3000);
      store.addLog({
        kind: response.ok ? "ok" : "error",
        title: `Done ${test.followUpCommand}`,
        message: response.detail
      });
    }
    const current = store.getState().tests[test.id];
    const isPass = test.pass({ 
      response: current.response, 
      chainedResponses: current.chainedResponses, 
      events: current.events, 
      payload: readParameters(test) 
    });
    const state = isPass ? "passed" : "failed";
    
    store.updateTest(test.id, {
      state,
      lastDetail: statusLabel(state),
      criteria: calculateCriteria(test, current.response, current.chainedResponses, current.events)
    });
  } catch (error) {
    pushError(error);
  }
}

function updateTestResult(test, response, chainedResponses, events, state) {
  store.updateTest(test.id, {
    state,
    response,
    chainedResponses,
    lastDetail: response.detail ?? statusLabel(state),
    criteria: calculateCriteria(test, response, chainedResponses, events)
  });
}

function refreshCriteria(testId) {
  const state = store.getState();
  const test = getTestById(testId);
  const current = state.tests[testId];
  if (!test || !current.response) {
    return;
  }
  
  if (test.manualDone && (current.state === "running" || current.state === "waiting")) {
    store.updateTest(testId, {
      criteria: calculateCriteria(test, current.response, current.chainedResponses, current.events)
    });
    return;
  }

  store.updateTest(testId, {
    state: test.pass({ response: current.response, chainedResponses: current.chainedResponses, events: current.events, payload: readParameters(test) }) ? "passed" : current.state,
    criteria: calculateCriteria(test, current.response, current.chainedResponses, current.events)
  });
}

function calculateCriteria(test, response, chainedResponses, events) {
  if (test.id === "ethernet") {
    return [
      Boolean(response?.ok),
      events.some((event) => event.test === "ethernet" && event.state === "link_up"),
      events.some((event) => event.test === "ethernet" && event.state === "got_ip"),
      events.some((event) => event.test === "ethernet" && event.state === "link_down")
    ];
  }

  if (test.id === "wifi") {
    return [
      Boolean(response?.ok),
      events.some((event) => event.test === "wifi" && event.state === "connecting"),
      events.some((event) => event.test === "wifi" && event.state === "got_ip")
    ];
  }

  if (test.id === "ble") {
    const echo = chainedResponses.find((item) => item.cmd === "ble_echo");
    return [
      Boolean(response?.ok),
      Boolean(echo?.ok),
      Boolean((echo?.detail ?? "").includes(readParameters(test).payload))
    ];
  }

  return test.criteria.map(() => test.pass({ response, chainedResponses, events }));
}

function getPendingState(test, response, events) {
  if (!response?.ok) {
    return "failed";
  }
  if (test.waitingStates?.length) {
    return "waiting";
  }
  return "failed";
}

function readParameters(test) {
  const data = Object.fromEntries(new FormData(elements.parameterForm).entries());
  const payload = {};

  for (const parameter of test.parameters) {
    const value = data[parameter.name] ?? parameter.value ?? "";
    payload[parameter.name] = parameter.type === "number" ? Number(value) : value;
  }

  return payload;
}

function resolveChainedPayload(chained, parentPayload) {
  const payload = {};
  for (const parameter of chained.parameters ?? []) {
    payload[parameter.name] = parentPayload[parameter.source];
  }
  return payload;
}

function getEventsSince(testId, startIndex) {
  return store.getState().tests[testId].events.slice(startIndex);
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

function statusLabel(state) {
  return {
    passed: "Passed",
    failed: "Failed",
    waiting: "Waiting for async event",
    manual: "Needs firmware config check"
  }[state] ?? state;
}
