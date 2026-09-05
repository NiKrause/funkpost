// SPDX-License-Identifier: GPL-3.0-only
import { mount } from "svelte";
import App from "./App.svelte";

export default mount(App, { target: document.getElementById("app") });
