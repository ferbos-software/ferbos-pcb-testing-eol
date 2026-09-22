// Inputs the operator fills once before starting the automatic sequence.
// Values are matched by name against test parameters (e.g. ssid/password).
export function createSequenceInputs({ rs485 = false, gsm = false } = {}) {
  const inputs = [
    { name: "unitId", label: "PCB Serial / Unit ID", value: "", placeholder: "optional, tags the exported log" },
    { name: "ssid", label: "WiFi SSID", value: "FactoryAP" },
    { name: "password", label: "WiFi Password", value: "", type: "password" }
  ];
  if (rs485) {
    inputs.push({ name: "rs485Enabled", label: "RS485 jig connected on this station", value: true, type: "checkbox" });
  }
  if (gsm) {
    inputs.push({ name: "gsmLoopback", label: "GSM header TX-RX jumper fitted", value: true, type: "checkbox" });
  }
  return inputs;
}

const hasEvent = (events, test, state) => events.some((event) => event.test === test && event.state === state);

// ESP-IDF wifi_err_reason_t, limited to the codes an EOL station actually hits.
// The operator needs to know whether to fix the password, the antenna, or the AP.
const WIFI_DISCONNECT_REASONS = {
  2: "authentication expired",
  4: "association expired",
  5: "AP has too many clients",
  15: "wrong WiFi password (4-way handshake timed out)",
  16: "group key update timed out",
  17: "wrong password or mismatched security settings",
  23: "802.1X authentication failed",
  200: "beacon timeout, AP signal lost",
  201: "SSID not found — check the SSID and that the AP is in range",
  202: "authentication failed — check the password",
  203: "association failed",
  204: "handshake timed out",
  205: "connection failed",
  208: "no AP found with compatible security"
};

export function explainWifiDisconnect(detail) {
  const code = Number(/reason=(\d+)/.exec(detail ?? "")?.[1]);
  const reason = WIFI_DISCONNECT_REASONS[code];
  if (!Number.isFinite(code)) {
    return detail || "wifi disconnected";
  }
  return reason ? `${reason} (reason=${code})` : `wifi disconnected (reason=${code})`;
}

// Each test:
// - command/parameters: JSON sent to S3. Parameter values are overridden by SEQUENCE_INPUTS of the same name.
// - phases: async events to wait for after the response, in order. Each phase shows a hint to the operator
//   and fails the test if the event does not arrive within timeoutMs.
// - followUpCommand: always sent after the phases finish (pass, fail, or abort) to put the board back in idle.
// - criteria: individually checked; the test passes only when every criterion is met.
// - gate: when this test fails, the remaining tests are skipped (board is not responding at all).
// - requiresInput: skipped when that operator input is off, e.g. an accessory this
//   station does not have fitted. Pair it with skipNote to say so in the report.
// - optional: skipping it does not stop the run reading PASS overall.
// - hostCheck: run on the PC instead of sending a command to S3 (the runner is given a matching handler).
// - dependsOn: skipped unless every listed test passed earlier in the same run.
export const jigTest = {
  id: "jig",
  label: "RS485 Jig Check",
  summary: "Check that the USB-RS485 jig adapter on this station is connected before testing.",
  hostCheck: "jig",
  requiresInput: "rs485Enabled",
  optional: true,
  skipNote: "RS485 jig disabled on this station",
  parameters: [],
  criteria: [
    { label: "Jig serial port is open", check: ({ response }) => Boolean(response?.ok) }
  ]
};

export const pingTest = {
  id: "ping",
  label: "S3 Firmware Alive",
  summary: "Check S3 firmware, serial RX/TX, and command parser.",
  command: "ping",
  timeoutMs: 3000,
  retries: 2,
  gate: true,
  parameters: [],
  criteria: [
    { label: "A response message is received", check: ({ response }) => Boolean(response) },
    { label: "id and cmd match the request", check: ({ response }) => response?.cmd === "ping" },
    { label: "ok is true", check: ({ response }) => Boolean(response?.ok) }
  ]
};

export const infoTest = {
  id: "info",
  label: "S3 Runtime Info",
  summary: "Read chip_model, core count, and free_heap for initial identification.",
  command: "info",
  timeoutMs: 3000,
  parameters: [],
  criteria: [
    { label: "Response ok is true", check: ({ response }) => Boolean(response?.ok) },
    { label: "detail contains chip_model", check: ({ response }) => (response?.detail ?? "").includes("chip_model") },
    {
      label: "detail contains cores and free_heap",
      check: ({ response }) => {
        const detail = response?.detail ?? "";
        return detail.includes("cores") && detail.includes("free_heap");
      }
    }
  ]
};

