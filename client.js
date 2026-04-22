/**
 * dragonJSON
 *
 * A lazy-loading JSON client that progressively fetches data from a structured
 * endpoint. Designed for JSON-like databases (e.g. NoSQL), where you want to
 * load only what you need, when you need it.
 *
 * Every property access returns a proxy. You must 'await' to resolve a value:
 * ||    let posts = await server.posts
 * ||    let body  = await server.posts.page1.content.body
 *
 *
 * ── INIT ────────────────────────────────────────────────────────────────────
 *
 * ||    const [server, control] = dragonJSON("https://mysite.com/api", {
 * ||        debug: false,
 * ||        enableBatching: true,         // batches rapid requests (default: true)
 * ||        auth: "Bearer my-token",
 * ||        headers: {},
 * ||        liveInvalidation: {           // optional: real-time sync (see below)
 * ||            sendRelayMessage: fn,
 * ||            onReceiveCallback: fn,
 * ||        }
 * ||    });
 *
 *
 * ── READING ─────────────────────────────────────────────────────────────────
 *
 * Await any path to fetch and resolve it. Parent fetches are cached, so
 * subsequent accesses to children are instant.
 *
 * ||    let title = await server.posts.page1.title
 *
 * Prefetch multiple paths in parallel:
 * ||    await Promise.all([server.posts.page1, server.posts.page2])
 *
 * Or use $prefetch with an array of subpath keys at the current scope:
 * ||    await server.posts.$prefetch(["page1", "page2"])
 *
 *
 * ── CHECKING EXISTENCE ──────────────────────────────────────────────────────
 *
 * Check if a path is already in the local cache (no network call):
 * ||    if (await server.posts.page2.$loaded())
 *
 * Check if a path exists, fetching from the server if needed:
 * ||    if (await server.posts.page2.$exists())
 *
 *
 * ── MUTATIONS ───────────────────────────────────────────────────────────────
 *
 * All mutations POST to the server and expect back:
 * ||    { invalidate: ["path.to.refresh", ...] }
 *
 * The client will mark those cached paths as stale and re-fetch on next access.
 * After invalidation, the relevant .$on() listeners are fired automatically.
 *
 *
 * $set — update a value at the current path, or at a child key:
 * ||    await server.posts.$set({ title: "Hello" })    // sets posts itself
 * ||    await server.posts.$set("title", "Hello")      // sets posts.title
 *
 * $add — add a new entry at the current path. The server assigns the key,
 *         or you can suggest one:
 * ||    await server.posts.$add({ title: "New Post" })          // server picks key
 * ||    await server.posts.$add("page5", { title: "New Post" }) // suggest key
 * ||    await server.posts.$add({ key: "page5", obj: { ... } }) // object form
 *
 *   POST body will contain: { __op: "add", key?: string, value: any }
 *
 * $remove — delete the current path, or a child key:
 * ||    await server.posts.page1.$remove()       // removes posts.page1
 * ||    await server.posts.$remove("page1")      // same thing
 *
 * $get — send a freeform command to the server without touching the cache.
 *         Useful for pagination, search, or any query that returns transient data:
 * ||    const page = await server.posts.$get({ action: "paginate", cursor: 42 })
 *
 *   The server receives ?path=posts&command={"action":"paginate","cursor":42}
 *   and may return any JSON it likes. The result is returned directly to you.
 *
 *
 * ── CACHE CONTROL ───────────────────────────────────────────────────────────
 *
 * Mark a path as stale and re-fetch it on next access:
 * ||    await server.posts.$refresh()
 *
 *
 * ── EVENTS ──────────────────────────────────────────────────────────────────
 *
 * Listen for mutations at a specific path using .$on():
 *
 * ||    await server.posts.$on(type, key, callback, mode)
 *
 *   type     — "add" | "remove" | "set" | "*"  (which operation to listen for)
 *   key      — a specific child key, or "*" to match any / the node itself
 *   callback — function(event) fired on match
 *   mode     — "direct" (default) | "bubble"
 *              "direct" only fires when the event is on this exact path.
 *              "bubble" fires when the event originates at this path OR any
 *              descendant — like DOM event bubbling.
 *
 * The event object passed to your callback:
 * ||    {
 * ||        initiator: "add" | "remove" | "set" | "*",
 * ||        key:       the key that was affected,
 * ||        path:      the path array of the origin,
 * ||        data:      a proxy to the affected path (lazy, re-fetch if needed),
 * ||        invalidate: [...],   // paths the server said to invalidate
 * ||    }
 *
 * Examples:
 * ||    // fire when any key is added under posts
 * ||    server.posts.$on("add", "*", (e) => console.log("added", e.key))
 *
 * ||    // fire only when posts.page1 is removed
 * ||    server.posts.$on("remove", "page1", onPage1Removed)
 *
 * ||    // bubble: fire on any mutation anywhere under posts
 * ||    server.posts.$on("*", "*", handler, "bubble")
 *
 * Remove a listener with .$off() — all four arguments must match:
 * ||    server.posts.$off("add", "*", handler)
 * ||    server.posts.$off("add", "*", handler, "bubble")
 *
 *
 * ── LIVE INVALIDATION ───────────────────────────────────────────────────────
 *
 * Pass liveInvalidation in options to sync cache invalidations across clients
 * in real time (e.g. over a WebSocket). When one client mutates data, all
 * other connected clients are notified and their caches are updated.
 *
 * ||    const [server] = dragonJSON("https://mysite.com/api", {
 * ||        liveInvalidation: {
 * ||            sendRelayMessage:   (msg) => socket.emit("invalidate", msg),
 * ||            onReceiveCallback:  (cb)  => socket.on("invalidate", cb),
 * ||        }
 * ||    });
 *
 * sendRelayMessage   — called automatically after every local mutation
 *                      ($set, $add, $remove). Sends the invalidation + event
 *                      metadata to your relay (WebSocket, BroadcastChannel, etc).
 *
 * onReceiveCallback  — called once at init. You give it a function; dragonJSON
 *                      will call that function with incoming relay messages.
 *                      On receipt, the relevant cache paths are marked stale
 *                      and the matching .$on() listeners are fired locally —
 *                      exactly as if the mutation had happened on this client.
 *                      Received messages are never re-relayed (no loops).
 *
 * The relay message shape (if you want to intercept it or filter it out):
 * ||    {
 * ||        invalidate: ["posts.page1", ...],
 * ||        initiator:  "add" | "remove" | "set",
 * ||        key:        "page1",
 * ||        path:       "posts",
 * ||    }
 * 
 * Note: to stay within this server-client framework, make something like
 * ||    server.relay.on('set') // recieve message from server
 * ||    server.relay.set('key', 'value') // send message to relay
 * and configure the server to not actually set values, only validate users, etc.
 *
 *
 * ── WILDCARDS / __more ──────────────────────────────────────────────────────
 *
 * If your server returns __more: true on a node, dragonJSON treats that node
 * as having unknown children and will fetch any accessed key on demand.
 * This is useful for open-ended collections where you don't know all keys
 * up front (e.g. user-generated content, dynamic routes).
 *
 *
 * ── CONTROLLER ──────────────────────────────────────────────────────────────
 *
 * The second element of the return value is a control object:
 *
 * ||    const [server, control] = dragonJSON(...)
 *
 * ||    control.setOptions({ debug: true })       // update options at runtime
 * ||    control.on("direct", "posts", handler)    // attach a global path listener
 * ||    control.off("direct", "posts", handler)   // detach it
 * ||    control.debug.getCache()                  // dump the current cache to log
 *
 *
 * ── CONSTRAINTS ─────────────────────────────────────────────────────────────
 *
 * - Property names must not contain "."
 * - Property names cannot be "then" or "exists"
 * - Property names cannot start with "$"
 * - Your server must return { invalidate: [...] } from all mutation endpoints
 *
 */

