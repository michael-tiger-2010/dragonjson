/**
 * dragonJSON-compatible NoSQL server
 * ------------------------------------
 *
 * Auth config shape:
 *   {
 *     "some.path": {
 *       $auth(token, accessArray, operation) { return true/false },
 *       //  operation = "get" | "get:batch" | "get:command" | "set" | "add" | "remove"
 *       "child": {
 *         $auth(token, accessArray, operation) { ... }
 *       }
 *     }
 *   }
 *
 *
 */

const http = require("http");
const { URL } = require("url");

// IN MEMORY DATA STORE

let store = {
  meta: {
    title: "dragonJSON Demo",
    version: "1.0.0",
  },
  users: {
    user1: { name: "Alice", role: "admin" },
    user2: { name: "Bob",   role: "member" },
  },
  posts: {
    page1: { title: "Hello World", body: "First post body." },
    page2: { title: "Second Post", body: "Second post body." },
  },
};

// AUTH
//
// Keys are dot-separated path prefixes.
// $auth(token, accessArray, operation) → boolean
//   • operation is one of:
//       "get"         – single-path read
//       "get:batch"   – path appeared in a ?paths= batch
//       "get:command" – freeform $get with a command param
//       "set"         – $set (plain POST, no __op)
//       "add"         – $add (__op: "add")
//       "remove"      – $remove (__op: "remove")
//   • accessArray holds the path segments after the matched node.

const authConfig = {
  // Everything under "users" requires a valid token for reads;
  // only admins may write.
  users: {
    $auth(token, accessArray, operation) {
      // accessArray = segments after "users" e.g. ["user1"] or ["user1","name"]
      if (operation === "get" || operation === "get:batch") {
        return ["admin-secret", "readonly-token"].includes(token);
      }
      // mutations always require admin
      return token === "admin-secret";
    },

    // Writes into a specific user require the admin token
    user1: {
      $auth(token, accessArray, operation) {
        // accessArray = segments after "users.user1" e.g. ["name"]
        return token === "admin-secret";
      },
    },
  },

  // "meta" is public for reads, admin-only for writes
  meta: {
    $auth(token, accessArray, operation) {
      if (operation.startsWith("get")) return true;
      return token === "admin-secret";
    },
  },

  // "posts" is fully public
  posts: {
    $auth(token, accessArray, operation) {
      return true;
    },
  },
};


/**
 * Walk the authConfig tree to find the best matching $auth function.
 *
 * Strategy (deepest-match-wins):
 *   For path "users.user1.name":
 *     1. Try authConfig.users.user1.$auth  → found → call with accessArray=["name"]
 *     2. Else try authConfig.users.$auth   → call with accessArray=["user1","name"]
 *     3. Else try authConfig.$auth (root)  → call with accessArray=[...all segments]
 *     4. If no $auth found at any level → allow (open path)
 */
function findAuth(segments) {
  // Build candidate list from deepest to shallowest
  const candidates = [];
  let node = authConfig;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (node[seg] !== undefined && typeof node[seg] === "object") {
      node = node[seg];
      if (typeof node.$auth === "function") {
        candidates.push({ fn: node.$auth, remaining: segments.slice(i + 1) });
      }
    } else {
      break;
    }
  }

  // Also check root-level $auth
  if (typeof authConfig.$auth === "function") {
    candidates.unshift({ fn: authConfig.$auth, remaining: segments });
  }

  // Deepest match wins (last pushed = deepest)
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/**
 * Returns true if the request is authorised for the given path + operation.
 * An absent path prefix in authConfig means no restriction.
 *
 * @param {string|null} token     – Bearer token (or null)
 * @param {string}      pathStr   – dot-separated path e.g. "users.user1"
 * @param {string}      operation – "get" | "get:batch" | "get:command" | "set" | "add" | "remove"
 */
function isAuthorised(token, pathStr, operation) {
  if (!pathStr) return true; // root – add a root $auth to lock this down
  const segments = pathStr.split(".");
  const match = findAuth(segments);
  if (!match) return true; // no auth rule → open
  return match.fn(token || "", match.remaining, operation);
}

// DATA STORE

function getByPath(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setByPath(obj, segments, value) {
  let cur = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cur[seg] === undefined || typeof cur[seg] !== "object") {
      cur[seg] = {};
    }
    cur = cur[seg];
  }
  cur[segments[segments.length - 1]] = value;
}

function deleteByPath(obj, segments) {
  let cur = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (cur[seg] === undefined) return false;
    cur = cur[seg];
  }
  const last = segments[segments.length - 1];
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

function generateKey() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// REQUEST

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : null);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function extractToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// ROUTE

