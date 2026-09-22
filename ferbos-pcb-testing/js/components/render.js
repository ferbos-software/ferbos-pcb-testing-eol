import { deriveIdentity } from "../core/identity.js";
import { TESTS, getTestById } from "../core/productRegistry.js";

const statusLabels = {
  idle: "Ready",
  running: "Running",
  waiting: "Waiting",
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped"
};

export function createRenderer(elements, handlers) {
  const render = (state) => {
    const running = state.sequence.status === "running";
    const test = getTestById(state.selectedTestId);

    elements.connectionStatus.textContent = describeConnections(state);
    elements.connectionStatus.classList.toggle("text-success", state.connected);
    elements.connectionStatus.classList.toggle("text-secondary", !state.connected);

    elements.startSequenceButton.disabled = running;
    elements.startSequenceButton.textContent = running ? "Sequence Running..." : "Start Test Sequence";
    elements.abortSequenceButton.classList.toggle("d-none", !running);
    elements.resetButton.disabled = running;

    elements.connectButton.textContent = state.connected ? "Disconnect Serial" : "Connect Serial (115200)";
    elements.connectButton.disabled = running;
    elements.rs485ConnectButton.textContent = state.jigConnected ? "Disconnect RS485 Jig" : "Connect RS485 Jig (9600)";
    elements.rs485ConnectButton.disabled = running;
    elements.runButton.disabled = running || !state.connected || !test;
    elements.cleanupButton.textContent = running ? "Stop Sequence" : "Stop Mode";
    elements.cleanupButton.disabled = !running && !(state.connected && test?.followUpCommand);
    elements.sendRawButton.disabled = running || !state.connected;
    elements.lastMessage.textContent = state.lastMessage;

    renderIdentity(elements, state);
    renderPortGuide(elements, state);
    renderProgress(elements.progressText, state);
    renderBanner(elements, state);
    renderTestList(elements.testList, state, handlers.onSelectTest);
    renderSelectedTest(elements.selectedTest, elements.parameterForm, elements.rawJsonInput, state);
    renderLogs(elements.eventLog, state.logs);
  };

  return render;
}

// The S3 base MAC is the gateway identity; the C6 MAC is shown only as a secondary line.
function renderIdentity(elements, state) {
  const s3 = deriveIdentity(state.identity.s3?.macAddress);
  const c6 = deriveIdentity(state.identity.c6?.macAddress);
  elements.identityCard.dataset.state = s3 ? "known" : "empty";
  elements.identityMac.textContent = s3
    ? s3.mac
    : (c6 ? "Flash or read an ESP32-S3 for the gateway MAC" : "No board read yet");
  elements.identityGatewayId.textContent = s3 ? s3.gatewayId : "-";
  elements.identityBleName.textContent = s3 ? s3.bleName : "-";
  elements.identityMqttTopic.textContent = s3 ? s3.mqttTopic : "-";
  elements.copyMacButton.disabled = !s3;
  elements.copyIdentityButton.disabled = !s3;
  elements.readMacButton.disabled = Boolean(state.sequence.status === "running");
  elements.identityC6.classList.toggle("d-none", !c6);
  if (c6) {
    elements.identityC6Mac.textContent = c6.mac;
  }
}

const PORT_GUIDE = [
  { key: "main", label: "ESP32-S3 gateway", note: "the board under test" },
  { key: "jig", label: "USB-RS485 jig adapter", note: "only when the jig is enabled" }
];

// The browser picker cannot be labelled by the page, so the operator needs to know
// here which port is asked for, and which are already remembered.
function renderPortGuide(elements, state) {
  const anySaved = PORT_GUIDE.some(({ key }) => state.portMemory[key]);

  elements.portGuide.replaceChildren(
    ...PORT_GUIDE.map(({ key, label, note }, index) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      const detail = document.createElement("span");
      const saved = state.portMemory[key];

      name.textContent = `Port ${index + 1} — ${label}`;
      detail.className = "port-guide-note";
      detail.textContent = saved ? ` remembered (${saved})` : ` ${note}, will be asked for`;
      item.dataset.saved = saved ? "yes" : "no";
      item.append(name, detail);
      return item;
    })
  );

  elements.forgetPortsButton.classList.toggle("d-none", !anySaved);
  elements.forgetPortsButton.disabled = state.sequence.status === "running";
}

function describeConnections(state) {
  if (!state.connected) {
    return "Disconnected";
  }
  return state.jigConnected ? "S3 connected · RS485 jig connected" : "S3 connected";
}

function renderProgress(node, state) {
  const statuses = TESTS.map((test) => state.tests[test.id]?.state);
  const passed = statuses.filter((status) => status === "passed").length;
  node.textContent = `${passed} / ${TESTS.length} passed`;
}

