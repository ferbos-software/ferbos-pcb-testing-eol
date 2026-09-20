import { TESTS } from "./testRegistry.js";

function createTestStatus(test) {
  return {
    state: "idle",
    response: null,
    events: [],
    criteria: test.criteria.map(() => false),
    payload: null,
    lastDetail: "",
    reason: ""
  };
}

function createSequenceStatus() {
  return {
    status: "idle", // idle | running | done | aborted
    currentTestId: null,
    hint: "",
    unitId: "",
    startedAt: null,
    finishedAt: null
  };
}

export function createInitialState() {
  return {
    // MAC captured by esptool at flash time, per chip: { s3: {...}, c6: {...} }
    identity: {},
    // Which serial ports are remembered, as "USB vvvv:pppp" or null.
    portMemory: { main: null, jig: null },
    connected: false,
    jigConnected: false,
    selectedTestId: TESTS[0]?.id ?? null,
    lastMessage: "Waiting for serial",
    logs: [],
    sequence: createSequenceStatus(),
    tests: Object.fromEntries(TESTS.map((test) => [test.id, createTestStatus(test)]))
  };
}

export const LOG_LIMIT = 250;

export function createStore(render) {
  let state = createInitialState();
  // Monotonic id so the terminal renderer can append only what is new.
  let logSeq = 0;

  const setState = (updater) => {
    state = typeof updater === "function" ? updater(state) : updater;
    render(state);
  };

  return {
    getState: () => state,
    setConnected: (connected) => {
      setState((current) => ({ ...current, connected }));
    },
    setPortMemory: (portMemory) => {
      setState((current) => ({ ...current, portMemory }));
    },
    setJigConnected: (jigConnected) => {
      setState((current) => ({ ...current, jigConnected }));
    },
    selectTest: (testId) => {
      setState((current) => ({ ...current, selectedTestId: testId }));
    },
    setIdentity: (target, info) => {
      setState((current) => ({
        ...current,
        identity: { ...current.identity, [target]: { ...info, at: new Date() } }
      }));
    },
    clearIdentity: () => {
      setState((current) => ({ ...current, identity: {} }));
    },
    // Clears results and logs but keeps the live port connections.
    // Identity is cleared too: Reset means "next board".
    reset: () => {
      setState((current) => ({
        ...createInitialState(),
        connected: current.connected,
        jigConnected: current.jigConnected,
        selectedTestId: current.selectedTestId
      }));
    },
    setSequence: (patch) => {
      setState((current) => ({ ...current, sequence: { ...current.sequence, ...patch } }));
    },
    // Chronological: newest is appended last, like a terminal.
    addLog: (entry) => {
      setState((current) => ({
        ...current,
        lastMessage: entry.message ?? current.lastMessage,
        logs: [...current.logs, { ...entry, at: new Date(), seq: ++logSeq }].slice(-LOG_LIMIT)
      }));
    },
    clearLog: () => {
      setState((current) => ({ ...current, logs: [] }));
    },
    updateTest: (testId, patch) => {
      setState((current) => ({
        ...current,
        tests: {
          ...current.tests,
          [testId]: {
            ...current.tests[testId],
            ...patch
          }
        }
      }));
    },
    addTestEvent: (testId, event) => {
      setState((current) => ({
        ...current,
        tests: {
          ...current.tests,
          [testId]: {
            ...current.tests[testId],
            events: [...current.tests[testId].events, event],
            lastDetail: event.detail ?? current.tests[testId].lastDetail
          }
        }
      }));
    }
  };
}
