<!-- SPDX-License-Identifier: GPL-3.0-only -->

# funkpost-brand

The Le Space look on funkpost's pages. The rules are Le Space's and live in
[Le-Space/landing](https://github.com/Le-Space/landing): the brand package
(`docs/le-space-brand/README.md`) and the page-QR convention (`AGENTS.md`).
This is their reading for pages that are not built from that repository.

| | |
|---|---|
| `brand.css` | the brand tokens (`--ls-*`, the same names as the landing's `tokens.css`) for both themes, the control pill, the QR popover and the credit line |
| `brand.js` | `mountPill({ up })`: an arrow up to `up` (every page but the menu passes `FUNKPOST_HOME`), the mark linked to le-space.de, the DE/EN flags, the theme switch, and the page QR · `creditHTML(lang)` / `mountCredit()`: *Made with ♥ Le Space* · `mountBrand()`: both · `lang`, `setLang()`: the language · `theme`, `setTheme()`, `toggleTheme()`: the theme |

**Nothing is fetched.** The QR is drawn on the page with uqr. The fonts are
named, not loaded — Inter and JetBrains Mono where a reader has them, the
system's otherwise — which is how le-space.de does it too.

## Language and theme

Every page speaks German and English, and has a light and a dark look. The
pill switches both, as on le-space.de, with the same storage keys
(`ls-locale`, `ls-theme`).

- **The language** comes from the address first (`?lang=de`), so a link or
  the page QR opens in the same language; then from the reader's last choice;
  then from the browser — German for a German browser, English otherwise. A
  switch rewrites `?lang=` in place and keeps the hash.
- **The theme** follows the system, live, until the reader picks one; the
  choice is then kept, as `data-theme` on `<html>`.

`lang` and `theme` are stores in Svelte's sense (`subscribe` returns the
unsubscribe), without Svelte: a Svelte page reads `$lang`, a plain one calls
`lang.subscribe()`.

**A static page** writes both languages into its markup and marks each block:
`<p data-lang="de">…</p><p data-lang="en">…</p>`. `brand.css` shows the one
`<html lang>` names.

**Every page puts this in its `<head>`**, before anything paints, so neither the
language nor a chosen theme flashes:

```html
<script>
  (function(){var d=document.documentElement,s=function(k){try{return localStorage.getItem(k)}catch(e){return null}},q=new URLSearchParams(location.search).get("lang"),l=q==="de"||q==="en"?q:s("ls-locale");if(l!=="de"&&l!=="en"){l="en";var a=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];for(var i=0;i<a.length;i++){if(/^de\b/i.test(a[i])){l="de";break}if(/^en\b/i.test(a[i]))break}}d.lang=l;var t=s("ls-theme");if(t==="dark"||t==="light")d.dataset.theme=t})();
</script>
```

It is the same decision `brand.js` makes, repeated because an imported module
would already be too late.

## Using it

A Svelte app:

```js
// main.js
import "@le-space/funkpost-brand/brand.css";
import { mountPill, FUNKPOST_HOME } from "@le-space/funkpost-brand";
mount(App, { target: document.getElementById("app") });
mountPill({ up: FUNKPOST_HOME });
```

```svelte
<script>
  import { lang, creditHTML } from "@le-space/funkpost-brand";
</script>
<!-- the app's own footer -->
<p class="ls-credit">{@html creditHTML($lang)}</p>
```

A plain HTML page, which has no bundler: the Pages workflow copies `brand.js`,
`brand.css` and uqr's one-file ESM build to `/funkpost/brand/`.

```html
<link rel="stylesheet" href="./brand/brand.css" />
<script type="importmap">{ "imports": { "uqr": "./brand/uqr.mjs" } }</script>
<script type="module">
  import { mountBrand } from "./brand/brand.js";
  mountBrand();
</script>
```

The pill sits in the top 56 px of the page, so content starts below it: the
pages here pad their `main` by 64–72 px on top.

The Le Space name and mark belong to Le Space UG (haftungsbeschränkt); the GPL
covers this code, not the right to use them elsewhere.
