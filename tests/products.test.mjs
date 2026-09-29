import assert from "node:assert/strict";
import test from "node:test";
import { ROOT } from "./helpers.mjs";

const registry = await import(`${ROOT}js/core/productRegistry.js`);
const { PRODUCTS, getProduct, resolveProductId, DEFAULT_PRODUCT_ID, ACTIVE_PRODUCT, TESTS } = registry;
const gateway = getProduct("gateway");
const climate = getProduct("climate");

test("product resolves from ?product=, falling back to the live station", () => {
  assert.equal(resolveProductId("?product=climate"), "climate");
  assert.equal(resolveProductId("?other=1&product=climate&x=2"), "climate");
  for (const search of ["", "?product=", "?product=nope"]) {
    assert.equal(resolveProductId(search), DEFAULT_PRODUCT_ID, `"${search}" should fall back`);
  }
  assert.equal(DEFAULT_PRODUCT_ID, "gateway", "the default must stay gateway: existing bookmarks point at it");
  assert.equal(getProduct("nope"), null);
  assert.equal(ACTIVE_PRODUCT.id, "gateway", "no location in Node, so the default applies");
  assert.equal(TESTS, ACTIVE_PRODUCT.tests);
});

test("gateway is unchanged by the multi-product refactor", () => {
  assert.deepEqual(gateway.tests.map((t) => t.id), ["jig", "ping", "info", "c6", "ethernet", "wifi", "rs485"]);
  assert.deepEqual(gateway.inputs.map((i) => i.name), ["unitId", "ssid", "password", "rs485Enabled"]);
  assert.deepEqual(gateway.ports.map((p) => p.key), ["main", "jig"]);
});

test("climate reflects a board with no RS485 and two extra sensors", () => {
  assert.deepEqual(climate.tests.map((t) => t.id),
    ["ping", "info", "c6", "sht20", "ld2412", "ethernet", "wifi", "gsm"]);
  assert.deepEqual(climate.inputs.map((i) => i.name), ["unitId", "ssid", "password", "gsmLoopback"]);
  assert.deepEqual(climate.ports.map((p) => p.key), ["main"], "no jig port to ask for");
  assert.match(climate.ports[0].note, /USB-Serial-JTAG/, "its host link is the native USB; say so");

  // Sensors are instant and hands-off, so a dead one should fail before the operator
  // spends two minutes plugging and unplugging cables.
  const order = climate.tests.map((t) => t.id);
  assert.ok(order.indexOf("sht20") < order.indexOf("ethernet"));
  assert.ok(order.indexOf("ld2412") < order.indexOf("ethernet"));

  for (const id of ["rs485", "jig"]) {
    assert.ok(!climate.tests.some((t) => t.id === id), `climate must not carry ${id}`);
  }
  for (const id of ["sht20", "ld2412", "gsm"]) {
    assert.ok(!gateway.tests.some((t) => t.id === id), `gateway must not carry ${id}`);
  }
});

test("the board-identity criterion catches the other product's firmware", () => {
  const last = (t) => t.criteria[t.criteria.length - 1];
  const gInfo = gateway.tests.find((t) => t.id === "info");
  const cInfo = climate.tests.find((t) => t.id === "info");
  assert.notEqual(gInfo, cInfo, "info is per-product: it carries the board id");

  const plain = { ok: true, detail: "chip_model=9 cores=2 free_heap=1" };
  const withBoard = (b) => ({ ok: true, detail: `board=${b} chip_model=9 cores=2 free_heap=1` });

  // Firmware that predates board= still passes, so the host check shipped first.
  assert.equal(last(gInfo).check({ response: plain }), true);
  assert.equal(last(cInfo).check({ response: plain }), true);

  assert.equal(last(gInfo).check({ response: withBoard("gateway") }), true);
  assert.equal(last(gInfo).check({ response: withBoard("climate-control") }), false);
  assert.equal(last(cInfo).check({ response: withBoard("climate-control") }), true);
  assert.equal(last(cInfo).check({ response: withBoard("gateway") }), false);
});

test("GSM loopback demands an exact echo", () => {
  const gsm = climate.tests.find((t) => t.id === "gsm");
  assert.equal(gsm.command, "gsm_loopback");
  assert.ok(gsm.optional && gsm.skipNote, "a missing jumper skips, it does not fail the board");

  const sent = { payload: "EOL_GSM_LOOPBACK" };
  const echo = (rx) => ({ ok: true, detail: `tx=EOL_GSM_LOOPBACK rx=${rx}` });
  const match = gsm.criteria[2];
  assert.equal(match.check({ response: echo("EOL_GSM_LOOPBACK"), payload: sent }), true);
  assert.equal(match.check({ response: echo("EOL_GSM_LOOPBAC"), payload: sent }), false, "truncated");
  assert.equal(match.check({ response: echo(""), payload: sent }), false, "empty");
  assert.equal(match.check({ response: { ok: true, detail: "tx=EOL_GSM_LOOPBACK" }, payload: sent }), false, "no rx");
});

test("sensor criteria read the firmware's own verdict", () => {
  const sht20 = climate.tests.find((t) => t.id === "sht20");
  assert.equal(sht20.command, "sht20_read");
  assert.equal(sht20.criteria[2].check({ response: { detail: "temp_c=24.10 rh=48.20 in_range=yes" } }), true);
  assert.equal(sht20.criteria[2].check({ response: { detail: "temp_c=-46.85 rh=-6.00 in_range=no" } }), false,
    "a part returning the conversion floor must fail");
  assert.equal(sht20.criteria[1].check({ events: [{ test: "sht20", state: "error" }] }), false);

  const ld2412 = climate.tests.find((t) => t.id === "ld2412");
  assert.equal(ld2412.command, "ld2412_probe");
  assert.equal(ld2412.criteria[2].check({ response: { detail: "ld2412 report frame ok body=11 bytes" } }), true);
  assert.equal(ld2412.criteria[2].check({ response: { detail: "ld2412 no report frame in 2000ms" } }), false);
});

test("every product is internally consistent", () => {
  for (const product of PRODUCTS) {
    assert.ok(product.id && product.label && product.boardId && product.ports?.length, `${product.id}: incomplete`);
    const ids = product.tests.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, `${product.id}: duplicate test ids`);

    for (const t of product.tests) {
      assert.ok(t.label && t.criteria?.length, `${product.id}/${t.id}: malformed`);
      for (const c of t.criteria) {
        assert.equal(typeof c.label, "string");
        assert.equal(typeof c.check, "function");
      }
      if (t.requiresInput) {
        assert.ok(product.inputs.some((i) => i.name === t.requiresInput),
          `${product.id}/${t.id}: requiresInput "${t.requiresInput}" has no matching input`);
        assert.ok(t.optional && t.skipNote, `${product.id}/${t.id}: gated tests need optional + skipNote`);
      }
    }
    // a jig port only makes sense where something needs the jig
    assert.equal(product.tests.some((t) => t.hostCheck === "jig"),
                 product.ports.some((p) => p.key === "jig"),
                 `${product.id}: jig port and jig test must agree`);
  }
});