function renderBanner(elements, state) {
  const { sequence } = state;
  const banner = elements.sequenceBanner;
  let kicker = "";
  let title = "";
  let text = "";
  let items = [];
  let status = sequence.status;

  if (sequence.status === "idle") {
    title = "Ready";
    text = "Fill in Step 2 and click Start Test Sequence. The tests run automatically; follow the instructions shown here.";
  } else if (sequence.status === "running") {
    const test = getTestById(sequence.currentTestId);
    const index = TESTS.findIndex((item) => item.id === sequence.currentTestId);
    kicker = test ? `Step ${index + 1} of ${TESTS.length} · ${test.label}` : "Preparing";
    title = sequence.hint || (test ? "Running automatically..." : "Connecting to the board...");
    text = test ? state.tests[test.id]?.lastDetail || "" : "";
  } else {
    const results = TESTS.map((test) => ({ test, result: state.tests[test.id] }));
    const failed = results.filter(({ result }) => result.state === "failed");
    const skipped = results.filter(({ result }) => result.state === "skipped");
    const passed = results.filter(({ result }) => result.state === "passed").length;
    const unit = sequence.unitId ? ` · Unit ${sequence.unitId}` : "";

    if (sequence.status === "aborted") {
      kicker = `Aborted${unit}`;
      title = "Sequence aborted";
      text = "Click Start Test Sequence to run again.";
    } else if (failed.length === 0 && skipped.every(({ test }) => test.requiresJig)) {
      status = "pass";
      kicker = `Finished${unit}`;
      title = "PASS";
      text = `${passed} / ${TESTS.length} tests passed. Board is ready for production firmware (Step 3).`;
    } else {
      status = "fail";
      kicker = `Finished${unit}`;
      title = "FAIL";
      text = `${passed} passed, ${failed.length} failed, ${skipped.length} skipped.`;
    }
    items = [
      ...failed.map(({ test, result }) => ({ kind: "fail", text: `${test.label}: ${result.reason || "failed"}` })),
      ...skipped.map(({ test, result }) => ({ kind: "skip", text: `${test.label}: ${result.reason || "skipped"}` }))
    ];
  }

  banner.dataset.status = status;
  elements.sequenceBannerKicker.textContent = kicker;
  elements.sequenceBannerTitle.textContent = title;
  elements.sequenceBannerText.textContent = text;
  elements.sequenceBannerList.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.dataset.kind = item.kind;
      li.textContent = item.text;
      return li;
    })
  );
  elements.sequenceBannerList.classList.toggle("d-none", items.length === 0);
}

function renderTestList(container, state, onSelectTest) {
  container.replaceChildren();

  TESTS.forEach((test, index) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    const step = document.createElement("span");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    const summary = document.createElement("small");
    const pill = document.createElement("span");
    const testState = state.tests[test.id]?.state ?? "idle";

    button.type = "button";
    button.className = `test-item${state.selectedTestId === test.id ? " active" : ""}`;
    button.dataset.status = testState;
    button.addEventListener("click", () => onSelectTest(test.id));

    step.className = "step-number";
    step.textContent = String(index + 1).padStart(2, "0");
    copy.className = "test-item-copy";
    title.textContent = test.label;
    summary.textContent = state.tests[test.id]?.lastDetail || test.summary;
    pill.className = "status-pill";
    pill.textContent = statusLabels[testState] ?? testState;

    copy.append(title, summary);
    button.append(step, copy, pill);
    li.append(button);
    container.append(li);
  });
}

function renderSelectedTest(container, form, rawInput, state) {
  const test = getTestById(state.selectedTestId);
  if (!test) {
    container.textContent = "No test selected.";
    return;
  }

  const current = state.tests[test.id];
  const title = document.createElement("h3");
  const summary = document.createElement("p");
  const criteriaList = document.createElement("ul");

  title.textContent = test.label;
  summary.textContent = test.summary;
  criteriaList.className = "criteria-list";

  test.criteria.forEach((criterion, index) => {
    const item = document.createElement("li");
    item.textContent = criterion.label;
    if (current.criteria[index]) {
      item.classList.add("met");
    }
    criteriaList.append(item);
  });

  const children = [title, summary, criteriaList];
  if (current.state === "failed" || current.state === "skipped") {
    const reason = document.createElement("p");
    reason.className = `test-reason is-${current.state}`;
    reason.textContent = current.reason || current.lastDetail;
    children.push(reason);
  }

  container.replaceChildren(...children);
  if (form.dataset.testId !== test.id) {
    renderParameterForm(form, test);
    form.dataset.testId = test.id;
    rawInput.dataset.testId = test.id;
    rawInput.value = JSON.stringify(buildPreviewCommand(test, form), null, 2);
  }
}

