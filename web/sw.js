const CACHE = "pi-everywhere-v10";
const SHELL = [
  "/",
  "/styles.css",
  "/app.js",
  "/markdown.js",
  "/session-list.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-1024.png",
  "/icon-maskable-1024-v2.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); }
    catch { return; }
    if (payload?.type !== "agent_settled") return;

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.some((client) => client.visibilityState === "visible")) return;

    await self.registration.showNotification(payload.title || "Pi finished working", {
      body: payload.body || "A Pi session is ready.",
      icon: "/icon-192.png",
      tag: `pi-everywhere:${payload.instanceId}`,
      data: { url: payload.url || "/" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.navigate(target);
      await existing.focus();
    } else {
      await self.clients.openWindow(target);
    }
  })());
});