function handleGet(req, res, sp, token) {
  // Batched Fetch
  if (sp.has("paths")) {
    let pathList;
    try {
      pathList = JSON.parse(sp.get("paths"));
      if (!Array.isArray(pathList)) throw new Error();
    } catch {
      return send(res, 400, { error: "paths must be a JSON array" });
    }

    const result = {};
    for (const p of pathList) {
      if (!isAuthorised(token, p, "get:batch")) {
        result[p] = null; // treat unauthorised as not-found for the batch
        continue;
      }
      const segments = p ? p.split(".") : [];
      const value = segments.length ? getByPath(store, segments) : store;
      result[p] = value !== undefined ? value : null;
    }
    return send(res, 200, result);
  }

  const pathStr = sp.get("path") || "";
  const segments = pathStr ? pathStr.split(".") : [];

  // Auth
  const operation = sp.has("command") ? "get:command" : "get";
  if (!isAuthorised(token, pathStr, operation)) {
    return send(res, 403, { error: "Forbidden" });
  }

  // Freeform
  if (sp.has("command")) {
    let command;
    try {
      command = JSON.parse(sp.get("command"));
    } catch {
      return send(res, 400, { error: "command must be valid JSON" });
    }

    // !!!!!!!!! 
    // Here is where you define custom actions.

    // Example: { action: "paginate", cursor: 42 }
    const value = segments.length ? getByPath(store, segments) : store;
    if (value === undefined) return send(res, 404, { error: "Not found" });

    const queryResult = handleCommand(pathStr, value, command);
    return send(res, 200, queryResult);
  }

  // Hierarchical Data
  if (sp.get("hierarchical") === "true" && sp.has("target")) {
    const target = sp.get("target");
    const targetSegs = target ? target.split(".") : [];
    const batch = {};

    // Walk from root down to target and populate the batch envelope
    let cur = store;
    let acc = [];
    batch[""] = store; // root (optional)
    for (const seg of targetSegs) {
      if (cur === null || typeof cur !== "object" || !(seg in cur)) break;
      acc.push(seg);
      cur = cur[seg];
      const key = acc.join(".");
      if (isAuthorised(token, key, "get")) batch[key] = cur;
    }
    return send(res, 200, { __batch: batch });
  }

  // Single path
  const value = segments.length ? getByPath(store, segments) : store;
  if (value === undefined) return send(res, 404, { error: "Not found" });
  return send(res, 200, value);
}

/** Very simple built-in command handler — extend as needed */
function handleCommand(pathStr, data, command) {
  if (!command || typeof command !== "object") return data;

  if (command.action === "paginate") {
    if (!Array.isArray(data)) {
      // Convert object to array, then paginate
      const entries = Object.entries(data);
      const cursor = command.cursor || 0;
      const limit  = command.limit  || 10;
      return {
        items:      Object.fromEntries(entries.slice(cursor, cursor + limit)),
        nextCursor: cursor + limit < entries.length ? cursor + limit : null,
        total:      entries.length,
      };
    }
    const cursor = command.cursor || 0;
    const limit  = command.limit  || 10;
    return {
      items:      data.slice(cursor, cursor + limit),
      nextCursor: cursor + limit < data.length ? cursor + limit : null,
      total:      data.length,
    };
  }

  if (command.action === "search") {
    const q = (command.query || "").toLowerCase();
    if (typeof data !== "object" || Array.isArray(data)) return [];
    return Object.entries(data)
      .filter(([, v]) =>
        JSON.stringify(v).toLowerCase().includes(q)
      )
      .map(([k, v]) => ({ key: k, ...v }));
  }

  // Unknown command — return data unchanged
  return data;
}

async function handlePost(req, res, sp, token) {
  const pathStr = sp.get("path") || "";
  const segments = pathStr ? pathStr.split(".") : [];

  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, { error: "Invalid JSON body" });
  }

  if (body === null) return send(res, 400, { error: "Body required" });

  // Determine operation from body before auth check
  const operation =
    body.__op === "remove" ? "remove" :
    body.__op === "add"    ? "add"    : "set";

  // Auth again
  if (!isAuthorised(token, pathStr, operation)) {
    return send(res, 403, { error: "Forbidden" });
  }

  // $remove
  if (operation === "remove") {
    if (segments.length === 0) return send(res, 400, { error: "Cannot remove root" });
    deleteByPath(store, segments);
    const parentPath = segments.slice(0, -1).join(".");
    return send(res, 200, { invalidate: [parentPath || ""].filter(Boolean).concat([pathStr]) });
  }

  // $add
  if (operation === "add") {
    const parent = segments.length ? getByPath(store, segments) : store;
    if (parent === undefined || typeof parent !== "object") {
      return send(res, 400, { error: "Parent path is not an object" });
    }

    const key = (body.key && !parent[body.key]) ? body.key : generateKey();
    const newSegments = [...segments, key];
    setByPath(store, newSegments, body.value);
    return send(res, 200, { invalidate: [pathStr] });
  }

  // $set
  if (segments.length === 0) {
    if (typeof body !== "object" || Array.isArray(body)) {
      return send(res, 400, { error: "Root $set must be an object" });
    }
    store = body;
  } else {
    setByPath(store, segments, body);
  }
  return send(res, 200, { invalidate: [pathStr] });
}

// Server

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  // CORS (helpful for browser clients)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    return send(res, 400, { error: "Bad request URL" });
  }

  const sp    = url.searchParams;
  const token = extractToken(req);

  try {
    if (req.method === "GET") {
      return handleGet(req, res, sp, token);
    } else if (req.method === "POST") {
      return await handlePost(req, res, sp, token);
    } else {
      return send(res, 405, { error: "Method not allowed" });
    }
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`dragonJSON server listening on http://localhost:${PORT}`);
});
