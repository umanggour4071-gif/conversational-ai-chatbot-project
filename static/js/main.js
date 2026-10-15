import { initApp } from "./app.js";

initApp({ document, window, fetch: window.fetch.bind(window) });
