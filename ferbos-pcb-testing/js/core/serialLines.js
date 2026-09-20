// Classification of non-JSON serial output.
//
// The tester firmware speaks newline-delimited JSON, but the same UART also carries ESP_LOG
// output, ROM bootloader chatter, and panic handler dumps. Treating all of it as one
// undifferentiated blob either buries a crash or paints a healthy boot red.

const ESP_LOG_KINDS = { E: "error", W: "warn", I: "rx", D: "rx", V: "rx" };

// Lines that mean the firmware died. The first match is reported as the cause.
const CRASH_PATTERNS = [
  /^assert failed:.*/,
  /Guru Meditation Error:.*/,
  /^abort\(\) was called at PC.*/,
  /^Stack canary watchpoint triggered.*/,
  /watchdog.*triggered/i
];

// Lines that mean it restarted. Seen without a crash line, these still indicate a reset.
const REBOOT_PATTERNS = [
  /^Rebooting\.\.\./,
  /^ESP-ROM:esp32/,
  /^rst:0x[0-9a-f]+\s*\(/i
];

export function classifyPlainLine(line) {
  const level = /^([EWIDV]) \(\d+\)/.exec(line ?? "")?.[1];
  if (level) {
    return { kind: ESP_LOG_KINDS[level], tag: "LOG", title: "Firmware log" };
  }
  if (detectFirmwareFault(line)) {
    return { kind: "error", tag: "!!", title: "Firmware fault" };
  }
  return { kind: "rx", tag: "RAW", title: "Serial" };
}

/**
 * @returns {{type: "crash"|"reboot", detail: string}|null}
 */
export function detectFirmwareFault(line) {
  const text = String(line ?? "").trim();
  if (!text) {
    return null;
  }

  for (const pattern of CRASH_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { type: "crash", detail: match[0].trim() };
    }
  }
  for (const pattern of REBOOT_PATTERNS) {
    if (pattern.test(text)) {
      return { type: "reboot", detail: text };
    }
  }
  return null;
}
