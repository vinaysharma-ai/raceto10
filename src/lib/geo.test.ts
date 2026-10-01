import assert from "node:assert/strict";
import { test } from "node:test";

import { isPlottable, readRequestGeo } from "./geo.ts";

/**
 * Reading the edge's location headers.
 *
 * The behaviour that matters is what happens when they are *absent*, which is
 * every local run and every self-hosted deploy. A missing coordinate must stay
 * missing — a zero would put the dot in the Gulf of Guinea, which is a
 * fabricated location on a map that exists to be real.
 */

const geo = (headers: Record<string, string>) =>
  readRequestGeo(new Headers(headers));

test("a full set of edge headers becomes a location", () => {
  const result = geo({
    "x-vercel-ip-latitude": "38.7167",
    "x-vercel-ip-longitude": "-9.1333",
    "x-vercel-ip-city": "Lisbon",
    "x-vercel-ip-country": "PT",
  });

  assert.deepEqual(result, {
    city: "Lisbon",
    country: "PT",
    latitude: 38.7167,
    longitude: -9.1333,
  });
  assert.equal(isPlottable(result), true);
});

test("no headers at all is no location, not a location at zero", () => {
  const result = geo({});

  assert.deepEqual(result, {
    city: null,
    country: null,
    latitude: null,
    longitude: null,
  });
  assert.equal(isPlottable(result), false);
});

test("a half coordinate is dropped rather than stored as a pair", () => {
  // The database has a check constraint saying both or neither. Dropping the
  // pair here means the insert lands instead of failing at the last step of a
  // signup, and it cannot produce a dot on the equator.
  const result = geo({ "x-vercel-ip-latitude": "38.7167" });

  assert.equal(result.latitude, null);
  assert.equal(result.longitude, null);
  assert.equal(isPlottable(result), false);
});

test("out-of-range and unparseable coordinates are refused", () => {
  for (const [lat, lng] of [
    ["91", "0"],
    ["-91", "0"],
    ["0", "181"],
    ["0", "-181"],
    ["abc", "0"],
    ["", ""],
    ["NaN", "NaN"],
    ["Infinity", "0"],
  ]) {
    const result = geo({
      "x-vercel-ip-latitude": lat,
      "x-vercel-ip-longitude": lng,
    });
    assert.equal(result.latitude, null, `${lat}/${lng} should not be plottable`);
    assert.equal(result.longitude, null);
  }
});

test("coordinates on the boundary are kept", () => {
  const result = geo({ "x-vercel-ip-latitude": "90", "x-vercel-ip-longitude": "180" });
  assert.equal(result.latitude, 90);
  assert.equal(result.longitude, 180);
});

test("the city is URL-decoded", () => {
  assert.equal(geo({ "x-vercel-ip-city": "New%20York" }).city, "New York");
  assert.equal(geo({ "x-vercel-ip-city": "S%C3%A3o%20Paulo" }).city, "São Paulo");
});

test("a malformed city escape degrades instead of throwing", () => {
  // `decodeURIComponent("%")` throws. A city name is never worth failing a
  // signup over, so the raw value is kept.
  assert.equal(geo({ "x-vercel-ip-city": "%" }).city, "%");
  assert.equal(geo({ "x-vercel-ip-city": "%E0%A4%A" }).city, "%E0%A4%A");
});

test("blank headers are treated as absent", () => {
  const result = geo({
    "x-vercel-ip-city": "   ",
    "x-vercel-ip-country": "",
    "x-vercel-ip-latitude": "  ",
    "x-vercel-ip-longitude": " ",
  });

  assert.equal(result.city, null);
  assert.equal(result.country, null);
  assert.equal(result.latitude, null);
});

test("a location with no city still plots", () => {
  // Country-level resolution is common on the edge. Losing the dot because the
  // city is unknown would throw away a real location.
  const result = geo({
    "x-vercel-ip-country": "DE",
    "x-vercel-ip-latitude": "50.1109",
    "x-vercel-ip-longitude": "8.6821",
  });

  assert.equal(result.city, null);
  assert.equal(result.country, "DE");
  assert.equal(isPlottable(result), true);
});
