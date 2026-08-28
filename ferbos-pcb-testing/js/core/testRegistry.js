export const TESTS = [
  {
    id: "ping",
    label: "S3 Firmware Alive",
    summary: "Check S3 firmware, serial RX/TX, and command parser.",
    command: "ping",
    timeoutMs: 3000,
    parameters: [],
    criteria: [
      "A response message is received",
      "id and cmd match the request",
      "ok is true"
    ],
    pass: ({ response }) => Boolean(response?.ok)
  },
  {
    id: "info",
    label: "S3 Runtime Info",
    summary: "Read chip_model, core count, and free_heap for initial identification.",
    command: "info",
    timeoutMs: 3000,
    parameters: [],
    criteria: [
      "Response ok is true",
      "detail contains chip_model",
      "detail contains cores and free_heap"
    ],
    pass: ({ response }) => {
      const detail = response?.detail ?? "";
      return Boolean(response?.ok && detail.includes("chip_model") && detail.includes("cores") && detail.includes("free_heap"));
    }
  },
  {
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
      "Final response ok is true",
      "detail contains processed_by=c6-zigbee",
      "c6 rx_ok event is received"
    ],
    pass: ({ response, events }) => {
      const detail = response?.detail ?? "";
      return Boolean(response?.ok && detail.includes("processed_by=c6-zigbee") && events.some((event) => event.test === "c6" && event.state === "rx_ok"));
    }
  },
  {
    id: "ethernet",
    label: "Ethernet DM9051",
    summary: "Start Ethernet, wait for link up, DHCP got_ip, then link down.",
    command: "eth_start",
    timeoutMs: 3000,
    followUpCommand: "eth_stop",
    manualDone: true,
    parameters: [],
    criteria: [
      "eth_start response ok true",
      "ethernet link_up event is received",
      "ethernet got_ip event is received",
      "ethernet link_down event is received"
    ],
    pass: ({ response, events }) => {
      const has = (state) => events.some((event) => event.test === "ethernet" && event.state === state);
      return Boolean(response?.ok && has("link_up") && has("got_ip") && has("link_down"));
    },
    waitingStates: ["link_up", "got_ip", "link_down"]
  },
  {
    id: "wifi",
    label: "WiFi STA",
    summary: "Connect WiFi using the operator SSID/password and wait for the got_ip event.",
    command: "wifi_connect",
    timeoutMs: 3000,
    followUpCommand: "wifi_stop",
    manualDone: true,
    parameters: [
      { name: "ssid", label: "SSID", value: "FactoryAP" },
      { name: "password", label: "Password", value: "", type: "password" }
    ],
    criteria: [
      "wifi_connect response ok true",
      "wifi connecting event is received",
      "wifi got_ip event is received"
    ],
    pass: ({ response, events }) => {
      const has = (state) => events.some((event) => event.test === "wifi" && event.state === state);
      return Boolean(response?.ok && has("got_ip"));
    },
    waitingStates: ["got_ip"]
  },
  {
    id: "rs485",
    label: "RS485 Connector",
    summary: "Send a raw payload to RS485 and wait for one reply line from the jig.",
    command: "rs485_exchange",
    timeoutMs: 2500,
    parameters: [
      { name: "payload", label: "TX payload", value: "EOL_RS485_PING" },
      { name: "timeout_ms", label: "Firmware timeout ms", value: "1000", type: "number" }
    ],
    criteria: [
      "Response ok true",
      "rs485 rx event is received",
      "detail contains tx and rx"
    ],
    pass: ({ response, events }) => {
      const detail = response?.detail ?? "";
      return Boolean(response?.ok && detail.includes("tx=") && detail.includes("rx=") && events.some((event) => event.test === "rs485" && event.state === "rx"));
    }
  }
];

export function getTestById(id) {
  return TESTS.find((test) => test.id === id);
}
