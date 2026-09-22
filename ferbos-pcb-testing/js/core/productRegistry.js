import { climate } from "./products/climate.js";
import { gateway } from "./products/gateway.js";

export const PRODUCTS = [gateway, climate];
export const DEFAULT_PRODUCT_ID = gateway.id;

export function getProduct(id) {
  return PRODUCTS.find((product) => product.id === id) ?? null;
}

/**
 * Resolves the product for a station from `?product=`.
 *
 * Each station bookmarks its own URL, so the product is part of the address rather
 * than a setting someone can leave wrong. An unknown or missing value falls back to
 * the gateway, which keeps every existing bookmark working exactly as before.
 */
export function resolveProductId(search = "") {
  const requested = new URLSearchParams(search).get("product");
  return getProduct(requested) ? requested : DEFAULT_PRODUCT_ID;
}

// Resolved once at load: the whole UI is built around one product per page.
export const ACTIVE_PRODUCT = getProduct(
  resolveProductId(typeof location === "undefined" ? "" : location.search)
);

export const TESTS = ACTIVE_PRODUCT.tests;
export const SEQUENCE_INPUTS = ACTIVE_PRODUCT.inputs;

export function getTestById(id) {
  return TESTS.find((test) => test.id === id);
}
