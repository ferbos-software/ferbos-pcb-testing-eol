import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { ROOT, appDescriptor, isEspImage } from "./helpers.mjs";

const { PRODUCTS } = await import(`${ROOT}js/core/productRegistry.js`);

// Bump when a new production release is bundled. Pinned so a stale or half-copied
// binary fails here rather than on a board.
const PRODUCTION_VERSION = "v1.6.1";

const NON_APP = ["bootloader.bin", "partition-table.bin", "ota_data_initial.bin"];
const OTADATA_OFFSET = {
  s3: { tester: 0x410000, production: 0x29000 },
  c6: { tester: 0x2ce000, production: 0x2ce000 }
};
const bytesOf = (p) => readFileSync(p).toString("base64");

test("every profile writes otadata", () => {
  // Both the tester and production partition tables carry an otadata partition.
  // Writing only the app leaves the bootloader pointing at whichever OTA slot was
  // last booted: the flash succeeds and verifies while the board keeps running the
  // previous firmware. This has bitten the S3 and the C6 once each.
  let checked = 0;
  for (const product of PRODUCTS) {
    if (!product.firmware) {
      assert.ok(product.firmwareNote, `${product.id}: no firmware and no note explaining why`);
      continue;
    }
    for (const [profile, cfg] of Object.entries(product.firmware)) {
      for (const [target, targetCfg] of Object.entries(cfg.targets)) {
        const label = `${product.id}/${profile}/${target}`;
        const files = targetCfg.files;
        const at = (name) => files.find((f) => f.path === name)?.address;

        assert.equal(at("bootloader.bin"), 0x0, `${label}: bootloader offset`);
        assert.equal(at("partition-table.bin"), 0x8000, `${label}: partition table offset`);
        assert.equal(at("ota_data_initial.bin"), OTADATA_OFFSET[target][profile],
          `${label}: otadata missing or at the wrong offset`);

        const addrs = files.map((f) => f.address);
        assert.equal(new Set(addrs).size, addrs.length, `${label}: overlapping offsets`);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 8, "gateway + climate, tester + production, s3 + c6");
});

test("every referenced binary exists and is a real ESP image", () => {
  for (const product of PRODUCTS) {
    for (const [profile, cfg] of Object.entries(product.firmware ?? {})) {
      for (const [target, targetCfg] of Object.entries(cfg.targets)) {
        for (const f of targetCfg.files) {
          const path = `${ROOT}firmware/${product.id}/${profile}/${target}/${f.path}`;
          const label = `${product.id}/${profile}/${target}/${f.path}`;
          assert.ok(existsSync(path), `${label}: missing`);
          assert.ok(statSync(path).size > 0, `${label}: empty`);
          if (f.path !== "ota_data_initial.bin" && f.path !== "partition-table.bin") {
            assert.ok(isEspImage(path), `${label}: not an ESP image (no 0xE9 magic)`);
          }
          if (!NON_APP.includes(f.path)) {
            assert.ok(appDescriptor(path), `${label}: no app descriptor`);
          }
        }
      }
    }
  }
});

test(`production images are ${PRODUCTION_VERSION}`, () => {
  for (const product of PRODUCTS) {
    for (const [target, cfg] of Object.entries(product.firmware?.production?.targets ?? {})) {
      const app = cfg.files.find((f) => !NON_APP.includes(f.path));
      const desc = appDescriptor(`${ROOT}firmware/${product.id}/production/${target}/${app.path}`);
      assert.equal(desc.version, PRODUCTION_VERSION,
        `${product.id}/production/${target} is ${desc.version}`);
    }
  }
});

test("images that must differ do, and images meant to be shared are", () => {
  const p = (product, profile, target, file) => `${ROOT}firmware/${product}/${profile}/${target}/${file}`;

  // The S3<->C6 pins differ between the PCBs, so the wrong tester build fails as a
  // puzzling C6 timeout rather than anything that names the real cause.
  assert.notEqual(bytesOf(p("gateway", "tester", "s3", "ferbos-pcb-testing-eol-main.bin")),
                  bytesOf(p("climate", "tester", "s3", "ferbos-pcb-testing-eol-main.bin")),
                  "climate tester S3 must be the climate build");

  // The climate production image carries the extra climate_control component.
  assert.notEqual(bytesOf(p("gateway", "production", "s3", "ferbos-gateway-main.bin")),
                  bytesOf(p("climate", "production", "s3", "ferbos-gateway-main.bin")),
                  "climate production S3 must be the climate build");

  // The C6 sits on its own GPIO 16/17 on both PCBs, so sharing is deliberate.
  for (const [profile, app] of [["tester", "ferbos-pcb-testing-eol-zigbee.bin"],
                                ["production", "ferbos-zigbee-gateway.bin"]]) {
    assert.equal(bytesOf(p("gateway", profile, "c6", app)), bytesOf(p("climate", profile, "c6", app)),
      `${profile} C6 image should be shared between products`);
  }
});

test("the progress readout derives its file count from the profile", () => {
  // A second hardcoded table drifted from the profiles once already.
  const main = readFileSync(`${ROOT}js/main.js`, "utf8");
  assert.ok(!main.includes("FLASH_FILE_COUNTS"), "hardcoded FLASH_FILE_COUNTS should be gone");
  assert.ok(main.includes("flashFileCount("), "count should come from the profile");
});
