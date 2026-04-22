# dragonJSON NoSQL Server

A zero-dependency Node.js server that fully implements the dragonJSON client protocol.

NOTE: this uses an in-memory store. If you'd like a persistence layer, just swap out `getByPath` / `setByPath` / `deleteByPath` for commands to whatever DB you want. 

## Start

```bash
node server.js
# or: PORT=8080 node server.js
```

No npm install needed — only Node.js built-ins (`http`, `url`).

---

## Auth config

Defined at the top of `server.js` in the `authConfig` object. Shape:

```js
const authConfig = {
  "pathSegment": {
    $auth(token, accessArray) {
      // token       – Bearer token string (empty string if absent)
      // accessArray – path segments *after* this node
      // return true to allow, false to deny
      return token === "my-secret";
    },

    childSegment: {
      $auth(token, accessArray) {
        // accessArray = segments after "pathSegment.childSegment"
        return token === "admin-only";
      }
    }
  }
};
```

**Resolution rule — deepest match wins.**  
For path `users.user1.name`:

1. Checks `authConfig.users.user1.$auth` → called with `accessArray = ["name"]`
2. Falls back to `authConfig.users.$auth`  → called with `accessArray = ["user1", "name"]`
3. Falls back to `authConfig.$auth` (root) → called with full segment array
4. If no `$auth` found at any level → path is open (no restriction)

---

## Endpoints

All requests go to the same base URL. Operation is determined by method + query params.

| Client call | Method | Query | Body |
|---|---|---|---|
| `await server.posts.page1` | GET | `path=posts.page1` | — |
| `Promise.all([...])` | GET | `paths=["a","b"]` | — |
| `server.posts.$get({action:"paginate"})` | GET | `path=posts&command={...}` | — |
| `server.posts.page1.$set({…})` | POST | `path=posts.page1` | `{ …value… }` |
| `server.posts.$add({…})` | POST | `path=posts` | `{ __op:"add", value:{…} }` |
| `server.posts.page1.$remove()` | POST | `path=posts.page1` | `{ __op:"remove" }` |

### Special response fields

| Field | Meaning |
|---|---|
| `__next: true` | Object has children not yet sent; client fetches on demand |
| `__more: true` | Object has unknown/dynamic keys; client fetches any key on demand |
| `__batch: {}` | Hierarchical batch envelope (multiple paths in one response) |

### Built-in `$get` commands

Pass as `command={"action":"…"}` in the query string.

**`paginate`** — slice an object or array  
```json
{ "action": "paginate", "cursor": 0, "limit": 10 }
```
Returns `{ items, nextCursor, total }`.

**`search`** — full-text filter over an object's values  
```json
{ "action": "search", "query": "hello" }
```
Returns an array of matching entries.

---

## Extending

- **Persistence** — replace the in-memory `store` with file I/O, SQLite, Redis, etc.  
  Just keep `getByPath` / `setByPath` / `deleteByPath` pointing at your backing store.

- **Live invalidation relay** — when a mutation returns `{ invalidate }`, forward that
  payload over a WebSocket / SSE channel to other connected clients.

- **More commands** — add cases to `handleCommand()` to support custom `$get` actions.

- **Stricter root write protection** — add an `$auth` at the root of `authConfig`:
  ```js
  const authConfig = {
    $auth(token, accessArray) { return token === "root-secret"; },
    …
  };
  ```
