import { readFileSync } from "node:fs";

export const ROOT = new URL("../ferbos-pcb-testing/", import.meta.url).pathname;

/** Reads the esp_app_desc_t an ESP-IDF app image carries at 0x20, or null. */
export function appDescriptor(path) {
  const d = readFileSync(path);
  if (d.length < 0xb0 || d.readUInt32LE(0x20) !== 0xabcd5432) return null;
  const t = (o, l) => {
    const b = d.subarray(o, o + l);
    const end = b.indexOf(0);
    return (end === -1 ? b : b.subarray(0, end)).toString();
  };
  return { version: t(0x30, 32), project: t(0x50, 32), built: `${t(0x80, 16)} ${t(0x70, 16)}`, idf: t(0x90, 32), bytes: d.length };
}

export const isEspImage = (path) => readFileSync(path)[0] === 0xe9;

/** Loads a module fresh, with location.search set, so ?product= resolution can be tested. */
export async function importWithSearch(search, specifier) {
  globalThis.location = { search };
  return import(`${ROOT}${specifier}?cachebust=${encodeURIComponent(search)}`);
}
