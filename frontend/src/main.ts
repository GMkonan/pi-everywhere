import { mount } from "svelte";
import "../../web/styles.css";
import App from "./App.svelte";
import { startController } from "./lib/controller";
import { initializeTheme } from "./lib/theme";

initializeTheme();
mount(App, { target: document.body });
startController();
