const CACHE = "pi-everywhere-svelte-v2";
const CORE = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const indexResponse = await fetch("/", { cache: "reload" });
    if (!indexResponse.ok) throw new Error("Could not cache the application shell");
    const html = await indexResponse.clone().text();
    await cache.put("/", indexResponse);
    const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
      .map((match) => new URL(match[1], self.location.origin))
      .filter((url) => url.origin === self.location.origin)
      .map((url) => `${url.pathname}${url.search}`);
    await cache.addAll([...new Set([...CORE.slice(1), ...assets])]);
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;
  const navigation = event.request.mode === "navigate";
  const staticAsset = url.pathname.startsWith("/assets/")
    || url.pathname === "/icon.svg"
    || url.pathname === "/manifest.webmanifest";
  if (!navigation && !staticAsset) return;

  event.respondWith((async () => {
    const cacheKey = navigation ? "/" : event.request;
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(cacheKey, response.clone());
      }
      return response;
    } catch {
      return await caches.match(cacheKey) ?? Response.error();
    }
  })());
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
      icon: "/icon.svg",
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
