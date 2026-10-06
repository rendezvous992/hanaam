// 오프라인에서도 열리도록 앱 파일을 기기에 저장해 둔다.
// 앱을 고칠 때는 VERSION 을 올려야 새 파일로 바뀐다.
const VERSION = "plush-v1";
const FILES = ["./", "index.html", "app.js", "three.min.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// 화면(html)은 인터넷이 되면 새로 받고, 안 되면 저장본을 쓴다. 나머지는 저장본부터 쓴다.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put("index.html", copy)); return res; }).catch(() => caches.match("index.html")));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
