<script>
  /**
   * A row of jumps to the sections below, for a thumb on a phone.
   *
   * Both map demos are a column of ten or so cards, and on a phone the map is
   * most of the way down it. Reaching the people list from the radio card is
   * four flicks, which is four flicks too many while walking.
   *
   * Deliberately a *jump* bar and not tabs: everything stays on the page, in
   * one order, findable by the browser's own search. Tabs would hide the log
   * while you are walking and tear the map out of the DOM on every switch,
   * which re-initialises Leaflet and throws away the view somebody panned to.
   *
   * Plain anchors, so a middle click opens a section in a new tab, the
   * keyboard reaches them in order, and a jump works before any JavaScript
   * has run. A link to a section that is switched off simply does nothing,
   * which is why `items` may be filtered without the bar knowing.
   */
  let { items = [], label = "" } = $props();
</script>

{#if items.length > 1}
  <nav class="jump" aria-label={label} data-testid="jump">
    {#each items as item (item.id)}
      <a href="#{item.id}">{item.label}</a>
    {/each}
  </nav>
{/if}

<style>
  /* Sticky rather than fixed: it belongs to the column, keeps its width, and
     does not need the page to leave room for it. Opaque, or the cards scroll
     visibly through it. */
  .jump {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    gap: 0.5rem;
    margin: 0 -1rem;
    padding: 0.55rem 1rem;
    /* One line that scrolls sideways. Wrapping to three lines on a phone is a
       bar that eats the screen it was meant to save. */
    overflow-x: auto;
    scrollbar-width: none;
    background: var(--ls-bg-0);
    border-bottom: 1px solid var(--ls-card-border);
  }

  .jump::-webkit-scrollbar {
    display: none;
  }

  .jump a {
    flex: 0 0 auto;
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--ls-card-border);
    border-radius: 999px;
    color: var(--ls-text-dim);
    font-size: 0.82rem;
    text-decoration: none;
    white-space: nowrap;
  }

  .jump a:hover,
  .jump a:focus-visible {
    border-color: var(--ls-accent);
    color: var(--ls-text);
  }
</style>
