<!-- SPDX-License-Identifier: GPL-3.0-only -->

# funkpost-brand

The Le Space look on funkpost's pages. The rules are Le Space's and live in
[Le-Space/landing](https://github.com/Le-Space/landing): the brand package
(`docs/le-space-brand/README.md`) and the page-QR convention (`AGENTS.md`).
This is their reading for pages that are not built from that repository.

| | |
|---|---|
| `brand.css` | the brand tokens (`--ls-*`, the same names as the landing's `tokens.css`), the control pill, the QR popover and the credit line. Dark is the ground; light when the reader's system asks, or when `<html data-theme="light">` says the page is light |
| `brand.js` | `mountPill({ up })` — an arrow up to `up` (every page but the menu passes `FUNKPOST_HOME`), the mark, linked to le-space.de, and the page QR · `creditHTML()` / `mountCredit()` — *Made with ♥ Le Space* · `mountBrand()` — both |

**Nothing is fetched.** The QR is drawn on the page with uqr. The fonts are
named, not loaded — Inter and JetBrains Mono where a reader has them, the
system's otherwise — which is how le-space.de does it too.

**On a page with a fixed look, say which.** `mesh-todo` and `recovery` are dark
whatever the system says, `mesh-calendar` light, so each sets `data-theme` on
`<html>`; the pill and the credit line then match the page instead of the
system. The menu and the passkey probe follow the system.

## Using it

A Svelte app:

```js
// main.js
import "@le-space/funkpost-brand/brand.css";
import { mountPill } from "@le-space/funkpost-brand";
mount(App, { target: document.getElementById("app") });
mountPill();
```

```svelte
<!-- the app's own footer -->
<p class="ls-credit">{@html creditHTML("en")}</p>
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
