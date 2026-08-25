import { TESTS } from "./testRegistry.js";

function createTestStatus(test) {
  return {
    state: "idle",
    response: null,
    chainedResponses: [],
    events: [],
    criteria: test.criteria.map(() => false),
    lastDetail: ""
  };
}

export function createInitialState() {
  return {
    connected: false,
    selectedTestId: TESTS[0]?.id ?? null,
    lastMessage: "Waiting for serial",
    logs: [],
    tests: Object.fromEntries(TESTS.map((test) => [test.id, createTestStatus(test)]))
  };
}

export function createStore(render) {
  let state = createInitialState();

  const setState = (updater) => {
    state = typeof updater === "function" ? updater(state) : updater;
    render(state);
  };

  return {
    getState: () => state,
    setConnected: (connected) => {
      setState((current) => ({ ...current, connected }));
    },
    selectTest: (testId) => {
      setState((current) => ({ ...current, selectedTestId: testId }));
    },
    reset: () => {
      setState(createInitialState());
    },
    addLog: (entry) => {
      setState((current) => ({
        ...current,
        lastMessage: entry.message ?? current.lastMessage,
        logs: [{ ...entry, at: new Date() }, ...current.logs].slice(0, 250)
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