// A password field plus a Show/Hide toggle. Operators need to check what they typed --
// a mistyped or space-padded password is the usual cause of a wifi reason=15 failure.
function createPasswordField(input) {
  const group = document.createElement("div");
  const toggle = document.createElement("button");

  group.className = "password-field";
  toggle.type = "button";
  toggle.className = "password-toggle";

  const setShown = (shown) => {
    input.type = shown ? "text" : "password";
    toggle.textContent = shown ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", String(shown));
    toggle.setAttribute("aria-label", shown ? "Hide password" : "Show password");
  };

  setShown(false);
  toggle.addEventListener("click", () => setShown(input.type === "password"));
  group.append(input, toggle);
  return group;
}

function createField(parameter, value) {
  const input = document.createElement("input");
  input.name = parameter.name;
  input.type = parameter.type ?? "text";
  input.value = value ?? "";
  input.autocomplete = "off";
  input.className = "form-control";
  if (parameter.placeholder) {
    input.placeholder = parameter.placeholder;
  }
  return parameter.type === "password" ? createPasswordField(input) : input;
}

function renderParameterForm(form, test) {
  form.replaceChildren();

  for (const parameter of test.parameters) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = parameter.label;
    label.append(span, createField(parameter, parameter.value));
    form.append(label);
  }
}

export function renderSequenceForm(form, inputs, values) {
  form.replaceChildren();

  for (const input of inputs) {
    const label = document.createElement("label");
    const field = document.createElement("input");
    const value = values[input.name] ?? input.value ?? "";
    field.name = input.name;
    field.autocomplete = "off";

    if (input.type === "checkbox") {
      label.className = "form-check";
      field.type = "checkbox";
      field.className = "form-check-input";
      field.checked = Boolean(value);
      const text = document.createElement("span");
      text.className = "form-check-label";
      text.textContent = input.label;
      label.append(field, text);
    } else {
      const text = document.createElement("span");
      text.textContent = input.label;
      label.append(text, createField(input, value));
    }
    form.append(label);
  }
}

function buildPreviewCommand(test, form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const [key, value] of Object.entries(payload)) {
    if (/timeout_ms$/.test(key)) {
      payload[key] = Number(value);
    }
  }
  return { id: "preview", cmd: test.command, ...payload };
}

const LOG_TAGS = {
  tx: "TX",
  rx: "RX",
  ok: "OK",
  warn: "WRN",
  error: "ERR"
};

const pad = (value, width) => String(value).padStart(width, "0");

function logTimestamp(at) {
  return `${pad(at.getHours(), 2)}:${pad(at.getMinutes(), 2)}:${pad(at.getSeconds(), 2)}.${pad(at.getMilliseconds(), 3)}`;
}

// Raw serial lines speak for themselves; status entries need their title for context.
function logText(log) {
  if (log.line) {
    return log.line;
  }
  const message = log.message ?? "";
  if (!log.title) {
    return message;
  }
  return message ? `${log.title}: ${message}` : log.title;
}

function createLogLine(log) {
  const line = document.createElement("div");
  const time = document.createElement("time");
  const tag = document.createElement("span");
  const text = document.createElement("span");

  line.className = "log-line";
  line.dataset.kind = log.kind;
  time.className = "log-time";
  time.textContent = logTimestamp(log.at);
  tag.className = "log-tag";
  tag.textContent = log.tag ?? LOG_TAGS[log.kind] ?? "--";
  if (log.tag === "!!") {
    line.dataset.fault = "yes";
  }
  text.className = "log-text";
  text.textContent = logText(log);

  line.append(time, tag, text);
  return line;
}

// Appends only what is new and keeps the view pinned to the bottom unless the
// operator has scrolled up to read history.
function renderLogs(container, logs) {
  const renderedSeq = Number(container.dataset.lastSeq ?? "-1");
  const newestSeq = logs.length ? logs[logs.length - 1].seq : -1;

  container.classList.toggle("is-empty", logs.length === 0);
  if (newestSeq === renderedSeq && container.childElementCount === logs.length) {
    return;
  }

  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
  const follow = distanceFromBottom < 48;

  if (newestSeq < renderedSeq || container.childElementCount === 0) {
    container.replaceChildren(...logs.map(createLogLine));
  } else {
    const fresh = logs.filter((log) => log.seq > renderedSeq);
    if (fresh.length) {
      container.append(...fresh.map(createLogLine));
    }
    while (container.childElementCount > logs.length) {
      container.firstElementChild.remove();
    }
  }

  container.dataset.lastSeq = String(newestSeq);
  if (follow) {
    container.scrollTop = container.scrollHeight;
  }
}
