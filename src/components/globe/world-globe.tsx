"use client";

import { useCallback, useRef, useState } from "react";
import Map, { Marker, Popup, type MapRef } from "react-map-gl/mapbox";

import { RACE_TARGET, type ActivityLine, type GlobeDot } from "@/lib/race/board";

import "mapbox-gl/dist/mapbox-gl.css";

/**
 * The world, with a dot for every founder who has actually signed up.
 *
 * ## Why Mapbox replaced the hand-drawn SVG
 *
 * The previous version rendered `world-atlas` topojson through
 * `react-simple-maps` — a static outline with no zoom, no pan, and no real
 * geography behind it. Mapbox gives real interactive geography natively,
 * including country boundaries drawn from actual survey data.
 *
 * ## A custom style, not a stripped one
 *
 * The obvious approach is to load `dark-v11` and hide what is not wanted. That
 * was tried and abandoned: the style is fifty layers, and the landmass is a
 * `background`-type layer named `land` rather than `background` — so an
 * allowlist looking for the obvious name hides the continents and leaves a
 * globe painted entirely in the ocean colour, which looks like a design choice
 * rather than a bug.
 *
 * Three layers, written out, cannot fail that way. They also cannot be broken
 * by Mapbox renaming something: the only identifiers that matter are the two
 * source-layers, `water` and `admin`, which are part of the public Mapbox
 * Streets schema.
 *
 * ## The design tokens are hex here, not CSS variables
 *
 * Mapbox paint properties are read by the renderer, not by CSS, so
 * `var(--color-border)` arrives as an invalid colour. The three values below
 * are copies of the tokens and have to be kept in step with `globals.css` by
 * hand.
 */

/**
 * The base style, and the three layers kept from it.
 *
 * `dark-v11` is 50 layers: one background, six fills, twenty-nine lines, and
 * fourteen symbol layers. Of those, exactly three things are wanted — the
 * landmass, the ocean, and the lines between countries. The rest is roads,
 * tunnels, bridges, buildings, aerodrome outlines, parkland, state boundaries
 * and labels.
 *
 * A custom three-layer style was written first and abandoned: it needed the
 * `composite` vector source declared by hand, and the result rendered a
 * transparent canvas — a style that fails to load shows the page background
 * through the map, which is indistinguishable from "the map is empty".
 * Starting from a style Mapbox maintains removes that whole class of failure.
 *
 * Worth stating because the obvious guess is wrong: the landmass is **not** a
 * layer called `background`. The background-type layer is named `land`, and a
 * filter looking for `background` hides it — leaving a globe with no continents
 * on it, painted entirely in the ocean colour.
 *
 * These identifiers were read from
 * `https://api.mapbox.com/styles/v1/mapbox/dark-v11`. If Mapbox renames one,
 * the failure is visible rather than subtle: the thing disappears from the map.
 */
const BASEMAP = "mapbox://styles/mapbox/dark-v11";

const LAND_LAYER = "land";
const WATER_LAYER = "water";
/** Country borders. `admin-1` is states and provinces, which are not wanted. */
const BORDER_LAYERS = new Set(["admin-0-boundary", "admin-0-boundary-disputed"]);

/**
 * The design tokens, as literal hex.
 *
 * Mapbox paints are read by the renderer, not by CSS, so `var(--color-border)`
 * arrives as an invalid colour. These three are copies of the tokens and have
 * to be kept in step with `globals.css` by hand.
 */
const LAND_COLOR = "#161616";
const WATER_COLOR = "#0a0a0a";
const BORDER_COLOR = "#2c2c2c";

type StripMap = {
  getStyle(): { layers?: ReadonlyArray<{ id: string; type: string }> } | undefined;
  setLayoutProperty(id: string, name: string, value: unknown): void;
  setPaintProperty(id: string, name: string, value: unknown): void;
};

