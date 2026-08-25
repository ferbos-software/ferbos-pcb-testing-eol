import { createRenderer } from "./components/render.js";
import { SerialClient } from "./core/serialClient.js";
import { createStore } from "./core/state.js";
import { TESTS, getTestById } from "./core/testRegistry.js";

const elements = {
  baudRate: document.querySelector("#baudRate"),
  connectButton: document.querySelector("#connectButton"),
  connectionStatus: document.querySelector("#connectionStatus"),
  progressText: document.querySelector("#progressText"),
  lastMessage: document.querySelector("#lastMessage"),
  resetButton: document.querySelector("#resetButton"),
  testList: document.querySelector("#testList"),
  selectedTest: document.querySelector("#selectedTest"),
  parameterForm: document.querySelector("#parameterForm"),
  runButton: document.querySelector("#runButton"),
  cleanupButton: document.querySelector("#cleanupButton"),
  sendRawButton: document.querySelector("#sendRawButton"),
  rawJsonInput: document.querySelector("#rawJsonInput"),
  clearLogButton: document.querySelector("#clearLogButton"),
  eventLog: document.querySelector("#eventLog")
};

const serial = new SerialClient();
const render = createRenderer(elements, {
  onSelectTest: (testId) => store.selectTest(testId)
});
const store = createStore(render);

wireUi();
wireSerial();
render(store.getState());

function wireUi() {
  elements.connectButton.addEventListener("click", async () => {
    try {
      if (serial.isConnected) {
        await serial.disconnect();
        return;
      }
      await serial.connect({ baudRate: elements.baudRate.value });
    } catch (error) {
      pushError(error);
    }
  });

  elements.resetButton.addEventListener("click", () => {
    elements.parameterForm.dataset.testId = "";
    store.reset();
    render(store.getState());
  });

  elements.clearLogButton.addEventListener("click", () => store.clearLog());
  elements.runButton.addEventListener("click", () => runSelectedTest());
  elements.cleanupButton.addEventListener("click", () => runCleanupCommand());
  elements.sendRawButton.addEventListener("click", () => sendRaw());

  elements.parameterForm.addEventListener("input", () => {
    const test = getTestById(store.getState().selectedTestId);
    if (test) {
      elements.rawJsonInput.value = JSON.stringify({ id: "preview", cmd: test.command, ...readParameters(test) }, null, 2);
    }
  });
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

async function runSelectedTest() {
  const test = getTestById(store.getState().selectedTestId);
  if (!test) {
    return;
  }

  const payload = readParameters(test);
  const eventsBeforeRun = store.getState().tests[test.id].events.length;
  store.updateTest(test.id, {
    state: "running",
    response: null,
    chainedResponses: [],
    criteria: test.criteria.map(() => false),
    lastDetail: "Sending command"
  });

  try {
    const response = await serial.sendCommand(test.command, payload, test.timeoutMs);
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

function statusLabel(state) {
  return {
    passed: "Passed",
    failed: "Failed",
    waiting: "Waiting for async event",
    manual: "Needs firmware config check"
  }[state] ?? state;
}
