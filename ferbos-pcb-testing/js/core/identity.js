// Device identity derived from the ESP32 base eFuse MAC.
//
// Both firmware projects build with four universal MAC addresses, so the base MAC esptool
// reads over USB is the same value esp_read_mac(ESP_MAC_WIFI_STA) returns on the device.
// ferbos-gateway-main derives the gateway id, MQTT topic, and BLE name from that MAC, so the
// tester can show the operator exactly what the running gateway will report -- before the
// production firmware has ever booted. This is what goes on the sticker.

export function normalizeMac(mac) {
  const hex = String(mac ?? "").replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  return hex.length === 12 ? hex : null;
}

export function formatMac(mac) {
  const hex = normalizeMac(mac);
  return hex ? (hex.match(/../g) ?? []).join(":").toUpperCase() : "";
}

/**
 * @param {string} mac - base MAC in any format
 * @returns {{mac: string, gatewayId: string, mqttTopic: string, bleName: string}|null}
 */
export function deriveIdentity(mac) {
  const hex = normalizeMac(mac);
  if (!hex) {
    return null;
  }
  return {
    mac: formatMac(hex),
    gatewayId: hex,
    mqttTopic: `continuum/${hex}/#`,
    bleName: `FERBOS-${hex.slice(6).toUpperCase()}`
  };
}
