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

/**
 * Reads the esp_app_desc_t an ESP-IDF app image carries at offset 0x20.
 *
 * Used to report exactly which build is being written. A stale cached .bin flashes
 * perfectly happily and reports success, and the only way to notice is to compare
 * what was written against the boot banner the board prints afterwards.
 *
 * @returns {{project: string, version: string, built: string, idf: string}|null}
 */
export function readAppDescriptor(data) {
  if (!data || data.length < 0xb0) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0x20, true) !== 0xabcd5432) {
    return null;
  }
  const text = (offset, length) => {
    const bytes = data.subarray(offset, offset + length);
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
  };
  return {
    version: text(0x30, 32),
    project: text(0x50, 32),
    built: `${text(0x80, 16)} ${text(0x70, 16)}`,
    idf: text(0x90, 32)
  };
}

async function loadFirmwareFiles(profile, target) {
  const firmwareProfile = FIRMWARE_PROFILES[profile];
  const targetConfig = firmwareProfile?.targets[target];
  if (!targetConfig) {
    throw new Error(`Firmware ${profile}/${target} belum tersedia`);
  }

  return Promise.all(
    targetConfig.files.map(async (file) => {
      // no-store: a cached .bin flashes and verifies successfully, so a stale one is
      // invisible until the board boots the wrong build.
      const response = await fetch(`./firmware/${profile}/${target}/${file.path}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`${file.path} not found for ${firmwareProfile.label} ${target.toUpperCase()}`);
      }

      return {
        path: file.path,
        data: new Uint8Array(await response.arrayBuffer()),
        address: file.address
      };
    })
  );
}

const TARGET_BY_CHIP_NAME = {
  "ESP32-S3": "s3",
  "ESP32-C6": "c6"
};

/**
 * Reads the base eFuse MAC of whatever ESP32 is on the port, without writing anything.
 *
 * Unlike flashFirmware this never calls loader.main(): it stops after chip detection, so no
 * stub is uploaded and the flash is never touched. Use it to recover the sticker MAC from a
 * board that is already running production firmware. The board is hard reset afterwards, so it
 * boots straight back into the application.
 *
 * @param {SerialPort} port - The Web Serial Port object
 * @param {Function} onLog - Callback for terminal log: (data) => void
 * @returns {Promise<{chipName: string, macAddress: string, target: string|null}>}
 */
export async function readDeviceMac(port, onLog) {
  let transport;

  try {
    transport = new Transport(port);
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      debugLogging: false,
      terminal: {
        clean: () => {},
        writeLine: (data) => writeLog(onLog, data, true),
        write: (data) => writeLog(onLog, data)
      }
    });

    await loader.detectChip("default_reset");
    const chipName = await loader.chip.getChipDescription(loader);
    const macAddress = await loader.chip.readMac(loader);
    writeLog(onLog, `MAC: ${macAddress}`, true);

    try {
      await loader.after("hard_reset");
    } catch (resetError) {
      writeLog(onLog, `Automatic reset failed. Press RESET on the board to run the firmware again. (${resetError.message ?? resetError})`, true);
    }

    return {
      chipName,
      macAddress,
      target: TARGET_BY_CHIP_NAME[Object.keys(TARGET_BY_CHIP_NAME).find((name) => chipName?.toUpperCase().includes(name)) ?? ""] ?? null
    };
  } finally {
    if (transport) {
      try {
        await transport.disconnect();
      } catch (disconnectError) {
        console.warn("Gagal disconnect transport setelah baca MAC:", disconnectError);
      }
    }
  }
}

/**
 * Flashes ESP32-S3 and ESP32-C6 firmware using esptool-js
 *
 * @param {SerialPort} port - The Web Serial Port object
 * @param {String} target - The chip target ('s3' or 'c6')
 * @param {Function} onProgress - Callback for progress: (fileIndex, percentage) => void
 * @param {Function} onLog - Callback for terminal log: (data) => void
 * @param {Object} options - Optional flash controls
 * @param {Function} [options.onIdentity] - Called with { chipName, macAddress } as soon as the chip
 *   is identified, before any write. Fires even if the flash later fails, so the operator still
 *   gets the MAC for the sticker.
 */
export async function flashFirmware(port, target, onProgress, onLog, options = {}) {
  let transport;
  let manualResetRequired = false;

  try {
    const profile = options.profile ?? "tester";
    const fileArray = await loadFirmwareFiles(profile, target);

    const appFile = fileArray.find((file) => readAppDescriptor(file.data));
    const appDescriptor = appFile ? readAppDescriptor(appFile.data) : null;
    if (appDescriptor) {
      writeLog(onLog, `Writing ${appDescriptor.project} ${appDescriptor.version} (built ${appDescriptor.built}, IDF ${appDescriptor.idf})`, true);
    }
    for (const file of fileArray) {
      writeLog(onLog, `  ${file.path} -> 0x${file.address.toString(16)} (${file.data.length} bytes)`, true);
    }

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

    // Base eFuse MAC. Both firmware projects use four universal MAC addresses, so this is
    // exactly what esp_read_mac(ESP_MAC_WIFI_STA) returns on the device: the gateway identity.
    let macAddress = null;
    try {
      macAddress = await loader.chip.readMac(loader);
    } catch (macError) {
      writeLog(onLog, `Could not read MAC address: ${macError.message ?? macError}`, true);
    }
    options.onIdentity?.({ chipName, macAddress });

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

    return { manualResetRequired, chipName, macAddress, appDescriptor };
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
