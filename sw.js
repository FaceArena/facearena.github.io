self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = String(payload.title || "FACE ARENA");
  const options = {
    body: String(payload.body || "У тебя новое событие на арене."),
    icon: "./icons/icon-192.png",
    badge: "./icons/apple-touch-icon.png",
    tag: String(payload.tag || "face-arena-notification"),
    renotify: false,
    data: { url: String(payload.url || "./#notifications") }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./#notifications", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.navigate(target);
      return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});