export const c6Test = {
  id: "c6",
  label: "C6 Firmware + UART",
  summary: "Send an echo payload to C6 through S3 and validate processed_by metadata.",
  command: "c6_ping",
  timeoutMs: 2500,
  parameters: [
    { name: "payload", label: "Payload", value: "hello-c6" },
    { name: "timeout_ms", label: "Firmware timeout ms", value: "1000", type: "number" }
  ],
  criteria: [
    { label: "Final response ok is true", check: ({ response }) => Boolean(response?.ok) },
    { label: "detail contains processed_by=c6-zigbee", check: ({ response }) => (response?.detail ?? "").includes("processed_by=c6-zigbee") },
    { label: "c6 rx_ok event is received", check: ({ events }) => hasEvent(events, "c6", "rx_ok") }
  ]
};

export const ethernetTest = {
  id: "ethernet",
  label: "Ethernet DM9051",
  summary: "Start Ethernet, wait for link up, DHCP got_ip, then link down.",
  command: "eth_start",
  timeoutMs: 3000,
  followUpCommand: "eth_stop",
  parameters: [],
  phases: [
    { waitFor: "link_up", hint: "Plug the Ethernet cable into the PCB", timeoutMs: 60000 },
    { waitFor: "got_ip", hint: "Cable detected. Waiting for DHCP IP...", timeoutMs: 30000 },
    { waitFor: "link_down", hint: "IP received. Unplug the Ethernet cable now", timeoutMs: 60000 }
  ],
  criteria: [
    { label: "eth_start response ok true", check: ({ response }) => Boolean(response?.ok) },
    { label: "ethernet link_up event is received", check: ({ events }) => hasEvent(events, "ethernet", "link_up") },
    { label: "ethernet got_ip event is received", check: ({ events }) => hasEvent(events, "ethernet", "got_ip") },
    { label: "ethernet link_down event is received", check: ({ events }) => hasEvent(events, "ethernet", "link_down") }
  ]
};

export const wifiTest = {
  id: "wifi",
  label: "WiFi STA",
  summary: "Connect WiFi using the operator SSID/password and wait for the got_ip event.",
  command: "wifi_connect",
  timeoutMs: 3000,
  followUpCommand: "wifi_stop",
  parameters: [
    { name: "ssid", label: "SSID", value: "FactoryAP" },
    { name: "password", label: "Password", value: "", type: "password" }
  ],
  phases: [
    {
      waitFor: "got_ip",
      hint: "Connecting to WiFi, waiting for IP...",
      timeoutMs: 60000,
      // A disconnect means this attempt is over; the grace window covers a firmware retry.
      failOn: ["disconnected"],
      failGraceMs: 5000,
      describeFailure: (event) => `WiFi could not connect: ${explainWifiDisconnect(event.detail)}`
    }
  ],
  criteria: [
    { label: "wifi_connect response ok true", check: ({ response }) => Boolean(response?.ok) },
    { label: "wifi got_ip event is received", check: ({ events }) => hasEvent(events, "wifi", "got_ip") }
  ]
};

export const rs485Test = {
  id: "rs485",
  label: "RS485 Connector",
  summary: "Send a raw payload to RS485 and wait for one reply line from the jig.",
  command: "rs485_exchange",
  timeoutMs: 2500,
  requiresInput: "rs485Enabled",
  optional: true,
  skipNote: "RS485 jig disabled on this station",
  dependsOn: ["jig"],
  parameters: [
    { name: "payload", label: "TX payload", value: "EOL_RS485_PING" },
    { name: "timeout_ms", label: "Firmware timeout ms", value: "1000", type: "number" }
  ],
  criteria: [
    { label: "Response ok true", check: ({ response }) => Boolean(response?.ok) },
    { label: "rs485 rx event is received", check: ({ events }) => hasEvent(events, "rs485", "rx") },
    {
      label: "detail contains tx and rx",
      check: ({ response }) => {
        const detail = response?.detail ?? "";
        return detail.includes("tx=") && detail.includes("rx=");
      }
    }
  ]
};

// Reads temperature and humidity over I2C. The firmware decides in_range, so the host
// does not duplicate the bounds: the thresholds belong next to the datasheet
// conversions. What matters at EOL is that the part is fitted, ACKs at 0x40, passes
// CRC and reads plausibly -- a dry joint on SDA or SCL shows up as a transmit error,
// and a part that is present but dead returns a constant the range check rejects.
export const sht20Test = {
  id: "sht20",
  label: "SHT20 Temp/Humidity",
  summary: "Read the SHT20 over I2C and check the values are physically plausible.",
  command: "sht20_read",
  timeoutMs: 3000,
  parameters: [],
  criteria: [
    { label: "Response ok true", check: ({ response }) => Boolean(response?.ok) },
    { label: "sht20 reading event is received", check: ({ events }) => hasEvent(events, "sht20", "reading") },
    { label: "temperature and humidity are in range", check: ({ response }) => (response?.detail ?? "").includes("in_range=yes") }
  ]
};

