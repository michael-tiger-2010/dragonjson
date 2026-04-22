# dragonJSON

A lazy-loading JSON client for structured API endpoints. It is like GraphQL, but easier on DX and built for quick prototyping or smaller projects that need fast iteration time. dragonJSON lets you navigate your server's data like a local object: fetching only what you need, when you need it, with automatic caching and real-time sync and invalidation built in.

```js
const [server] = dragonJSON("https://mysite.com/api");

// Access deeply nested data: only the required paths are fetched
const body = await server.posts.page1.content.body;

// Objects are live:
const user = await server.users["admin"];
await user.id //finds ID from cache, returns it

```

---

## Features

- **Lazy loading**: only fetches data when you access it
- **Optimized Server-Client**: server can choose to send back all data (like when accessing a single post), or just parts (like when accessing a list of all users).
- **Automatic caching**: parent fetches are stored locally; children resolve instantly
- **Request batching**: rapid concurrent requests are coalesced into a single round trip
- **Mutations**: `$set`, `$add`, `$remove` with automatic cache invalidation
- **Event system**: listen for changes at any path, with optional bubbling
- **Live invalidation**: real-time sync across clients via WebSocket or any relay
- **Wildcard collections**: supports open-ended data with `__more`

---

## Installation

Client libraries for languages live in [`client/`](./client/) - find the one for your language there. \
Current languages:
 - Javascript

Server libraries for languages live in [`server/`](./server/). \
Current Languages:
 - NodeJS

It is pretty easy to write a client or server for the protocol. Read [`server/`](./server/) for more information. 

---

## Quick Start (JavaScript)

```js
import dragonJSON from './client/dragonJSON.js';

const [server, control] = dragonJSON("https://mysite.com/api", {
    auth: "Bearer my-token",
    enableBatching: true,
});

// Read
const title = await server.posts.page1.title;

// Prefetch multiple paths in parallel
await Promise.all([server.posts.page1, server.posts.page2]);

// Write
await server.posts.$set("page1", { title: "Updated" });

// Add
await server.posts.$add({ title: "New Post" });

// Remove
await server.posts.page1.$remove();

// Get some dynamic data
let user = server.users[username];
await user.feed.get("hotTopics");

// Listen for changes (needs liveInvalidation to be more responsive, otherwise only responds to client data)
server.posts.$on("add", "*", (e) => console.log("New post added:", e.key));
```

---

## Live Sync

Pass a `liveInvalidation` config to keep all connected clients in sync automatically:

```js
const [server] = dragonJSON("https://mysite.com/api", {
    liveInvalidation: {
        sendRelayMessage: (msg) => socket.emit("invalidate", msg),
        onReceiveCallback: (cb) => socket.on("invalidate", cb),
    }
});
```

When any client mutates data, all others are notified, their caches are updated, and their `$on()` listeners are fired.

---

## Server Spec

For the full server-side contract — expected request shapes, response formats, batch protocol, invalidation, and `__more` / `__batch` conventions — see [`server/spec.json`](./server/spec.json).

---

## API at a Glance

| Method | Description |
|---|---|
| `await server.a.b.c` | Fetch and resolve a path |
| `$set(data)` / `$set(key, value)` | Update a value |
| `$add(obj)` / `$add(key, obj)` | Add a new entry |
| `$remove()` / `$remove(key)` | Delete a path |
| `$get(command)` | Freeform server query (no cache) |
| `$prefetch([...keys])` | Parallel prefetch at current scope |
| `$refresh()` | Invalidate and re-fetch a path |
| `$exists()` | Check if a path exists (fetches if needed) |
| `$loaded()` | Check if a path is already cached |
| `$on(type, key, fn, mode?)` | Subscribe to mutations |
| `$off(type, key, fn, mode?)` | Unsubscribe |

---

## License

Apache 2.0
