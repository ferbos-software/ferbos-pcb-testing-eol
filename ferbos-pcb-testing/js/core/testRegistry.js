export const TESTS = [
  {
    id: "ping",
    label: "S3 Firmware Alive",
    summary: "Cek firmware S3, serial RX/TX, dan parser command.",
    command: "ping",
    timeoutMs: 3000,
    parameters: [],
    criteria: [
      "Response type response diterima",
      "id dan cmd sesuai request",
      "ok bernilai true"
    ],
    pass: ({ response }) => Boolean(response?.ok)
  },
  {
    id: "info",
    label: "S3 Runtime Info",
    summary: "Baca chip_model, jumlah core, dan free_heap untuk identitas awal.",
    command: "info",
    timeoutMs: 3000,
    parameters: [],
    criteria: [
      "Response ok true",
      "detail memuat chip_model",
      "detail memuat cores dan free_heap"
    ],
    pass: ({ response }) => {
      const detail = response?.detail ?? "";
      return Boolean(response?.ok && detail.includes("chip_model") && detail.includes("cores") && detail.includes("free_heap"));
    }
  },
  {
    id: "c6",
    label: "C6 Firmware + UART",
    summary: "Kirim echo ke C6 lewat S3 dan validasi metadata processed_by.",
    command: "c6_ping",
    timeoutMs: 2500,
    parameters: [
      { name: "payload", label: "Payload", value: "hello-c6" },
      { name: "timeout_ms", label: "Firmware timeout ms", value: "1000", type: "number" }
    ],
    criteria: [
      "Response akhir ok true",
      "detail memuat processed_by=c6-zigbee",
      "Event c6 rx_ok diterima"
    ],
    pass: ({ response, events }) => {
      const detail = response?.detail ?? "";
      return Boolean(response?.ok && detail.includes("processed_by=c6-zigbee") && events.some((event) => event.test === "c6" && event.state === "rx_ok"));
    }
  },
  {
    id: "ethernet",
    label: "Ethernet DM9051",
    summary: "Start Ethernet, tunggu link up, DHCP got_ip, lalu link down.",
    command: "eth_start",
    timeoutMs: 3000,
    followUpCommand: "eth_stop",
    parameters: [],
    criteria: [
      "eth_start response ok true",
      "event ethernet link_up diterima",
      "event ethernet got_ip diterima",
      "event ethernet link_down diterima"
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
    summary: "Connect WiFi dengan SSID/password operator dan tunggu event got_ip.",
    command: "wifi_connect",
    timeoutMs: 3000,
    followUpCommand: "wifi_stop",
    parameters: [
      { name: "ssid", label: "SSID", value: "FactoryAP" },
      { name: "password", label: "Password", value: "", type: "password" }
    ],
    criteria: [
      "wifi_connect response ok true",
      "event wifi connecting diterima",
      "event wifi got_ip diterima"
    ],
    pass: ({ response, events }) => {
      const has = (state) => events.some((event) => event.test === "wifi" && event.state === state);
      return Boolean(response?.ok && has("got_ip"));
    },
    waitingStates: ["got_ip"]
  },
  {
    id: "ble",
    label: "BLE Start + Echo",
    summary: "Start BLE dan kirim echo payload. Disabled SDKConfig ditandai sebagai blocked, bukan hardware fail.",
    command: "ble_start",
    timeoutMs: 3000,
    chainedCommands: [
      {
        command: "ble_echo",
        parameters: [
          { name: "payload", source: "payload" }
        ]
      }
    ],
    followUpCommand: "ble_stop",
    parameters: [
      { name: "payload", label: "Echo payload", value: "hello-ble" }
    ],
    criteria: [
      "ble_start response ok true",
      "ble_echo response ok true",
      "detail echo memuat payload"
    ],
    pass: ({ response, chainedResponses, payload }) => {
      const echo = chainedResponses.find((item) => item.cmd === "ble_echo");
      return Boolean(response?.ok && echo?.ok && (echo.detail ?? "").includes(payload.payload));
    },
    blocked: ({ response }) => (response?.detail ?? "").includes("disabled_by_sdkconfig")
  },
  {
    id: "rs485",
    label: "RS485 Connector",
    summary: "Kirim payload raw ke RS485 dan tunggu satu line balasan dari jig.",
    command: "rs485_exchange",
    timeoutMs: 2500,
    parameters: [
      { name: "payload", label: "TX payload", value: "EOL_RS485_PING" },
      { name: "timeout_ms", label: "Firmware timeout ms", value: "1000", type: "number" }
    ],
    criteria: [
      "Response ok true",
      "event rs485 rx diterima",
      "detail memuat tx dan rx"
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
