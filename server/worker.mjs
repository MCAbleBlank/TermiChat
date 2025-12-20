/**
 * TermiChat Server - HTTP/SSE Edition
 * 
 * Replaces WebSocket with Server-Sent Events (SSE) for downstream
 * and HTTP POST for upstream.
 */

/**
 * @typedef {Object} ClientSession
 * @property {ReadableStreamDefaultController} controller
 * @property {string} username
 * @property {string} clientId
 * @property {number} [intervalId]
 */

/**
 * @typedef {Object} UserInfo
 * @property {'online'|'offline'} status
 * @property {string} lastSeen
 */

/**
 * @typedef {Record<string, UserInfo>} UserRegistry
 */

// In-memory fallback
const MEMORY_HISTORY = [];
/** @type {UserRegistry} */
let MEMORY_USER_REGISTRY = {}; 

const REGISTRY_KEY = 'user_registry';

// Track active SSE sessions
// Map<clientId, ClientSession>
/** @type {Map<string, ClientSession>} */
const CLIENTS = new Map();

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);

    // Route: SSE Stream (Downstream)
    if (url.pathname === "/stream" && request.method === "GET") {
      const clientId = url.searchParams.get("clientId");
      if (!clientId) return new Response("Missing clientId", { status: 400 });

      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // Create a managed stream source
      const stream = new ReadableStream({
        start(controller) {
          // Heartbeat to keep connection alive (prevent Cloudflare/Browser timeout)
          // SSE comments start with colon
          const intervalId = setInterval(() => {
             try {
                 const enc = new TextEncoder();
                 controller.enqueue(enc.encode(": keepalive\n\n"));
             } catch(e) {
                 clearInterval(intervalId);
             }
          }, 15000);

          // Register client
          CLIENTS.set(clientId, {
            controller,
            username: "Anonymous",
            clientId,
            intervalId: intervalId
          });

          // Send initial connection success
          sendSSE(controller, {
            type: 'system',
            content: `Connected via SSE (HTTP). Session ID: ${clientId.substring(0, 8)}...`
          });

          // Send history
          sendHistory(controller, env).catch(err => console.error(err));
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
        },
      });
    }

    // Route: Actions (Upstream)
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

/**
 * Send a message via SSE format
 * data: JSON_STRING\n\n
 */
function sendSSE(controller, data) {
  try {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(payload));
  } catch (e) {
    // Controller might be closed
  }
}

/**
 * Handle incoming POST actions
 */
