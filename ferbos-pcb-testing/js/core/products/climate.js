import { createSequenceInputs, createTests } from "../testRegistry.js";

// Compact Climate PCB: the same S3 + C6 pair as the gateway, but UART2 drives a
// SIM7080G modem instead of RS485, so there is no jig and no RS485 connector test.
//
// The S3<->C6 link is also on different GPIOs here (41/42 rather than 42/40), which
// the EOL tester firmware does not yet know about -- it hardcodes the gateway pins.
// Until a climate build of the tester firmware exists, `firmware` stays null: the
// flash buttons explain that rather than writing gateway firmware to a climate board.
//
// SHT20, the mmWave presence sensor and the GSM modem are the tests still to come.
// They need firmware commands that do not exist yet, so they are deliberately absent
// rather than present and always failing.
export const climate = {
  id: "climate",
  label: "Climate Control",
  summary: "Compact Climate PCB. Sensor and GSM tests arrive with the climate tester firmware.",
  boardId: "climate-control",
  tests: createTests({ boardId: "climate-control", rs485: false }),
  inputs: createSequenceInputs({ rs485: false }),
  firmware: null,
  firmwareNote: "Climate tester and production firmware are not built yet. Flash the board with idf.py for now."
};
