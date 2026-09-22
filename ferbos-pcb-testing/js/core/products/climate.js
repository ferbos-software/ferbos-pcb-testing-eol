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
// The climate tester firmware is built from the same project as the gateway one, with
// -D EOL_BOARD=climate. Its host link is USB-Serial-JTAG rather than UART0, so the
// operator picks the S3's native USB port here, not a UART bridge.
export const climate = {
  id: "climate",
  label: "Climate Control",
  summary: "Compact Climate PCB with SHT20, LD2412 mmWave and a SIM7080G modem header.",
  boardId: "climate-control",
  tests: createTests({ boardId: "climate-control", rs485: false, gsm: true, sensors: true }),
  inputs: createSequenceInputs({ rs485: false, gsm: true }),
  // One port only: no RS485 jig on this board, and the host link is the S3's native
  // USB rather than a bridge, so the picker shows a different kind of device.
  ports: [
    { key: "main", label: "ESP32-S3 climate board", note: "the board's native USB (USB-Serial-JTAG), not a UART bridge" }
  ],
  firmware: {
    tester: {
      label: "PCB Testing Firmware",
      targets: {
        s3: {
          files: [
            { path: "bootloader.bin", address: 0x0 },
            { path: "partition-table.bin", address: 0x8000 },
            { path: "ferbos-pcb-testing-eol-main.bin", address: 0x10000 },
            { path: "ota_data_initial.bin", address: 0x410000 }
          ]
        },
        // The C6 sits on its own GPIO 16/17 on both PCBs, so its firmware is the same
        // binary the gateway uses.
        c6: {
          files: [
            { path: "bootloader.bin", address: 0x0 },
            { path: "partition-table.bin", address: 0x8000 },
            { path: "ferbos-pcb-testing-eol-zigbee.bin", address: 0x10000 },
            { path: "ota_data_initial.bin", address: 0x2ce000 }
          ]
        }
      }
    },
    production: {
      label: "Production Firmware",
      targets: {
        s3: {
          files: [
            { path: "bootloader.bin", address: 0x0 },
            { path: "partition-table.bin", address: 0x8000 },
            { path: "ota_data_initial.bin", address: 0x29000 },
            { path: "ferbos-gateway-main.bin", address: 0x30000 }
          ]
        },
        c6: {
          files: [
            { path: "bootloader.bin", address: 0x0 },
            { path: "partition-table.bin", address: 0x8000 },
            { path: "ferbos-zigbee-gateway.bin", address: 0x10000 },
            { path: "ota_data_initial.bin", address: 0x2ce000 }
          ]
        }
      }
    }
  }
};