/**
 * Reduces `dark-v11` to land, ocean and national borders.
 *
 * Land is painted `surface` and the ocean `bg`, the same figure/ground
 * relationship the cards use: landmasses read as raised panels against a deeper
 * background.
 */
function stripToMonochrome(map: StripMap) {
  const layers = map.getStyle()?.layers ?? [];
  const seen = { land: false, water: false };

  for (const layer of layers) {
    // Each layer is handled in isolation. A style update can change the shape
    // of a property, and one `setPaintProperty` throwing must not abort the
    // loop halfway — a half-stripped map is far harder to diagnose than one
    // layer being wrong.
    try {
      if (layer.id === LAND_LAYER) {
        seen.land = true;
        map.setPaintProperty(layer.id, "background-color", LAND_COLOR);
        map.setPaintProperty(layer.id, "background-opacity", 1);
      } else if (layer.id === WATER_LAYER) {
        seen.water = true;
        map.setPaintProperty(layer.id, "fill-color", WATER_COLOR);
        map.setPaintProperty(layer.id, "fill-opacity", 1);
      } else if (BORDER_LAYERS.has(layer.id)) {
        map.setPaintProperty(layer.id, "line-color", BORDER_COLOR);
        map.setPaintProperty(layer.id, "line-opacity", 1);
      } else {
        // Roads, buildings, parkland, state lines, labels.
        map.setLayoutProperty(layer.id, "visibility", "none");
      }
    } catch (error) {
      console.warn(`[globe] could not restyle layer "${layer.id}"`, error);
    }
  }

  // A missing layer means Mapbox renamed something and the map is now wrong in
  // a way that is easy to look at without noticing. Say so loudly.
  if (!seen.land || !seen.water) {
    console.warn(
      `[globe] base style is missing expected layers: land: ${seen.land}, water: ${seen.water}, of ${layers.length} layers`,
    );
  }
}

type WorldGlobeProps = {
  dots: GlobeDot[];
  feed: ActivityLine[];
  /** False when the race could not be read — changes the caption, not the map. */
  live: boolean;
  token: string | null;
};

