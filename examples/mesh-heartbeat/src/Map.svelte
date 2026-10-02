<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script>
  /**
   * The ride on a map, on both devices at once (#184).
   *
   * Same component for both halves, because both hold the same two things by
   * the time a round is over: a line of places where a beat went out, and the
   * one place that does not move. Which of them this device *is* only changes
   * where the data came from — the rider's own track, or what the stationary
   * device heard — and the picture is the same either way, which is the point:
   * two screens showing the same ride is what makes a silence readable.
   *
   * **OpenStreetMap, no Google.** Raster tiles straight from
   * tile.openstreetmap.org with the attribution their licence asks for.
   *
   * Leaflet rather than MapLibre: this draws a line and some dots on a slow
   * phone, and 42 KB gzipped against roughly 200 does that just as well. It
   * arrives through a dynamic import, so a device that never opens the map
   * does not pay for it — which matters on a page whose whole argument is that
   * the shell is the expensive part.
   *
   * **No marker images.** Leaflet's default icons are PNGs resolved by URL and
   * they break under every bundler in a different way; circles are drawn by
   * the browser, need no files, and scale on a phone screen.
   *
   * **Tiles need the internet and the ride does not.** Out of coverage the
   * tiles do not come and the vectors still do: the line, the dots and the
   * distance are all drawn from numbers this device already holds. The page
   * says so rather than showing an empty grey square and letting the rider
   * conclude the map is broken.
   */
  import { onMount } from "svelte";

  let {
    /** Where beats went out, oldest first: { lat, lon, at, kind, label }. */
    points = [],
    /** The device that does not move, if its place is known: { lat, lon }. */
    station = null,
    /** This device's own position, drawn only when it is not in `points`. */
    here = null,
    words,
  } = $props();

  const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  /** Result → colour, the same three the table uses. */
  const COLOURS = {
    first: "#34d399",
    late: "#fbbf24",
    silent: "#f87171",
    open: "#94a3b8",
  };

  let container;
  let map = null;
  let L = null;
  let layer = null;
  let tilesFailed = $state(false);
  let followed = $state(true); // until somebody drags it themselves
  /**
   * Set while *we* move the map.
   *
   * `fitBounds` fires `zoomstart` like any other zoom, so without this the
   * first automatic recentre switched following off and the map then sat
   * wherever the first point happened to put it — with a "back to the ride"
   * button offering to undo something nobody did.
   */
  let moving = false;

  onMount(() => {
    let dead = false;
    (async () => {
      // Both dynamic, so neither the library nor its stylesheet is in the
      // bundle a device downloads before it has asked for a map.
      const [leaflet] = await Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]);
      if (dead) return;
      L = leaflet.default ?? leaflet;
      map = L.map(container, { attributionControl: true, zoomControl: true }).setView(
        [48.4, 12.76],
        13,
      );
      L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION })
        .addTo(map)
        .on("tileerror", () => (tilesFailed = true))
        .on("tileload", () => (tilesFailed = false));
      layer = L.layerGroup().addTo(map);
      // A map that keeps yanking itself back while somebody is looking at
      // where they have been is worse than one that needs a button.
      map.on("dragstart zoomstart", () => {
        if (!moving) followed = false;
      });
      draw();
    })();
    return () => {
      dead = true;
      map?.remove();
      map = null;
    };
  });

  /** Everything with a place, oldest first, and the station last so it is on top. */
  const placed = $derived(points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)));

  function draw() {
    if (!map || !L) return;
    layer.clearLayers();

    const track = placed.map((p) => [p.lat, p.lon]);
    // The ride itself: the order the beats went out in.
    if (track.length > 1) {
      L.polyline(track, { color: "#38bdf8", weight: 3, opacity: 0.8 }).addTo(layer);
    }

    for (const point of placed) {
      L.circleMarker([point.lat, point.lon], {
        radius: 6,
        color: "#0f172a",
        weight: 1,
        fillColor: COLOURS[point.kind] ?? COLOURS.open,
        fillOpacity: 0.95,
      })
        .bindTooltip(point.label ?? "", { direction: "top" })
        .addTo(layer);
    }

    const newest = placed.at(-1);
    if (station && Number.isFinite(station.lat)) {
      // The one that does not move: a ring rather than a dot, so it is not
      // read as another beat.
      L.circleMarker([station.lat, station.lon], {
        radius: 10,
        color: "#f87171",
        weight: 3,
        fillColor: "#f87171",
        fillOpacity: 0.25,
      })
        .bindTooltip(words.station, { direction: "top" })
        .addTo(layer);

      // What connects them: the link being measured, as it stands now.
      if (newest) {
        L.polyline(
          [
            [station.lat, station.lon],
            [newest.lat, newest.lon],
          ],
          { color: "#f87171", weight: 2, opacity: 0.7, dashArray: "6 6" },
        )
          .bindTooltip(newest.label ?? "", { direction: "center" })
          .addTo(layer);
      }
    }

    // This device, when it has a fix that is not already a beat on the track —
    // the stationary half, or a rider before its first round.
    if (here && Number.isFinite(here.lat) && !station) {
      L.circleMarker([here.lat, here.lon], {
        radius: 7,
        color: "#38bdf8",
        weight: 2,
        fillColor: "#38bdf8",
        fillOpacity: 0.4,
      })
        .bindTooltip(words.here, { direction: "top" })
        .addTo(layer);
    }

    if (followed) recentre();
  }

  function recentre() {
    if (!map || !L) return;
    const all = placed.map((p) => [p.lat, p.lon]);
    if (station && Number.isFinite(station.lat)) all.push([station.lat, station.lon]);
    if (here && Number.isFinite(here.lat)) all.push([here.lat, here.lon]);
    if (all.length === 0) return;
    // Not animated, so the events it fires land inside this flag rather than
    // a frame later, where they would read as somebody taking the map over.
    moving = true;
    try {
      if (all.length === 1) map.setView(all[0], 15, { animate: false });
      else map.fitBounds(L.latLngBounds(all).pad(0.25), { animate: false });
    } finally {
      moving = false;
    }
  }

  function follow() {
    followed = true;
    recentre();
  }

  // Redraws whenever anything it draws from changes, which is what "live"
  // means here: a beat goes out, a row lands, the map has it.
  $effect(() => {
    void placed;
    void station;
    void here;
    draw();
  });
</script>

<div class="wrap">
  <div class="map" bind:this={container} data-testid="map"></div>
  {#if !followed}
    <button class="recentre" onclick={follow} data-testid="recentre">{words.recentre}</button>
  {/if}
</div>
{#if tilesFailed}
  <p class="dim" data-testid="map-offline">{words.offline}</p>
{/if}

<style>
  .wrap {
    position: relative;
  }

  .map {
    height: 22rem;
    border-radius: 0.5rem;
    /* Under the Leaflet panes, so an empty map is a surface rather than a
       hole — and so the tiles do not arrive on top of nothing. */
    background: #0b1220;
    z-index: 0;
  }

  .recentre {
    position: absolute;
    right: 0.6rem;
    bottom: 0.6rem;
    z-index: 500; /* above Leaflet's panes, below its popups */
  }

  :global(.leaflet-container) {
    font: inherit;
  }
</style>
