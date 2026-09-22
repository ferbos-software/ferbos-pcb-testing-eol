import { createSequenceInputs, createTests } from "../testRegistry.js";

// Plain gateway PCB: S3 + C6, DM9051 Ethernet, RS485 on UART2.
export const gateway = {
  id: "gateway",
  label: "Gateway",
  summary: "ESP32-S3 + ESP32-C6 gateway PCB with DM9051 Ethernet and RS485.",
  boardId: "gateway",
  tests: createTests({ boardId: "gateway", rs485: true }),
  inputs: createSequenceInputs({ rs485: true }),
  firmware: {
    tester: {
      label: "PCB Testing Firmware",
      targets: {
        s3: {
          // The S3 tester moved from a factory partition table to ota_0/ota_1, so it
          // needs ota_data_initial.bin as well; without it the bootloader reads stale
          // bytes left at 0x410000 by the previous layout.
          files: [
            { path: "bootloader.bin", address: 0x0 },
            { path: "partition-table.bin", address: 0x8000 },
            { path: "ferbos-pcb-testing-eol-main.bin", address: 0x10000 },
            { path: "ota_data_initial.bin", address: 0x410000 }
          ]
        },
        c6: {
          // Same OTA layout as the C6 production firmware, so otadata must be reset too.
          // Writing only ota_0 leaves otadata pointing at whichever slot production last
          // booted: the flash succeeds, verifies, and the board keeps running the old app.
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