export function WorldGlobe({ dots, feed, live, token }: WorldGlobeProps) {
  const mapRef = useRef<MapRef | null>(null);
  const [openDot, setOpenDot] = useState<GlobeDot | null>(null);

  const onLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (map) stripToMonochrome(map as unknown as StripMap);
  }, []);

  /**
   * A bad token, a WebGL context loss, or a tile the account cannot read all
   * produce the same thing on screen: an empty box where the map should be.
   * Logging the reason is the difference between "the map is broken" and
   * knowing which of those it is.
   */
  const onError = useCallback((event: { error?: { message?: string } }) => {
    console.error("[globe] map error", event.error?.message ?? event);
  }, []);

  if (!token) {
    // Honest, and rare: the map is the one thing here that needs a third-party
    // account. Everything else on the page works without it.
    return (
      <Frame feed={feed} live={live}>
        <div className="flex h-full items-center justify-center px-6">
          <p className="max-w-sm text-center text-small text-text-muted prose">
            The map is unavailable: no Mapbox token is configured. The race
            itself is unaffected.
          </p>
        </div>
      </Frame>
    );
  }

  return (
    <Frame feed={feed} live={live}>
      <Map
        ref={mapRef}
        mapboxAccessToken={token}
        mapStyle={BASEMAP}
        onLoad={onLoad}
        onError={onError}
        // Nudged north and held at a zoom that fits the whole sphere in frame.
        // A globe cropped by its own container reads as a rendering fault
        // rather than as a choice.
        initialViewState={{ longitude: 10, latitude: 25, zoom: 1.4 }}
        // Deliberately low. The map is a backdrop for markers, not a toy — the
        // maximum zoom still keeps most of the world in frame so a visitor
        // never loses the dots they came to see.
        maxZoom={6}
        minZoom={0}
        dragRotate={false}
        pitchWithRotate={false}
        // Scroll zoom is off. A map that swallows the scroll wheel strands
        // anyone trying to read the rest of the page, and the markers are
        // legible at the default zoom anyway.
        scrollZoom={false}
        attributionControl
        style={{ width: "100%", height: "100%" }}
      >
        {dots.map((dot) => (
          <Marker
            key={dot.slug}
            longitude={dot.coordinates[0]}
            latitude={dot.coordinates[1]}
            anchor="center"
            onClick={(event) => {
              // Without this the click also reaches the map, which would close
              // the popup in the same gesture that opened it.
              event.originalEvent.stopPropagation();
              setOpenDot(dot);
            }}
          >
            <button
              type="button"
              aria-label={`${dot.who}${dot.product ? `, ${dot.product}` : ""}, ${dot.count} of ${RACE_TARGET}`}
              className="relative block h-3 w-3 cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text"
            >
              <span className="live-pulse absolute inset-0 rounded-full bg-text" />
              <span className="absolute inset-[3px] rounded-full bg-text" />
            </button>
          </Marker>
        ))}

        {openDot ? (
          <Popup
            longitude={openDot.coordinates[0]}
            latitude={openDot.coordinates[1]}
            anchor="bottom"
            offset={14}
            closeButton={false}
            onClose={() => setOpenDot(null)}
            className="[&_.mapboxgl-popup-content]:rounded-sm [&_.mapboxgl-popup-content]:border [&_.mapboxgl-popup-content]:border-border [&_.mapboxgl-popup-content]:bg-surface [&_.mapboxgl-popup-content]:px-3 [&_.mapboxgl-popup-content]:py-2 [&_.mapboxgl-popup-content]:shadow-none [&_.mapboxgl-popup-tip]:border-t-surface"
          >
            {/* Who, what, and how far. Nothing else — no city, no country, no
                email, no account. The dot is already a place; repeating it here
                would be the only other thing this popup could say, and it is the
                one thing a reader can already see. */}
            <p className="text-small">
              <span className="text-text">{openDot.who}</span>
              {openDot.product ? (
                <span className="ml-2 text-text-muted">{openDot.product}</span>
              ) : null}
            </p>
            <p className="mt-1 text-small text-text-muted">
              {openDot.count} of {RACE_TARGET}
            </p>
          </Popup>
        ) : null}
      </Map>
    </Frame>
  );
}

/**
 * The map's frame, and the activity card that floats over it.
 *
 * The feed is inside the map rather than beside it because it describes what
 * the dots are: the map is where, the card is what. Splitting them into two
 * sections made the connection something a reader had to assemble.
 */
function Frame({
  feed,
  live,
  children,
}: {
  feed: ActivityLine[];
  live: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative h-[420px] w-full overflow-hidden rounded-card border border-border bg-surface sm:h-[480px]">
      {children}

      <div className="pointer-events-none absolute bottom-0 left-0 max-h-[70%] w-full max-w-[300px] p-3">
        <div className="pointer-events-auto overflow-hidden rounded-sm border border-border bg-bg/85 backdrop-blur-sm">
          <p className="border-b border-border px-3 py-2 text-small text-text-muted">
            Recent activity
          </p>

          {!live ? (
            <p className="px-3 py-3 text-small text-text-muted">
              We couldn&apos;t load the race just now.
            </p>
          ) : feed.length === 0 ? (
            // No skeleton, no placeholder row, no invented names. An empty feed
            // is the honest state of a race nobody has joined yet.
            <p className="px-3 py-3 text-small text-text-muted">
              No races have started yet.
            </p>
          ) : (
            <ul className="max-h-52 overflow-y-auto">
              {feed.map((line) => (
                <li
                  key={line.key}
                  className="flex flex-wrap items-baseline gap-x-2 border-b border-border px-3 py-2 text-small last:border-b-0"
                >
                  <span className="text-text">{line.who}</span>
                  <span className="text-text-muted">{line.what}</span>
                  {line.when ? (
                    <span className="ml-auto text-text-muted">{line.when}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
