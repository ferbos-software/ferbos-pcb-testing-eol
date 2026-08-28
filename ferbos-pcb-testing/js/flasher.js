import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.6.1/bundle.js";

export class ManualBootRequiredError extends Error {
  constructor(cause) {
    super("Auto reset failed. Manual bootloader mode is required.");
    this.name = "ManualBootRequiredError";
    this.cause = cause;
  }
}

const EXPECTED_CHIP_NAMES = {
  s3: "ESP32-S3",
  c6: "ESP32-C6"
};

const FIRMWARE_PROFILES = {
  tester: {
    label: "PCB Testing Firmware",
    targets: {
      s3: {
        files: [
          { path: "bootloader.bin", address: 0x0 },
          { path: "partition-table.bin", address: 0x8000 },
          { path: "ferbos-pcb-testing-eol-main.bin", address: 0x10000 }
        ]
      },
      c6: {
        files: [
          { path: "bootloader.bin", address: 0x0 },
          { path: "partition-table.bin", address: 0x8000 },
          { path: "ferbos-pcb-testing-eol-zigbee.bin", address: 0x10000 }
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
};

function writeLog(onLog, data, trailingNewline = false) {
  const message = trailingNewline ? `${data}\n` : data;
  if (onLog) onLog(message);
  else console.log(message);
}

function assertExpectedChip(target, chipName) {
  const expectedChip = EXPECTED_CHIP_NAMES[target];
  if (!expectedChip) {
    throw new Error(`Target firmware tidak dikenal: ${target}`);
  }

  if (!chipName || !chipName.toUpperCase().includes(expectedChip)) {
    throw new Error(`Chip terdeteksi ${chipName || "unknown"}, tetapi target flash adalah ${expectedChip}`);
  }
}

function needsManualBoot(error) {
  const message = `${error?.message ?? error}`;
  return message.includes("setSignals") || message.includes("Failed to set control signals");
}

async function loadFirmwareFiles(profile, target) {
  const firmwareProfile = FIRMWARE_PROFILES[profile];
  const targetConfig = firmwareProfile?.targets[target];
  if (!targetConfig) {
    throw new Error(`Firmware ${profile}/${target} belum tersedia`);
  }

  return Promise.all(
    targetConfig.files.map(async (file) => {
      const response = await fetch(`./firmware/${profile}/${target}/${file.path}`);
      if (!response.ok) {
        throw new Error(`${file.path} not found for ${firmwareProfile.label} ${target.toUpperCase()}`);
      }

      return {
        data: new Uint8Array(await response.arrayBuffer()),
        address: file.address
      };
    })
  );
}

/**
 * Flashes ESP32-S3 and ESP32-C6 firmware using esptool-js
 *
 * @param {SerialPort} port - The Web Serial Port object
 * @param {String} target - The chip target ('s3' or 'c6')
 * @param {Function} onProgress - Callback for progress: (fileIndex, percentage) => void
 * @param {Function} onLog - Callback for terminal log: (data) => void
 * @param {Object} options - Optional flash controls
 */
export async function flashFirmware(port, target, onProgress, onLog, options = {}) {
  let transport;
  let manualResetRequired = false;

  try {
    const profile = options.profile ?? "tester";
    const fileArray = await loadFirmwareFiles(profile, target);

    // 3. Konfigurasi Transport
    // Kita bypass inisiasi manual port karena Transport biasanya mengatur koneksinya.
    transport = new Transport(port);
    const flashOptions = {
      transport: transport,
      baudrate: 460800,
      debugLogging: false,
      terminal: {
        clean: () => {},
        writeLine: (data) => writeLog(onLog, data, true),
        write: (data) => writeLog(onLog, data)
      }
    };

    // 4. Inisiasi loader dan sambungkan
    const loader = new ESPLoader(flashOptions);
    const resetMode = options.resetMode ?? "default_reset";
    const chipName = await loader.main(resetMode);
    assertExpectedChip(target, chipName);

    // 5. Eksekusi flashing
    await loader.writeFlash({
      fileArray,
      flashSize: 'keep',
      flashMode: 'dio',
      flashFreq: '80m',
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) => {
        const percentage = Math.round((written / total) * 100);
        if (onProgress) {
          onProgress(fileIndex, percentage);
        }
      }
    });

    writeLog(onLog, "Flashing selesai! Hard resetting...", true);
    
    // 6. Hard reset chip agar booting ke aplikasi
    if (options.resetAfter !== false) {
      try {
        await loader.after("hard_reset");
      } catch (resetError) {
        if (!needsManualBoot(resetError)) {
          throw resetError;
        }
        manualResetRequired = true;
        writeLog(onLog, "Automatic reset failed after flashing. Press RESET on the board manually.", true);
      }
    }

    return { manualResetRequired };
  } catch (err) {
    console.error("Error saat flashing:", err);
    if (needsManualBoot(err) && options.resetMode !== "no_reset") {
      throw new ManualBootRequiredError(err);
    }
    throw err;
  } finally {
    if (transport) {
      try {
        await transport.disconnect();
      } catch (disconnectError) {
        console.warn("Gagal disconnect transport setelah flashing:", disconnectError);
      }
    }
  }
}
