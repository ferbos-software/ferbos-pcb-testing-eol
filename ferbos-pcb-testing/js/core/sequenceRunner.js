import { buildPayload, evaluateCriteria } from "./testRegistry.js";

const FOLLOW_UP_TIMEOUT_MS = 3000;
// After the response, give trailing events this long to satisfy the remaining criteria.
const SETTLE_MS = 500;

export class SequenceAbortedError extends Error {
  constructor() {
    super("Sequence aborted by operator");
    this.name = "SequenceAbortedError";
  }
}

function combineSignals(signals) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

// Collects firmware events for one test and lets the runner await a specific state.
// The listener is attached before the command is sent so no early event is missed.
function collectEvents(serial, testId) {
  const events = [];
  const listeners = new Set();

  const onRx = (event) => {
    const message = event.detail.message;
    if (message.type !== "event" || message.test !== testId) {
      return;
    }
    events.push(message);
    for (const listener of [...listeners]) {
      listener(message);
    }
  };

  serial.addEventListener("rx", onRx);

  // Runs `listener` for every event of this test until it calls done().
  const subscribe = (build) => {
    const listener = (message) => build.onEvent(message);
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    events,

    /**
     * Waits for one phase of a test.
     *
     * Resolves when `waitFor` arrives. Rejects on timeout, on abort, or as soon as a state in
     * `failOn` arrives -- a board that reports wifi/disconnected is not going to produce got_ip,
     * so waiting out the full timeout only wastes the operator's time. `failGraceMs` keeps a
     * short window open after such an event in case the firmware retries and still succeeds.
     */
    waitForPhase(phase, signal) {
      const { waitFor, timeoutMs, failOn = [], failGraceMs = 0, describeFailure } = phase;

      if (events.some((event) => event.state === waitFor)) {
        return Promise.resolve();
      }
      if (signal.aborted) {
        return Promise.reject(new SequenceAbortedError());
      }

      return new Promise((resolve, reject) => {
        let timer = null;
        let failure = events.find((event) => failOn.includes(event.state)) ?? null;
        let unsubscribe = () => {};

        const cleanup = () => {
          clearTimeout(timer);
          unsubscribe();
          signal.removeEventListener("abort", onAbort);
        };
        const arm = (ms) => {
          clearTimeout(timer);
          timer = setTimeout(onDeadline, ms);
        };

        function onDeadline() {
          cleanup();
          if (failure) {
            reject(new Error(describeFailure
              ? describeFailure(failure)
              : `${testId} ${failure.state}${failure.detail ? `: ${failure.detail}` : ""}`));
            return;
          }
          reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${testId}/${waitFor}`));
        }

        function onAbort() {
          cleanup();
          reject(new SequenceAbortedError());
        }

        unsubscribe = subscribe({
          onEvent: (message) => {
            if (message.state === waitFor) {
              cleanup();
              resolve();
              return;
            }
            if (failOn.includes(message.state)) {
              failure = message;
              if (failGraceMs > 0) {
                arm(failGraceMs);
              } else {
                onDeadline();
              }
            }
          }
        });

        signal.addEventListener("abort", onAbort);
        arm(failure && failGraceMs > 0 ? failGraceMs : timeoutMs);
      });
    },

    // Resolves true as soon as predicate() holds (checked now and on every event), false on timeout/abort.
    waitUntil(predicate, timeoutMs, signal) {
      if (predicate()) {
        return Promise.resolve(true);
      }
      if (signal.aborted) {
        return Promise.resolve(false);
      }

      return new Promise((resolve) => {
        let unsubscribe = () => {};
        const finish = (result) => {
          clearTimeout(timer);
          unsubscribe();
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        };
        const onAbort = () => finish(false);
        const timer = setTimeout(() => finish(false), timeoutMs);

        unsubscribe = subscribe({
          onEvent: () => {
            if (predicate()) {
              finish(true);
            }
          }
        });
        signal.addEventListener("abort", onAbort);
      });
    },

    stop() {
      serial.removeEventListener("rx", onRx);
      listeners.clear();
    }
  };
}

/**
 * Runs tests one after another without operator clicks.
 *
 * @param {object} deps
 * @param {import("./serialClient.js").SerialClient} deps.serial - S3 serial link
 * @param {object} deps.store - state store
 * @param {(entry: object) => void} deps.log - timeline logger
 * @param {Record<string, (inputs: object) => Promise<{ok: boolean, detail: string}>>} [deps.hostChecks] - handlers for tests with hostCheck
 */
export function createSequenceRunner({ serial, store, log, hostChecks = {} }) {
  let abortController = null;
  // Set when the firmware crashes or resets mid-test; ends the current test at once
  // instead of letting it wait out a timeout against a rebooting board.
  let faultController = null;
  let pendingFault = null;

  const isRunning = () => Boolean(abortController);

  /**
   * Reports that the board crashed or restarted. Safe to call at any time; outside a running
   * test it is ignored, and repeated calls during one crash keep only the first cause.
   */
  function reportFault(fault) {
    if (!faultController || faultController.signal.aborted) {
      return;
    }
    pendingFault = fault;
    faultController.abort();
  }

  function describeFault(fault) {
    return fault.type === "crash"
      ? `Firmware crashed and rebooted: ${fault.detail}`
      : `Board reset unexpectedly during the test: ${fault.detail}`;
  }

  async function runHostCheck(test, inputs) {
    const handler = hostChecks[test.hostCheck];
    if (!handler) {
      throw new Error(`No host check handler for ${test.hostCheck}`);
    }
    const result = await handler(inputs);
    log({ kind: result.ok ? "ok" : "error", title: `Check ${test.hostCheck}`, message: result.detail });
    return { type: "host", cmd: test.hostCheck, ok: Boolean(result.ok), detail: result.detail ?? "" };
  }

  async function sendWithRetry(test, payload, signal) {
    const attempts = 1 + (test.retries ?? 0);
    const timeoutMs = payload.timeout_ms ? Number(payload.timeout_ms) + 2000 : (test.timeoutMs || 3000);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      // Retrying into a board that just panicked only wastes the timeout again.
      if (pendingFault) {
        throw new Error(describeFault(pendingFault));
      }
      if (signal.aborted) {
        throw new SequenceAbortedError();
      }
      try {
        return await serial.sendCommand(test.command, payload, timeoutMs);
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          log({ kind: "rx", title: `Retry ${test.command}`, message: `${error.message}. Retrying (${attempt}/${attempts - 1})...` });
        }
      }
    }
    throw lastError;
  }

  async function sendFollowUp(test) {
    if (!test.followUpCommand || !serial.isConnected) {
      return;
    }
    try {
      const response = await serial.sendCommand(test.followUpCommand, {}, FOLLOW_UP_TIMEOUT_MS);
      log({ kind: response.ok ? "ok" : "error", title: `Cleanup ${test.followUpCommand}`, message: response.detail });
    } catch (error) {
      log({ kind: "error", title: `Cleanup ${test.followUpCommand}`, message: error.message });
    }
  }

  async function runTest(test, inputs, sequenceSignal) {
    faultController = new AbortController();
    pendingFault = null;
    const signal = combineSignals([sequenceSignal, faultController.signal]);
    const payload = buildPayload(test, inputs);
    store.updateTest(test.id, {
      state: "running",
      response: null,
      events: [],
      payload,
      criteria: test.criteria.map(() => false),
      lastDetail: "Sending command",
      reason: ""
    });
    store.setSequence({ currentTestId: test.id, hint: test.hint ?? "Running automatically..." });

    const collector = collectEvents(serial, test.id);
    let response = null;
    let reason = "";

    try {
      response = test.hostCheck
        ? await runHostCheck(test, inputs)
        : await sendWithRetry(test, payload, signal);
      store.updateTest(test.id, { response, lastDetail: response.detail ?? "" });

      if (response.ok) {
        for (const phase of test.phases ?? []) {
          store.updateTest(test.id, { state: "waiting" });
          store.setSequence({ hint: phase.hint });
          await collector.waitForPhase(phase, signal);
        }
        const allMet = () => evaluateCriteria(test, { response, events: collector.events, payload }).every(Boolean);
        await collector.waitUntil(allMet, SETTLE_MS, signal);
      } else {
        reason = response.detail ?? "Firmware returned ok=false";
      }
    } catch (error) {
      // A fault explains the failure better than the timeout or abort it surfaced as.
      reason = pendingFault ? describeFault(pendingFault) : error.message;
    } finally {
      collector.stop();
      faultController = null;
      // A rebooting board cannot answer a cleanup command, and asking just adds a timeout.
      if (!pendingFault) {
        await sendFollowUp(test);
      }
    }

    const criteria = evaluateCriteria(test, { response, events: collector.events, payload });
    const passed = criteria.every(Boolean);
    if (!passed && !reason) {
      const firstUnmet = test.criteria.find((_, index) => !criteria[index]);
      reason = firstUnmet ? `Criterion not met: ${firstUnmet.label}` : "Failed";
    }

    store.updateTest(test.id, {
      state: passed ? "passed" : "failed",
      criteria,
      reason: passed ? "" : reason,
      lastDetail: passed ? (response?.detail || "Passed") : reason
    });
    log({
      kind: passed ? "ok" : "error",
      title: `${test.label}`,
      message: passed ? "PASSED" : `FAILED - ${reason}`
    });
    return passed;
  }

  function markSkipped(test, reason) {
    store.updateTest(test.id, { state: "skipped", reason, lastDetail: reason, criteria: test.criteria.map(() => false) });
    log({ kind: "rx", title: test.label, message: `SKIPPED - ${reason}` });
  }

  /**
   * @param {Array} tests - ordered tests to run
   * @param {object} inputs - operator inputs (matched by name into test payloads)
   */
  async function run(tests, inputs) {
    if (isRunning()) {
      throw new Error("A test sequence is already running");
    }

    abortController = new AbortController();
    const { signal } = abortController;

    store.setSequence({
      status: "running",
      currentTestId: null,
      hint: "",
      unitId: inputs.unitId ?? "",
      startedAt: new Date(),
      finishedAt: null
    });
    log({ kind: "tx", title: "Sequence", message: `Started (${tests.length} tests)${inputs.unitId ? ` for unit ${inputs.unitId}` : ""}` });

    let gateFailed = false;
    try {
      for (const test of tests) {
        if (signal.aborted) {
          markSkipped(test, "Sequence aborted");
          continue;
        }
        if (gateFailed) {
          markSkipped(test, "S3 is not responding");
          continue;
        }
        if (test.requiresInput && !inputs[test.requiresInput]) {
          markSkipped(test, test.skipNote ?? `${test.requiresInput} is off for this station`);
          continue;
        }
        const unmetDependency = (test.dependsOn ?? [])
          .map((id) => tests.find((item) => item.id === id))
          .find((dependency) => dependency && store.getState().tests[dependency.id].state !== "passed");
        if (unmetDependency) {
          const dependencyState = store.getState().tests[unmetDependency.id].state;
          markSkipped(test, `${unmetDependency.label} ${dependencyState === "skipped" ? "was skipped" : "did not pass"}`);
          continue;
        }

        const passed = await runTest(test, inputs, signal);
        if (!passed && test.gate) {
          gateFailed = true;
        }
      }
    } finally {
      const status = signal.aborted ? "aborted" : "done";
      abortController = null;
      store.setSequence({ status, currentTestId: null, hint: "", finishedAt: new Date() });

      const results = store.getState().tests;
      const failed = tests.filter((test) => results[test.id].state === "failed");
      const skipped = tests.filter((test) => results[test.id].state === "skipped");
      const names = (list) => list.map((test) => test.label).join(", ");
      const summary = failed.length === 0
        ? `Finished - ALL PASSED${skipped.length ? ` (skipped: ${names(skipped)})` : ""}`
        : `Finished - ${failed.length} FAILED: ${names(failed)}${skipped.length ? ` (skipped: ${names(skipped)})` : ""}`;
      log({
        kind: status === "aborted" ? "error" : failed.length === 0 ? "ok" : "error",
        title: "Sequence",
        message: status === "aborted" ? "Aborted" : summary
      });
    }
  }

  function abort() {
    abortController?.abort();
  }

  return { run, abort, isRunning, reportFault };
}
