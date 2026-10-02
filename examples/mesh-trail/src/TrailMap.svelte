<!-- SPDX-License-Identifier: GPL-3.0-only -->
<script>
  /**
   * Everyone's walk, on one map.
   *
   * A trail per device, newest end brightest, with a dot at the head and an
   * arrow for where they were going when last heard. This device is a ring, so
   * it does not read as one more walker.
   *
   * **OpenStreetMap, no Google.** Raster tiles with the attribution the
   * licence asks for. Leaflet rather than MapLibre — 43 KB gzipped against
   * roughly 200, to draw lines and dots on a phone — and loaded through a
   * dynamic import, so a device that never opens the map does not pay for it.
   *
   * **Tiles need the internet and a walk does not.** In a wood there is no
   * network and the tiles do not come; the trails, the distances and the
   * directions are drawn from numbers this device already holds. The page says
   * so, because an empty grey square with no explanation reads as a broken map
   * rather than a missing one.
   */
  import { onMount } from "svelte";

  let { trails = [], here = null, words } = $props();

  const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  let container;
  let map = null;
  let L = null;
  let layer = null;
  let tilesFailed = $state(false);
  let followed = $state(true);
  /** Set while *we* move the map: fitBounds fires zoomstart like any zoom. */
  let moving = false;

  onMount(() => {
    let dead = false;
    (async () => {
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

  const placed = (points) =>
    points.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));

  function draw() {
    if (!map || !L) return;
    layer.clearLayers();

    for (const trail of trails) {
      const points = placed(trail.points);
      if (points.length === 0) continue;
      const line = points.map((p) => [p.lat, p.lon]);
      if (line.length > 1) {
        L.polyline(line, { color: trail.colour, weight: 3, opacity: 0.55 }).addTo(layer);
      }
      // The older a point, the fainter: a walk is a thing with a direction,
      // and a trail drawn in one flat colour hides which end is now.
      points.forEach((point, index) => {
        const newest = index === points.length - 1;
        L.circleMarker([point.lat, point.lon], {
          radius: newest ? 7 : 4,
          color: newest ? "#0f172a" : trail.colour,
          weight: newest ? 2 : 1,
          fillColor: trail.colour,
          fillOpacity: newest ? 1 : 0.2 + (0.5 * index) / points.length,
        })
          .bindTooltip(newest ? trail.name : "", { direction: "top" })
          .addTo(layer);
      });
    }

    // This device: a ring rather than a dot, so it is not read as one more
    // walker on the list.
    if (here && Number.isFinite(here.lat)) {
      L.circleMarker([here.lat, here.lon], {
        radius: 10,
        color: "#f87171",
        weight: 3,
        fillColor: "#f87171",
        fillOpacity: 0.2,
      })
        .bindTooltip(words.here, { direction: "top" })
        .addTo(layer);
    }

    if (followed) recentre();
  }

  function recentre() {
    if (!map || !L) return;
    const all = trails.flatMap((trail) => placed(trail.points).map((p) => [p.lat, p.lon]));
    if (here && Number.isFinite(here.lat)) all.push([here.lat, here.lon]);
    if (all.length === 0) return;
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

  $effect(() => {
    void trails;
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
    height: 24rem;
    border-radius: 0.5rem;
    background: #0b1220;
    z-index: 0;
  }

  .recentre {
    position: absolute;
    right: 0.6rem;
    bottom: 0.6rem;
    z-index: 500;
  }

  :global(.leaflet-container) {
    font: inherit;
  }
</style>
