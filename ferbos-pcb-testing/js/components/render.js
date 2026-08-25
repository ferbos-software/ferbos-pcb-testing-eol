import { TESTS, getTestById } from "../core/testRegistry.js";

const statusLabels = {
  idle: "Ready",
  running: "Running",
  waiting: "Waiting",
  passed: "Passed",
  failed: "Failed",
  manual: "Check"
};

export function createRenderer(elements, handlers) {
  const render = (state) => {
    elements.connectionStatus.textContent = state.connected ? "Connected" : "Disconnected";
    elements.connectButton.textContent = state.connected ? "Disconnect" : "Connect Serial";
    elements.runButton.disabled = !state.connected || !state.selectedTestId;
    elements.cleanupButton.disabled = !state.connected || !getTestById(state.selectedTestId)?.followUpCommand;
    elements.sendRawButton.disabled = !state.connected;
    elements.lastMessage.textContent = state.lastMessage;

    renderProgress(elements.progressText, state);
    renderTestList(elements.testList, state, handlers.onSelectTest);
    renderSelectedTest(elements.selectedTest, elements.parameterForm, elements.rawJsonInput, state);
    renderLogs(elements.eventLog, state.logs);
  };

  return render;
}

function renderProgress(node, state) {
  const statuses = TESTS.map((test) => state.tests[test.id]?.state);
  const passed = statuses.filter((status) => status === "passed").length;
  node.textContent = `${passed} / ${TESTS.length} passed`;
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
    container.textContent = "Tidak ada test dipilih.";
    return;
  }

  const current = state.tests[test.id];
  const title = document.createElement("h3");
  const summary = document.createElement("p");
  const criteriaList = document.createElement("ul");

  title.textContent = test.label;
  summary.textContent = test.summary;
  criteriaList.className = "criteria-list";

  test.criteria.forEach((criteria, index) => {
    const item = document.createElement("li");
    item.textContent = criteria;
    if (current.criteria[index]) {
      item.classList.add("met");
    }
    criteriaList.append(item);
  });

  container.replaceChildren(title, summary, criteriaList);
  if (form.dataset.testId !== test.id) {
    renderParameterForm(form, test);
    form.dataset.testId = test.id;
  }
  rawInput.value = JSON.stringify(buildPreviewCommand(test, form), null, 2);
}

function renderParameterForm(form, test) {
  form.replaceChildren();

  for (const parameter of test.parameters) {
    const label = document.createElement("label");
    const span = document.createElement("span");
    const input = document.createElement("input");
    span.textContent = parameter.label;
    input.name = parameter.name;
    input.type = parameter.type ?? "text";
    input.value = parameter.value ?? "";
    input.autocomplete = "off";
    input.addEventListener("input", () => {});
    label.append(span, input);
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

function renderLogs(container, logs) {
  container.replaceChildren();

  for (const log of logs) {
    const entry = document.createElement("article");
    const title = document.createElement("strong");
    const code = document.createElement("code");
    entry.className = `log-entry ${log.kind}`;
    title.textContent = `${log.at.toLocaleTimeString()} - ${log.title}`;
    code.textContent = log.line ?? log.message ?? "";
    entry.append(title, code);
    container.append(entry);
  }
}
