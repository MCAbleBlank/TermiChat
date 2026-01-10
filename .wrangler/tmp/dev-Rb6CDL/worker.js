var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// server/worker.mjs
var MEMORY_HISTORY = [];
var MEMORY_USER_REGISTRY = {};
var REGISTRY_KEY = "user_registry";
var CLIENTS = /* @__PURE__ */ new Map();
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    const url = new URL(request.url);
    if (url.pathname === "/stream" && request.method === "GET") {
      const clientId = url.searchParams.get("clientId");
      if (!clientId) return new Response("Missing clientId", { status: 400 });
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const intervalId = setInterval(() => {
            sendSSE(controller, { type: "ping" }, "ping");
          }, 15e3);
          CLIENTS.set(clientId, {
            controller,
            username: "Anonymous",
            clientId,
            intervalId
          });
          sendSSE(controller, {
            type: "system",
            content: `Connected via SSE (HTTP). Session ID: ${clientId.substring(0, 8)}...`
          });
          sendHistory(controller, env).catch((err) => console.error(err));
        },
        cancel() {
          const session = CLIENTS.get(clientId);
          if (session && session.intervalId) {
            clearInterval(session.intervalId);
          }
          handleDisconnect(clientId, env);
        }
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }
    if (url.pathname === "/action" && request.method === "POST") {
      try {
        const body = await request.json();
        await handleAction(body, env);
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" }
        });
      }
    }
    return new Response("Not Found", { status: 404 });
  }
};
function sendSSE(controller, data, event = "message") {
  try {
    let payload = `event: ${event}
`;
    payload += `data: ${JSON.stringify(data)}

`;
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(payload));
  } catch (e) {
    console.warn(`SSE send error: ${e.message}`);
  }
}
__name(sendSSE, "sendSSE");
async function handleAction(data, env) {
  const { clientId, type, content, username } = data;
  const session = CLIENTS.get(clientId);
  if (type === "join" && session) {
    session.username = username || "Anonymous";
    const otherSessions = Array.from(CLIENTS.values()).filter((s) => s.username === session.username && s.clientId !== clientId);
    const hasOtherSessions = otherSessions.length > 0;
    const reg = await getUserRegistry(env, !!env.CHAT_KV);
    const userReg = reg[session.username];
    let isQuickReconnect = false;
    if (userReg && userReg.status === "online") {
      const lastSeen = new Date(userReg.lastSeen).getTime();
      if (Date.now() - lastSeen < 1e4) {
        isQuickReconnect = true;
      }
    }
    await updateUserRegistry(env, session.username, "online", !!env.CHAT_KV);
    broadcastUserList();
    if (!hasOtherSessions && !isQuickReconnect) {
      const joinMsg = {
        type: "system",
        id: `sys-join-${Date.now()}-${Math.random().toString(36).substr(2)}`,
        content: `${session.username} joined the channel.`,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      broadcast(joinMsg, "message");
    }
    return;
  }
  if (!session) return;
  if (type === "chat") {
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const chatMsg = {
      type: "chat",
      id: msgId,
      username: session.username,
      userId: session.username,
      content,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    broadcast(chatMsg);
    await appendToHistory(env, chatMsg, !!env.CHAT_KV);
  } else if (type === "cmd_list_users") {
    try {
      const hasKV = !!env.CHAT_KV;
      const registry = await getUserRegistry(env, hasKV) || {};
      sendSSE(session.controller, {
        type: "cmd_result_list_users",
        registry,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    } catch (err) {
      sendSSE(session.controller, {
        type: "error",
        content: `Failed to retrieve user list.`
      });
    }
  }
}
__name(handleAction, "handleAction");
async function handleDisconnect(clientId, env) {
  const session = CLIENTS.get(clientId);
  if (session) {
    CLIENTS.delete(clientId);
    const username = session.username;
    if (username !== "Anonymous") {
      const isStillOnline = Array.from(CLIENTS.values()).some((s) => s.username === username);
      if (isStillOnline) {
        broadcastUserList();
        return;
      }
      setTimeout(async () => {
        const currentClients = Array.from(CLIENTS.values());
        const nowOnline = currentClients.some((s) => s.username === username);
        if (!nowOnline) {
          await updateUserRegistry(env, username, "offline", !!env.CHAT_KV);
          const leaveMsg = {
            type: "system",
            id: `sys-leave-${Date.now()}-${Math.random().toString(36).substr(2)}`,
            content: `${username} left the channel.`,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          };
          broadcast(leaveMsg, "message");
          broadcastUserList();
        }
      }, 3e3);
    } else {
      broadcastUserList();
    }
  }
}
__name(handleDisconnect, "handleDisconnect");
async function sendHistory(controller, env) {
  const hasKV = !!env.CHAT_KV;
  try {
    let history = [];
    if (hasKV) {
      const historyStr = await env.CHAT_KV.get("history");
      history = historyStr ? JSON.parse(historyStr) : [];
    } else {
      history = MEMORY_HISTORY;
    }
    if (Array.isArray(history)) {
      for (const msg of history) {
        sendSSE(controller, msg);
      }
    }
  } catch (e) {
  }
}
__name(sendHistory, "sendHistory");
function broadcast(msg, event = "message") {
  for (const session of CLIENTS.values()) {
    try {
      sendSSE(session.controller, msg, event);
    } catch (e) {
      console.warn(`Failed to broadcast to client ${session.clientId}: ${e.message}`);
    }
  }
}
__name(broadcast, "broadcast");
function broadcastUserList() {
  const users = Array.from(CLIENTS.values()).map((s) => {
    return {
      username: s.username,
      status: "online",
      color: "white"
    };
  });
  const uniqueUsers = [];
  const seen = /* @__PURE__ */ new Set();
  for (const u of users) {
    if (!seen.has(u.username)) {
      uniqueUsers.push(u);
      seen.add(u.username);
    }
  }
  const msg = {
    type: "user_list",
    users: uniqueUsers
  };
  broadcast(msg, "user_list");
}
__name(broadcastUserList, "broadcastUserList");
async function updateUserRegistry(env, username, status, hasKV) {
  try {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let registry = {};
    if (hasKV) {
      const regStr = await env.CHAT_KV.get(REGISTRY_KEY);
      registry = regStr ? JSON.parse(regStr) : {};
    } else {
      registry = MEMORY_USER_REGISTRY;
    }
    if (!registry) registry = {};
    registry[username] = {
      status,
      lastSeen: now
    };
    if (!hasKV) {
      const keys = Object.keys(registry);
      if (keys.length > 100) {
        for (let i = 0; i < 20; i++) delete registry[keys[i]];
      }
    }
    if (hasKV) {
      await env.CHAT_KV.put(REGISTRY_KEY, JSON.stringify(registry));
    } else {
      MEMORY_USER_REGISTRY = registry;
    }
  } catch (e) {
  }
}
__name(updateUserRegistry, "updateUserRegistry");
async function getUserRegistry(env, hasKV) {
  try {
    if (hasKV) {
      const regStr = await env.CHAT_KV.get(REGISTRY_KEY);
      return regStr ? JSON.parse(regStr) : {};
    } else {
      return MEMORY_USER_REGISTRY;
    }
  } catch (e) {
    return {};
  }
}
__name(getUserRegistry, "getUserRegistry");
async function appendToHistory(env, newMessage, hasKV) {
  try {
    if (hasKV) {
      const historyStr = await env.CHAT_KV.get("history");
      let history = historyStr ? JSON.parse(historyStr) : [];
      if (!Array.isArray(history)) history = [];
      history.push(newMessage);
      if (history.length > 50) history = history.slice(-50);
      await env.CHAT_KV.put("history", JSON.stringify(history));
    } else {
      MEMORY_HISTORY.push(newMessage);
      if (MEMORY_HISTORY.length > 50) MEMORY_HISTORY.shift();
    }
  } catch (err) {
  }
}
__name(appendToHistory, "appendToHistory");

// ../home/jules/.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../home/jules/.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-KWUx9O/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../home/jules/.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-KWUx9O/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
