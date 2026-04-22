# dragonJSON Server Specification

A reference for implementing a server that is compatible with the dragonJSON client protocol.

---

## Overview

dragonJSON is a lazy-loading, cache-aware JSON client. The server's job is simple:

- Serve nested JSON data at path-addressed endpoints
- Accept mutation commands (set, add, remove) and return invalidation hints
- Optionally support batched reads for performance

The client handles caching, event dispatching, and relay. The server only needs to handle data and mutations.

---

## Base URL

All requests are made to the single URL passed to `dragonJSON(url, options)`. There is no routing by HTTP method beyond GET vs POST — the operation type is encoded in the request body or query parameters.

---

## Reading Data

### Single-path fetch

**Request**

```
GET {base}?path=some.nested.key
```

The `path` parameter uses `.` as a separator and maps to the nested structure of your data store. An empty or absent `path` refers to the root.

**Response**

Return the JSON value at that path. The shape can be anything:

```json
{ "title": "Hello World", "body": "..." }
```

or a primitive:

```json
"Hello World"
```

**Special fields**

The client recognises two reserved fields on object responses:

| Field | Type | Meaning |
|---|---|---|
| `__next` | `boolean` | Signals the object has children but they haven't been sent yet. The client will re-fetch this node when a child is accessed. Use this to defer loading of expensive sub-trees. |
| `__more` | `boolean` | Signals the object has *unknown* children — keys the client does not know in advance. The client will fetch any key accessed under this node on demand rather than treating it as "not found". Use this for open-ended collections (e.g. user-generated content, dynamic routes). |

**Example — deferred subtree**

If `posts` contains many pages you don't want to serialize up front, return:

```json
{ "__next": true }
```

The client stores this placeholder and fetches the real data the first time a child is accessed.

**Example — open-ended collection**

If the set of keys under `users` is not fixed, return:

```json
{ "__more": true }
```

The client will fetch `users.somekey` on demand rather than treating unknown keys as missing.

---

### Batched fetch

When `enableBatching: true` (the default), the client collects rapid parallel requests and sends them together.

**Request**

```
GET {base}?paths=["posts.page1","posts.page2","meta.title"]
```

The `paths` parameter is a JSON array of dot-separated path strings.

**Response**

Return a flat object keyed by path string:

```json
{
  "posts.page1": { "title": "First post", "body": "..." },
  "posts.page2": { "title": "Second post", "body": "..." },
  "meta.title":  "My Blog"
}
```

Every path in the request array must appear in the response object. If a path does not exist, set it to `null` rather than omitting it — an absent key causes the client to reject that promise with an error.

---

### $get — freeform query

**Request**

```
GET {base}?path=posts&command={"action":"paginate","cursor":42}
```

The `command` parameter is a JSON-encoded object. Its shape is entirely up to you and is passed through unchanged. The result is returned directly to the caller — it is never stored in the client cache.

**Response**

Any valid JSON.

---

### Hierarchical fetch (optional)

If you set `enableHierarchicalBatch: true` in client options, the client adds two extra parameters on reads:

```
GET {base}?path=posts&target=posts.page1.title&hierarchical=true
```

This signals that the client is trying to reach `target` and is fetching `path` as the first step. You may respond with a `__batch` envelope containing multiple paths at once, saving round-trips:

```json
{
  "__batch": {
    "posts":             { "page1": { "__next": true }, "page2": { "__next": true } },
    "posts.page1":       { "title": "First post", "body": "..." },
    "posts.page1.title": "First post"
  }
}
```

If you do not want to implement this, simply respond with the normal value for `path` and ignore `target`. The client detects the absence of `__batch` and wraps the response itself.

---

## Mutations

All mutations are `POST` requests. The path being mutated is encoded in the query string, identical to reads:

```
POST {base}?path=some.nested.key
Content-Type: application/json
```

The body varies by operation.

### Response shape — all mutations

Every mutation endpoint must return:

```json
{ "invalidate": ["path.that.changed", "another.path"] }
```

`invalidate` is an array of dot-separated path strings. The client marks each listed path as stale and re-fetches it on next access. It also fires any `.$on()` listeners registered on those paths.

If the array is empty (`[]`), the client treats the mutation as a no-op on the cache. Do not return anything other than this shape — missing or malformed responses cause the client to throw.

---

### $set

**Request body**

```json
{ "title": "Updated title", "body": "New body" }
```