async function handleAction(data, env) {
  const { clientId, type, content, username } = data;
  const session = CLIENTS.get(clientId);

  // Allow 'join' to set username even if session exists, or update it
  if (type === 'join' && session) {
    session.username = username || 'Anonymous';
    
    await updateUserRegistry(env, session.username, 'online', !!env.CHAT_KV);
    broadcastUserList();

    const joinMsg = {
      type: 'system',
      content: `${session.username} joined the channel.`,
      timestamp: new Date().toISOString()
    };
    broadcast(joinMsg);
    
    // NOTE: We do NOT save 'join' messages to history anymore to avoid clutter.
    // await appendToHistory(env, joinMsg, !!env.CHAT_KV); 
    
    return;
  }

  // For other commands, require session
  if (!session) return; 

  if (type === 'chat') {
    // Note: We broadcast to ALL clients including the sender.
    // The client-side is expected NOT to optimistically add the message,
    // but to wait for this echoed message to display it.
    const chatMsg = {
      type: 'chat',
      username: session.username,
      userId: session.username, // Using username as ID for simplicity
      content: content,
      timestamp: new Date().toISOString()
    };
    broadcast(chatMsg);
    await appendToHistory(env, chatMsg, !!env.CHAT_KV);
  
  } else if (type === 'cmd_list_users') {
     try {
        const hasKV = !!env.CHAT_KV;
        /** @type {UserRegistry} */
        const registry = (await getUserRegistry(env, hasKV)) || {};
        
        // Send ONLY to the requester
        sendSSE(session.controller, {
            type: 'cmd_result_list_users',
            registry: registry,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        sendSSE(session.controller, {
            type: 'error',
            content: `Failed to retrieve user list.`
        });
    }
  }
}

async function handleDisconnect(clientId, env) {
  const session = CLIENTS.get(clientId);
  if (session) {
    CLIENTS.delete(clientId);
    
    const username = session.username;
    // Only mark offline if no other sessions exist for this username
    // (Handles case where user refreshes page quickly or has multiple tabs)
    if (username !== 'Anonymous') {
        const isStillOnline = Array.from(CLIENTS.values()).some(s => s.username === username);
        
        if (!isStillOnline) {
            await updateUserRegistry(env, username, 'offline', !!env.CHAT_KV);
            
            // Broadcast leave message so everyone knows they left
            const leaveMsg = {
                type: 'system',
                content: `${username} left the channel.`,
                timestamp: new Date().toISOString()
            };
            broadcast(leaveMsg);
        }
    }
    broadcastUserList();
  }
}

async function sendHistory(controller, env) {
  const hasKV = !!env.CHAT_KV;
  try {
    let history = [];
    if (hasKV) {
        const historyStr = await env.CHAT_KV.get('history');
        history = historyStr ? JSON.parse(historyStr) : [];
    } else {
        history = MEMORY_HISTORY;
    }
    if (Array.isArray(history)) {
        for (const msg of history) {
            sendSSE(controller, msg);
        }
    }
  } catch(e) {
    // ignore
  }
}

function broadcast(msg) {
  for (const session of CLIENTS.values()) {
    sendSSE(session.controller, msg);
  }
}

function broadcastUserList() {
    const users = Array.from(CLIENTS.values()).map(s => {
        return {
            username: s.username,
            status: 'online',
            color: 'white'
        };
    });
    
    // Deduplicate users in list (if multiple tabs same user)
    const uniqueUsers = [];
    const seen = new Set();
    for (const u of users) {
        if (!seen.has(u.username)) {
            uniqueUsers.push(u);
            seen.add(u.username);
        }
    }

    const msg = {
        type: 'user_list',
        users: uniqueUsers
    };
    
    broadcast(msg);
}

// --- Registry & History Helpers (Same as before) ---

async function updateUserRegistry(env, username, status, hasKV) {
    try {
        const now = new Date().toISOString();
        let registry = {};

        if (hasKV) {
            const regStr = await env.CHAT_KV.get(REGISTRY_KEY);
            registry = regStr ? JSON.parse(regStr) : {};
        } else {
            registry = MEMORY_USER_REGISTRY;
        }

        if (!registry) registry = {};

        registry[username] = {
            status: status,
            lastSeen: now
        };

        if (!hasKV) {
             const keys = Object.keys(registry);
             if (keys.length > 100) {
                 for(let i=0; i<20; i++) delete registry[keys[i]];
             }
        }

        if (hasKV) {
            await env.CHAT_KV.put(REGISTRY_KEY, JSON.stringify(registry));
        } else {
            MEMORY_USER_REGISTRY = registry;
        }
    } catch(e) { /* ignore */ }
}

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

async function appendToHistory(env, newMessage, hasKV) {
  try {
    if (hasKV) {
      const historyStr = await env.CHAT_KV.get('history');
      let history = historyStr ? JSON.parse(historyStr) : [];
      if (!Array.isArray(history)) history = [];
      history.push(newMessage);
      if (history.length > 50) history = history.slice(-50);
      await env.CHAT_KV.put('history', JSON.stringify(history));
    } else {
      MEMORY_HISTORY.push(newMessage);
      if (MEMORY_HISTORY.length > 50) MEMORY_HISTORY.shift();
    }
  } catch (err) { /* ignore */ }
}