import { mount } from "svelte";
import "../../web/styles.css";
import App from "./App.svelte";

mount(App, { target: document.body });

// Keep behavior unchanged while the state machine is migrated incrementally.
// The compatibility shell is static, so Svelte will not reconcile nodes that
// the legacy controller updates after this import.
void import("../../web/app.js");