The body is the new value at `path`. It can be any JSON type — object, array, string, number, boolean, or null.

**Example**

```
POST {base}?path=posts.page1
{ "title": "Updated", "body": "New content" }
```

**Response**

```json
{ "invalidate": ["posts.page1"] }
```

---

### $add

**Request body**

```json
{ "__op": "add", "value": { "title": "New post", "body": "..." } }
```

Optionally, the client may suggest a key:

```json
{ "__op": "add", "key": "page5", "value": { "title": "New post" } }
```

The server may accept or override the suggested key. If the key is omitted, the server assigns one.

**Response**

```json
{ "invalidate": ["posts"] }
```

Invalidate the parent collection so the client re-fetches the updated key list.

---

### $remove

**Request body**

```json
{ "__op": "remove" }
```

The path being deleted is in the query string. The body is always `{ "__op": "remove" }`.

**Response**

```json
{ "invalidate": ["posts"] }
```

Invalidate the parent so the client evicts the deleted entry and re-fetches the collection.

---

## Authentication

If the client is initialised with `auth: "Bearer my-token"`, it includes the following header on every request:

```
Authorization: Bearer my-token
```

Validate this on the server side as you would any bearer token. If you use custom headers via `headers: {}` in client options, those are also forwarded verbatim.

---

## Error handling

Return non-2xx HTTP status codes for errors. The client will reject the corresponding promise with a message containing the status code and path. The client does not parse error bodies — they are for your own logging.

For batch requests, avoid failing the entire batch for one bad path. Return the known paths normally and set the failed path to `null` so the client can surface a per-path error rather than failing everything at once.

---

## Live invalidation relay (optional)

If the client uses `liveInvalidation`, it sends a relay message after every mutation in this shape:

```json
{
  "invalidate": ["posts.page1"],
  "initiator":  "set",
  "key":        "*",
  "path":       "posts"
}
```

Your server or relay (WebSocket, BroadcastChannel, etc.) should broadcast this to other connected clients. Receiving clients will invalidate the listed paths and fire any matching `.$on()` listeners locally — exactly as if the mutation had happened on their own client.

**The relay message is not a mutation request.** It is metadata about a mutation that has already occurred. Do not apply it again server-side.

You can also use the relay channel for server-initiated messages (e.g. push notifications) by listening at a path like `server.relay` and having the server emit relay-shaped messages.

---

## Path conventions

- Paths use `.` as a separator: `posts.page1.title`
- An empty string or absent `path` refers to the root
- Path segments must not contain `.` (dots within a key are not supported)
- Path segments must not start with `$` (reserved for client methods)
- The segments `then` and `exists` are reserved and must not be used as keys

---

## Minimal implementation checklist

A compliant dragonJSON server must:

- [ ] Accept `GET ?path=` and return the JSON value at that path
- [ ] Accept `GET ?paths=` (JSON array) and return a flat `{ "path": value }` object
- [ ] Accept `POST ?path=` with a JSON body and return `{ "invalidate": [...] }`
- [ ] Distinguish `$add` (`__op: "add"`) and `$remove` (`__op: "remove"`) from plain `$set` (no `__op`)
- [ ] Accept `GET ?path=&command=` and return any JSON for freeform queries
- [ ] Return `null` (not omit) for paths that do not exist in batch responses
- [ ] Always return `{ "invalidate": [...] }` from mutations, even if the array is empty

Optional but recommended:

- [ ] Support `__next: true` on objects to defer expensive subtrees
- [ ] Support `__more: true` on objects with dynamic key sets
- [ ] Support `GET ?paths=&hierarchical=true` with a `__batch` response envelope
- [ ] Implement a relay channel for live invalidation across clients

---

## Quick reference

| Client call | HTTP method | Query params | Body |
|---|---|---|---|
| `await server.posts.page1` | GET | `path=posts.page1` | — |
| `await Promise.all([...])` or `$prefetch` | GET | `paths=["posts.page1","posts.page2"]` | — |
| `server.posts.$get({action:"paginate"})` | GET | `path=posts&command={...}` | — |
| `server.posts.page1.$set({title:"Hi"})` | POST | `path=posts.page1` | `{"title":"Hi"}` |
| `server.posts.$add({title:"New"})` | POST | `path=posts` | `{"__op":"add","value":{...}}` |
| `server.posts.page1.$remove()` | POST | `path=posts.page1` | `{"__op":"remove"}` |