const dragonJSON = (url, options) => {
    if (!url) throw new Error("Need a URL");
    const targetUrl = new URL(url);
    
    // our own local cache
    const rootData = { __next: true };
    const events = {};
    const pendingFetches = new Map();
    
    const debugging = options.debug;
    const logFunc = options.logFunc ?? ((...errs)=>{console.log('[dragonJSON]',...errs)});
    
    options = {
        enableBatching: true,
        ...options
    }

    // Live invalidation relay
    if (options.liveInvalidation) {
        const { onReceiveCallback } = options.liveInvalidation;
        if (typeof onReceiveCallback === 'function') {
            onReceiveCallback((message) => {
                const paths = message?.invalidate;
                if (!Array.isArray(paths)) return;
            
                for (let pathStr of paths) {
                    const parts = pathStr.split('.');
                    let scope = rootData;
            
                    for (let i = 0; i < parts.length - 1; i++) {
                        scope = scope[parts[i]];
                        if (!scope) break;
                    }
            
                    if (scope && parts.length > 0) {
                        const lastKey = parts[parts.length - 1];
                        if (scope[lastKey] !== undefined) {
                            if (scope[lastKey] instanceof Object) {
                                scope[lastKey] = { __next: true };
                            } else {
                                delete scope[lastKey];
                            }
                        }
                    }
                }
            
                // Fire events via a proxy at the originating path
                // but DON'T re-relay (it came from the relay)
                const savedSend = options.liveInvalidation.sendRelayMessage;
                options.liveInvalidation.sendRelayMessage = null;
            
                const parts = message.path?.split('.') ?? [];
                const proxy = createProxy(parts);
                proxy.__dispatchEvent({
                    path: parts,
                    initiator: message.initiator ?? "*",
                    key: message.key ?? "*",
                    invalidate: message.invalidate,
                    data: createProxy(parts),
                });
            
                options.liveInvalidation.sendRelayMessage = savedSend;
            });
        }
    }


    // ugh complex things to make sure ppl don't dos themselves
    const batchQueue = [];
    let batchTimeout = null;
    
    
    function getCurrentScopeKeys(failedPath) {
        let scope = rootData;
        for (let i = 0; i < failedPath.length - 1; i++) {
            scope = scope[failedPath[i]];
            if (!scope) return `(parent does not exist; resolved to ${failedPath.slice(0,i).join('.')})`;
        }
        if (scope && typeof scope === 'object') {
            return Object.keys(scope).filter(k => !k.startsWith('__')).join(', ') || '(resolved; was empty object)';
        }
        return '(resolved; not an object)';
    }
    
    async function fetchPath(pathArray, ops = options) {
        if(debugging) logFunc(`fetching [${pathArray}], ${options.enableBatching?'batched':'not batched'}`);
        // Check if batching is enabled
        if (ops.enableBatching) {
            return new Promise((resolve, reject) => {
                batchQueue.push({ pathArray, resolve, reject });
                
                // Debounce: wait a tiny bit to collect more requests
                clearTimeout(batchTimeout);
                batchTimeout = setTimeout(flushBatch, 100); // 5ms window
            });
        }
        
        if(debugging) logFunc(`fetch started [${pathArray}]`);
        // normalyboi
        const copy = new URL(targetUrl.href);
        copy.searchParams.append('path', pathArray.join('.'));
        const res = await fetch(copy.href, {
            ...ops,
            headers: {
                ...ops.headers,
                ...(options.auth ? { Authorization: options.auth } : {}),
            }
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);
        const givenJson = await res.json();
        if(debugging) logFunc(`fetch result [${pathArray}]`, givenJson);
        return givenJson;
    }
    
    
    
    async function flushBatch() {
        if (batchQueue.length === 0) return;
        if(debugging) logFunc(`flushing batch queue`);
        
        const batch = [...batchQueue];
        batchQueue.length = 0;
        
        // Send all paths at once
        const copy = new URL(targetUrl.href);
        copy.searchParams.append('paths', JSON.stringify(
            batch.map(b => b.pathArray.join('.'))
        ));
        
        if(debugging) logFunc(`batch calling "${copy.search}"`);
        
        try {
            const res = await fetch(copy.href, {
                ...options,
                headers: {
                    ...options.headers,
                    ...(options.auth ? { Authorization: options.auth } : {}),
                }
            });
            if (!res.ok) throw new Error(`Batch fetch failed: ${res.status}`);
            
            const results = await res.json(); // { "some.path": {...}, "other.path": {...} }
            if(debugging) logFunc(`batch queue result`, results);
            
            // Resolve each promise with its result
            batch.forEach(({ pathArray, resolve, reject }) => {
                const key = pathArray.join('.');
                if (results[key] !== undefined) {
                    resolve(results[key]);
                } else {
                    reject(new Error(`Path ${key} not found in batch response`));
                }
            });
        } catch (e) {
            // Reject all if batch fails
            // this will ONLY be called in event of server error
            // the server should return a complete object but with undefined.
            batch.forEach(({ reject }) => reject(e));
        }
    }

    // beeg function: traverse cache, fetch if missing, update cache
    async function resolvePath(pathArray) {
        try{
        
        let current = rootData;
        if(debugging) logFunc(`resolving path ${pathArray.join('.')}`);
        
        // First, traverse as far as we can with cached data
        let firstMissingIndex = -1;
        for (let i = 0; i < pathArray.length; i++) {
            const key = pathArray[i];
            
            if (current.__next || (current[key] === undefined && current.__more)) {
                firstMissingIndex = i;
                break;
            }
            
            current = current[key];
            if (current === undefined) return undefined;
        }
        
        if(debugging) logFunc(`${pathArray.join('.')} not in cache, will query`);
        
        // If we found everything in cache, check if final result needs expansion
        if (firstMissingIndex === -1) {
            if (current && current.__next) {
                firstMissingIndex = pathArray.length;
            } else {
                // Everything cached, return it
                if (current instanceof Object) {
                    return createProxy(pathArray, false);
                }
                return current;
            }
        }
        
        
        // We need to fetch - determine the path to fetch
        const pathToFetch = firstMissingIndex === pathArray.length 
            ? pathArray 
            : pathArray.slice(0, firstMissingIndex === 0 ? 1 : firstMissingIndex);
        
        const pathKey = pathToFetch.join('.');
        
        
        if(debugging) logFunc(`${pathArray.join('.')} fetching for ${pathToFetch}`);
        
        // Check if already fetching this path
        if (!pendingFetches.has(pathKey)) {
            const fetchPromise = fetchPathHierarchical(pathToFetch, pathArray)
                .then(batchData => {
                    // Process all returned paths and update cache
                    processBatchData(batchData);
                    pendingFetches.delete(pathKey);
                    return batchData;
                })
                .catch(e => {
                    pendingFetches.delete(pathKey);
                    throw e;
                });
            
            pendingFetches.set(pathKey, fetchPromise);
        }
        
        // Wait for fetch to complete
        await pendingFetches.get(pathKey);
        
        if(debugging) logFunc(`${pathArray.join('.')} successful fetch`);
        
        // Now traverse again with the updated cache
        current = rootData;
        for (let i = 0; i < pathArray.length; i++) {
            const key = pathArray[i];
            
            // Handle __next placeholders
            if (current.__next) {
                const currentPath = pathArray.slice(0, i);
                const currentPathKey = currentPath.join('.');
                
                if (!pendingFetches.has(currentPathKey)) {
                    const fetchPromise = fetchPathHierarchical(currentPath, pathArray)
                        .then(data => {
                            processBatchData(data);
                            pendingFetches.delete(currentPathKey);
                            return data;
                        })
                        .catch(e => {
                            pendingFetches.delete(currentPathKey);
                            throw e;
                        });
                    pendingFetches.set(currentPathKey, fetchPromise);
                }
                await pendingFetches.get(currentPathKey);
                delete current.__next;
            }
            
            // Handle __more (wildcard) paths
            if (current[key] === undefined && current.__more) {
                const missingPath = pathArray.slice(0, i + 1);
                const missingPathKey = missingPath.join('.');
                
                if (!pendingFetches.has(missingPathKey)) {
                    const fetchPromise = fetchPathHierarchical(missingPath, pathArray)
                        .then(data => {
                            processBatchData(data);
                            pendingFetches.delete(missingPathKey);
                            return data;
                        })
                        .catch(e => {
                            pendingFetches.delete(missingPathKey);
                            throw e;
                        });
                    pendingFetches.set(missingPathKey, fetchPromise);
                }
                await pendingFetches.get(missingPathKey);
            }
            
            current = current[key];
            if (current === undefined) return undefined;
        }
        
        if(debugging) logFunc(`${pathArray.join('.')} finished final navigation`);
        
        // Final check on the result itself
        if (current && current.__next) {
            
            if(debugging) logFunc(`${pathArray.join('.')} result needs expansion, expanding`);
            const finalPathKey = pathArray.join('.');
            
            if (!pendingFetches.has(finalPathKey)) {
                const fetchPromise = fetchPathHierarchical(pathArray, pathArray)
                    .then(data => {
                        processBatchData(data);
                        pendingFetches.delete(finalPathKey);
                        return data;
                    })
                    .catch(e => {
                        pendingFetches.delete(finalPathKey);
                        throw e;
                    });
                
                pendingFetches.set(finalPathKey, fetchPromise);
            }
            
            await pendingFetches.get(finalPathKey);
            
            delete current.__next;
            
            // Re-traverse to get the updated value
            current = rootData;
            for (let part of pathArray) {
                current = current[part];
                if (current === undefined) return undefined;
            }
        }
        
        if (current instanceof Object) {
            if(debugging) logFunc(`${pathArray.join('.')} returned as proxy`);
            return createProxy(pathArray, false);
        }
        
        
        if(debugging) logFunc(`${pathArray.join('.')} returned as primitive`);
        return current;
        
        
        }catch(e){
            console.error("Failed to resolve.",getCurrentScopeKeys(pathArray));
            throw e;
        }
    }
    
    // New function to fetch with hierarchical data
    async function fetchPathHierarchical(pathToFetch, fullPathRequested) {
        const copy = new URL(targetUrl.href);
        
        if (options.enableHierarchicalBatch) {
            // Send both the immediate path and the full path we're trying to reach
            copy.searchParams.append('path', pathToFetch.join('.'));
            copy.searchParams.append('target', fullPathRequested.join('.'));
            copy.searchParams.append('hierarchical', 'true');
        } else {
            // Fallback to simple fetch
            copy.searchParams.append('path', pathToFetch.join('.'));
        }
        
        const res = await fetch(copy.href, {
            ...options,
            headers: {
                ...options.headers,
                ...(options.auth ? { Authorization: options.auth } : {}),
            }
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}. Trying to load ${pathToFetch.join('.')}`);
        
        const data = await res.json();
        
        // Check if server returned hierarchical batch data
        if (data.__batch) {
            return data;
        }
        
        // Server didn't support hierarchical batching, wrap in batch format
        return {
            __batch: {
                [pathToFetch.join('.')]: data
            }
        };
    }
    
    // Process batch data and update cache
    function processBatchData(batchData) {
        if (!batchData.__batch) {
            // Not a batch response, shouldn't happen but handle gracefully
            return;
        }
        
        // Sort paths by depth (shallowest first) to ensure parents exist
        const sortedPaths = Object.keys(batchData.__batch).sort((a, b) => {
            return a.split('.').length - b.split('.').length;
        });
        
        for (let pathStr of sortedPaths) {
            const data = batchData.__batch[pathStr];
            const parts = pathStr.split('.');
            
            // Navigate to the parent
            let scope = rootData;
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                
                // Create intermediate objects if they don't exist
                if (scope[part] === undefined) {
                    scope[part] = {};
                }
                
                // If it's a placeholder, initialize it
                if (scope[part].__next) {
                    delete scope[part].__next;
                }
                
                scope = scope[part];
            }
            
            const lastKey = parts[parts.length - 1];
            
            // Update or create the final key
            if (scope[lastKey] === undefined || scope[lastKey].__next) {
                scope[lastKey] = data;
            } else if (scope[lastKey] instanceof Object && data instanceof Object) {
                // Merge if both are objects
                Object.assign(scope[lastKey], data);
            } else {
                // Replace primitives or mismatched types
                scope[lastKey] = data;
            }
            
            // Clean up __next flag if present
            if (scope[lastKey] && scope[lastKey].__next) {
                delete scope[lastKey].__next;
            }
        }
    }


    const arrayProps = Object.getOwnPropertyNames(Array.prototype);
    const blacklist = new Set([...arrayProps, "valueOf", "toString", "length", "constructor", "prototype", Symbol.toStringTag, Symbol.toPrimitive]);

    // PROXY LETS GOOOOOOO
    const handler = {
        get(target, prop) {
            
            if(debugging) logFunc(`${target.path.join('.')} proxy tripped with "${prop}"`);
            // i hate that we need to intercept await
            if (prop === 'then' && target.doPromise) {
                // when 'await proxy' happens, this runs.
                // call resolvePath, and when THAT resolves, we call the user's resolve.
                return (resolve, reject) => {
                    resolvePath(target.path)
                        .then(resolve)
                        .catch(reject);
                };
            }
            
            
            if(blacklist.has(prop)){
                throw new Error("Some default actions have been triggered. Did you forget 'await' somewhere?");
            }
            
            
            let wildcards = ((top)=>({
                // already cached
                async $loaded(){
                    let scope = rootData;
                    for(let part of top.path){
                        scope = scope[part];
                        if(scope===undefined || scope.__next){
                            if(debugging) logFunc(`${top.path.join('.')} existsNow false`);
                            return false;
                        }
                    }
                    
                    if(debugging) logFunc(`${top.path.join('.')} existsNow true`);
                    return true;
                },
                // we need to try and load it
                async $exists(){
                    return new Promise((res)=>{
                        resolvePath(top.path).then(x=>res(true)).catch(e=>res(false))
                    })
                },
                async $refresh(){
                    let scope = rootData;
                    for(let part of top.path.slice(0,-1)){
                        scope = scope[part];
                    }
                    if(scope[top.path.at(-1)] instanceof Object){
                        // this works because every time you need it it'll reload. So this actually saves requests
                        if(debugging) logFunc(`${top.path.join('.')} refresh is JSON`);
                        scope[top.path.at(-1)] = {__next: true};
                    }else{
                        // top level primitives count as JSON as well!
                        if(debugging) logFunc(`${top.path.join('.')} refresh is primitive`);
                        scope[top.path.at(-1)] = await fetchPath(top.path);
                    }
                    
                    await wildcards.__dispatchEvent({
                        path: top.path,
                        data: createProxy(top.path),
                        initiator: "refresh"
                    })
                    
                    return createProxy(top.path);
                },
                
                // you could use this as an endpoint service if you wanted
                // by sending data.
                // Your milage may vary.
                async $set(keyOrData, value) {
                    let path = top.path;
                    let body;
                
                    if (value !== undefined) {
                        // $set(key, value) — target a subpath
                        path = [...top.path, keyOrData];
                        body = JSON.stringify(value);
                    } else {
                        // $set(data) — normal behavior
                        body = JSON.stringify(keyOrData);
                    }
                
                    let result;
                    try {
                        result = await fetchPath(path, { method: "POST", body, ...options });
                    } catch(e) {
                        throw new Error(`$set on ${path.join('.')} failed`, e);
                    }
                
                    if (result.invalidate) {
                        for (let pathStr of result.invalidate) {
                            const parts = pathStr.split('.');
                            let scope = rootData;
                            for (let i = 0; i < parts.length - 1; i++) {
                                scope = scope[parts[i]];
                                if (!scope) break;
                            }
                            if (scope && parts.length > 0) {
                                const lastKey = parts[parts.length - 1];
                                if (scope[lastKey] instanceof Object) {
                                    scope[lastKey] = { __next: true };
                                }
                            }
                        }
                    } else {
                        if (Array.isArray(result.invalidate)) return;
                        throw new Error(`$set on ${path.join('.')} server returned invalid response`);
                    }
                    await wildcards.__dispatchEvent({
                        path: top.path,
                        initiator: "set",
                        key: value !== undefined ? keyOrData : "*",
                        invalidate: result.invalidate,
                        data: createProxy(top.path),
                    });
                },
                
                async $add(keyOrObj, obj) {
                    let path = top.path;
                    let body;
                
                    if (obj !== undefined) {
                        // $add(key, obj) — append at subpath
                        body = JSON.stringify({ __op: "add", key: keyOrObj, value: obj });
                    } else if (keyOrObj && typeof keyOrObj === 'object' && 'key' in keyOrObj && 'obj' in keyOrObj) {
                        // $add({ key, obj })
                        body = JSON.stringify({ __op: "add", key: keyOrObj.key, value: keyOrObj.obj });
                    } else {
                        // $add(obj) — server assigns key
                        body = JSON.stringify({ __op: "add", value: keyOrObj });
                    }
                
                    let result;
                    try {
                        result = await fetchPath(path, { method: "POST", body, ...options });
                    } catch(e) {
                        throw new Error(`$add on ${path.join('.')} failed`, e);
                    }
                
                    if (result.invalidate) {
                        for (let pathStr of result.invalidate) {
                            const parts = pathStr.split('.');
                            let scope = rootData;
                            for (let i = 0; i < parts.length - 1; i++) {
                                scope = scope[parts[i]];
                                if (!scope) break;
                            }
                            if (scope && parts.length > 0) {
                                const lastKey = parts[parts.length - 1];
                                scope[lastKey] = { __next: true };
                            }
                        }
                    } else {
                        if (Array.isArray(result.invalidate)) return;
                        throw new Error(`$add on ${path.join('.')} server returned invalid response`);
                    }
                    await wildcards.__dispatchEvent({
                        path: top.path,
                        initiator: "add",
                        key: obj !== undefined ? keyOrObj
                           : (keyOrObj && 'key' in keyOrObj ? keyOrObj.key : "*"),
                        invalidate: result.invalidate,
                        data: createProxy(top.path),
                    });
                },
                
                async $remove(key) {
                    const path = key !== undefined ? [...top.path, key] : top.path;
                    const body = JSON.stringify({ __op: "remove" });
                
                    let result;
                    try {
                        result = await fetchPath(path, { method: "POST", body, ...options });
                    } catch(e) {
                        throw new Error(`$remove on ${path.join('.')} failed`, e);
                    }
                
                    if (result.invalidate) {
                        for (let pathStr of result.invalidate) {
                            const parts = pathStr.split('.');
                            let scope = rootData;
                            for (let i = 0; i < parts.length - 1; i++) {
                                scope = scope[parts[i]];
                                if (!scope) break;
                            }
                            if (scope && parts.length > 0) {
                                const lastKey = parts[parts.length - 1];
                                delete scope[lastKey]; // actually evict from cache
                            }
                        }
                    } else {
                        if (Array.isArray(result.invalidate)) return;
                        throw new Error(`$remove on ${path.join('.')} server returned invalid response`);
                    }
                    await wildcards.__dispatchEvent({
                        path: top.path,
                        initiator: "remove",
                        key: key ?? "*",
                        invalidate: result.invalidate,
                        data: createProxy(top.path),
                    });
                },
                
                // escape hatch: advanced server behavior
                async $get(command) {
                    const copy = new URL(targetUrl.href);
                    copy.searchParams.append('path', top.path.join('.'));
                    copy.searchParams.append('command', JSON.stringify(command));
                
                    const res = await fetch(copy.href, {
                        ...options,
                        headers: {
                            ...options.headers,
                            ...(options.auth ? { Authorization: options.auth } : {}),
                        }
                    });
                    if (!res.ok) throw new Error(`$get on ${top.path.join('.')} failed: ${res.status}`);
                    return await res.json();
                },
                
                async $prefetch(paths){
                    let res = [];
                    for(let path of paths){
                        res.push(await resolvePath(top.path.concat(path)));
                    }
                    return res;
                },
                
                async $debug(){
                    logFunc('debugging');
                    logFunc(top.path);
                    let scope = rootData;
                    for(let part of top.path){
                        scope = scope[part];
                        console.log(scope);
                    }
                    logFunc('end debugging');
                },
                
                $on(type, key, func, mode = "direct") {
                    if (!["add", "remove", "set", "*"].includes(type)) {
                        throw new Error('$on type must be "add", "remove", "set", or "*"');
                    }
                    if (mode !== "bubble" && mode !== "direct") {
                        throw new Error('$on mode must be "bubble" or "direct"');
                    }
                    const pathString = top.path.join('.');
                    if (!events[pathString]) events[pathString] = {};
                    if (!events[pathString][mode]) events[pathString][mode] = [];
                    const entry = { type, key, func };
                    if (!events[pathString][mode].some(e => e.func === func && e.type === type && e.key === key)) {
                        events[pathString][mode].push(entry);
                    }
                },
                
                $off(type, key, func, mode = "direct") {
                    const pathString = top.path.join('.');
                    if (!events[pathString]?.[mode]) return;
                    const arr = events[pathString][mode];
                    const idx = arr.findIndex(e => e.func === func && e.type === type && e.key === key);
                    if (idx !== -1) arr.splice(idx, 1);
                },
                
                
                
                // too lazy to write a thing for this, just take the duplicated code ok
                //loaded
                async $l(...args){return await this.loaded(...args)},
                //exists
                async $e(...args){return await this.exists(...args)},
                // refresh
                async $r(...args){return await this.refresh(...args)},
                // remove
                async $re(...args){return await this.refresh(...args)},
                // set
                async $s(...args){return await this.set(...args)},
                // prefetch
                async $p(...args){return await this.prefetch(...args)},
                // debug
                async $d(...args){return await this.debug(...args)},
                // add ... how lazy, it's two more chars
                async $a(...args){return await this.add(...args)},
                
                
                async __dispatchEvent(data) {
                    if (debugging) logFunc(`${top.path.join('.')} event dispatched with`, data);
                    const path = top.path;
                    const directPath = path.join('.');
                
                    const fireMatching = (listenerList) => {
                        if (!listenerList) return;
                        for (const entry of listenerList) {
                            const typeMatch = entry.type === "*" || entry.type === data.initiator;
                            const keyMatch = entry.key === "*" || entry.key === data.key;
                            if (typeMatch && keyMatch) entry.func(data);
                        }
                    };
                
                    // Direct listeners on the exact path
                    fireMatching(events[directPath]?.["direct"]);
                
                    // Bubble listeners on each ancestor suffix
                    for (let i = 0; i < path.length; i++) {
                        const curPath = path.slice(i).join('.');
                        fireMatching(events[curPath]?.["bubble"]);
                    }
                
                    // Relay to other clients if configured
                    if (options.liveInvalidation?.sendRelayMessage) {
                        options.liveInvalidation.sendRelayMessage({
                            invalidate: data.invalidate ?? [],
                            initiator: data.initiator,
                            key: data.key,
                            path: directPath,
                        });
                    }
                },
            }))(target)
            
            if (prop.startsWith('$')){
                return ((wildcards)[prop] || (()=>{throw new Error("Invalid $ function")}))()
            }
            // deepProxying hehe
            return createProxy([...target.path, prop]);
        },

        // stop ppl from just assigning in
        set() {
            throw new Error(`dragonJSON objects are immutable client-side. Use .$set()`);
        },
        
        apply() {
          throw new Error("dragonJSON proxy was called as a function. Remember to use 'await'.");
        },
        
        construct() {
          throw new Error("dragonJSON tried to be constructed (through new). Remember to use 'await'.");
        },
        
        ownKeys(target) {
            if(debugging) logFunc(`${target.path.join('.')} ownkeys`);
            let scope = rootData;
            for(let part of target.path){
                scope = scope[part];
                if(scope===undefined){
                    if(debugging) logFunc(`${target.path.join('.')} ownkeys could not navigate down, navigated to "${part}". Did you remember to await the input?`);
                    return []; // we don't know, or it doesn't exist
                }
            }
            if(scope.__next){
                if(debugging) logFunc(`${target.path.join('.')} ownkeys navigated but it wasn't loaded. Did you remember to await the input?`);
                return []; // we don't know either
            }
            if(!(scope instanceof Object)){ // it's a string or number
                if(debugging) logFunc(`${target.path.join('.')} ownkeys navigated to a primitive.`);
                return [];
            }
            return Object.keys(scope).filter(e=>e!=="__more");
        }
    };

    function createProxy(path, doPromise = true) {
        if(debugging) logFunc(`created new proxy at ${path.join('.')}`);
        return new Proxy({ path, doPromise }, handler);
    }
    
    return [
            // Start with empty path
            createProxy([]),
            
            // control function (can be expanded)
            {
                setOptions(ops){
                    if(ops.debugLockedOff || options.debugLockedOff){ //security ig
                        ops = {
                            ...ops,
                            debug: false,
                        }
                        debugging = false;
                    }
                    options = ops;
                    debugging = ops.debug;
                },
                debug: {
                    getCache(){
                        if(debugging){
                            logFunc(rootData);
                        }
                    }
                }
            }
        ];
};
const dJSON = dragonJSON;
