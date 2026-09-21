// SPDX-License-Identifier: GPL-3.0-only
import { mount } from "svelte";
import "@le-space/funkpost-brand/brand.css";
import { mountPill, FUNKPOST_HOME } from "@le-space/funkpost-brand";
import App from "./App.svelte";

mount(App, { target: document.getElementById("app") });

// The Le Space pill: up to all pages, the mark, and this page as a QR for the phone.
mountPill({ up: FUNKPOST_HOME });