// The LD2412 streams REPORT frames continuously once powered, so catching one proves
// the module is alive, on the right baud and wired to the right pins -- without asking
// anyone to walk in front of the sensor, which a presence test would need and which is
// far too slow and flaky for a line.
export const ld2412Test = {
  id: "ld2412",
  label: "LD2412 mmWave",
  summary: "Wait for one complete LD2412 REPORT frame on UART0.",
  command: "ld2412_probe",
  timeoutMs: 4000,
  parameters: [
    { name: "timeout_ms", label: "Firmware timeout ms", value: "2000", type: "number" }
  ],
  criteria: [
    { label: "Response ok true", check: ({ response }) => Boolean(response?.ok) },
    { label: "ld2412 frame event is received", check: ({ events }) => hasEvent(events, "ld2412", "frame") },
    { label: "a well-formed REPORT frame was read", check: ({ response }) => (response?.detail ?? "").includes("report frame ok") }
  ]
};

// Climate wires UART2 to the SIM7080G instead of RS485. A jumper across the header's
// TX and RX turns the modem connector into a loopback, which proves the S3's UART2
// path and the board traces up to the header without needing a modem fitted or a
// network to be in range. An exact echo is the whole test: anything else means a
// broken trace, a swapped pair, or the wrong pins.
export const gsmLoopbackTest = {
  id: "gsm",
  label: "GSM UART Loopback",
  summary: "With the GSM header TX-RX jumper fitted, send a payload on UART2 and read it back.",
  command: "gsm_loopback",
  timeoutMs: 2500,
  requiresInput: "gsmLoopback",
  optional: true,
  skipNote: "GSM loopback jumper not fitted on this station",
  parameters: [
    { name: "payload", label: "TX payload", value: "EOL_GSM_LOOPBACK" },
    { name: "timeout_ms", label: "Firmware timeout ms", value: "1000", type: "number" }
  ],
  criteria: [
    { label: "Response ok true", check: ({ response }) => Boolean(response?.ok) },
    { label: "gsm rx event is received", check: ({ events }) => hasEvent(events, "gsm", "rx") },
    {
      label: "received payload matches what was sent",
      check: ({ response, payload }) => {
        const echoed = /rx=(\S*)/.exec(response?.detail ?? "")?.[1];
        return Boolean(echoed) && echoed === payload?.payload;
      }
    }
  ]
};

/**
 * The ordered test list for one product.
 *
 * Boards differ in what is physically present, not in how a test behaves, so the
 * definitions above are shared and each product picks from them. The climate board
 * wires UART2 to the GSM modem instead of RS485, so it has neither the jig check nor
 * the RS485 connector test.
 *
 * @param {{boardId: string, rs485?: boolean}} options
 */
export function createTests({ boardId, rs485 = false, gsm = false, sensors = false }) {
  const tests = [];
  if (rs485) tests.push(jigTest);
  tests.push(pingTest, createInfoTest(boardId), c6Test);
  // Sensors run before the network tests: they are instant and need no operator, so a
  // board with a dead sensor fails in seconds instead of after two minutes of plugging
  // and unplugging cables.
  if (sensors) tests.push(sht20Test, ld2412Test);
  tests.push(ethernetTest, wifiTest);
  if (rs485) tests.push(rs485Test);
  if (gsm) tests.push(gsmLoopbackTest);
  return tests;
}

/**
 * Adds a board-identity criterion to the info test.
 *
 * Flashing the wrong product's firmware is the failure this guards against, and no UI
 * can catch it -- only the board can say what it is. Firmware that does not report
 * `board=` yet still passes, so this is safe to ship before the firmware side exists;
 * once it does, a mismatch fails here instead of surfacing as puzzling failures
 * further down the run.
 */
export function createInfoTest(boardId) {
  return {
    ...infoTest,
    criteria: [
      ...infoTest.criteria,
      {
        label: `board is ${boardId}, when the firmware reports one`,
        check: ({ response }) => {
          const reported = /board=([\w.-]+)/.exec(response?.detail ?? "")?.[1];
          return !reported || reported === boardId;
        }
      }
    ]
  };
}

export function evaluateCriteria(test, context) {
  return test.criteria.map((criterion) => {
    try {
      return Boolean(criterion.check(context));
    } catch {
      return false;
    }
  });
}

export function buildPayload(test, inputs = {}) {
  const payload = {};
  for (const parameter of test.parameters) {
    const value = inputs[parameter.name] ?? parameter.value ?? "";
    payload[parameter.name] = parameter.type === "number" ? Number(value) : value;
  }
  return payload;
}
