// The WiFi password is sent to the firmware in clear text, but it should not end up in the
// on-screen log or in an exported report that gets archived per unit. The length is kept
// because "did my password actually arrive, and is it the length I typed" is the first thing
// you want to know when a board reports reason=15.

const SECRET_KEYS = new Set(["password"]);

export function maskSecret(value) {
  const length = String(value ?? "").length;
  return length ? `${"*".repeat(Math.min(length, 24))} (${length} chars)` : "(empty)";
}

export function redactPayload(payload) {
  if (!payload) {
    return payload;
  }
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, SECRET_KEYS.has(key) ? maskSecret(value) : value])
  );
}

export function redactLine(line) {
  return String(line ?? "").replace(
    /("password"\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
    // Count the decoded value, so an escaped character is not reported as two.
    (_match, prefix, value) => `${prefix}"${maskSecret(value.replace(/\\(.)/g, "$1"))}"`
  );
}
