import { createSequenceInputs, createTests } from "../testRegistry.js";

// Compact Climate PCB. Hardware map from the production firmware
// (ferbos-gateway-main/components/climate_control/CMakeLists.txt):
//
//   SHT20    I2C0 @100kHz, addr 0x40, SDA 16 / SCL 15
//   LD2412   UART0 @115200, RX 4 / TX 5      (mmWave presence)
//   SIM7080G UART2 @115200, TX 17 / RX 18, RESET 21
//   S3<->C6  UART1, 41/42                    (gateway uses 42/40)
//   IR LED   GPIO 7
//
// UART0 carries the mmWave sensor here, not a console: this board's console runs
// over USB-Serial-JTAG. That matters for the tester firmware, which currently uses
// UART0 as its host link -- on a climate board that pin pair is the LD2412, so the
// climate tester has to talk to the host over USB-Serial-JTAG instead.
//
// There is no RS485: UART2 drives the modem. The GSM connector is tested as a
// loopback instead, which needs only a jumper rather than a jig adapter.
//
// SHT20 and LD2412 tests are still to come; they need firmware commands that do not
// exist yet, so they are absent rather than present and always failing.
export const climate = {
  id: "climate",
  label: "Climate Control",
  summary: "Compact Climate PCB. SHT20 and mmWave tests arrive with the climate tester firmware.",
  boardId: "climate-control",
  tests: createTests({ boardId: "climate-control", rs485: false, gsm: true }),
  inputs: createSequenceInputs({ rs485: false, gsm: true }),
  firmware: null,
  firmwareNote: "Climate tester and production firmware are not built yet. Flash the board with idf.py for now."
};
