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
 * @property {'admin'|'user'|'banned'} [role]
 */

/**
 * @typedef {Object} UserPermission
 * @property {'admin'|'user'|'banned'} role
 * @property {number} [updatedAt]
 */

/**
 * @typedef {Record<string, UserInfo>} UserRegistry
 */

/**
 * @typedef {Record<string, UserPermission>} PermissionsRegistry
 */

// In-memory fallback
const MEMORY_HISTORY = [];
/** @type {UserRegistry} */
let MEMORY_USER_REGISTRY = {};
/** @type {PermissionsRegistry} */
let MEMORY_PERMISSIONS_REGISTRY = {};

const REGISTRY_KEY = 'user_registry';
const PERMISSIONS_KEY = 'user_permissions'; // New dedicated KV key for permissions

// Track active SSE sessions locally
// Map<clientId, ClientSession>
/** @type {Map<string, ClientSession>} */
const CLIENTS = new Map();

// BroadcastChannel for syncing messages across worker instances (if supported by runtime)
// This fixes the "Split Brain" issue where POST requests hit a different instance than the SSE connection.
let channel;
try {
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('termichat_global_sync');
    channel.onmessage = (event) => {
      // When we receive a message from another instance, send it to our local clients
      broadcastToLocalClients(event.data);
    };
  }
} catch (e) {
  console.warn("BroadcastChannel not supported in this environment.");
}

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

      const stream = new ReadableStream({
        start(controller) {
          // Heartbeat to keep connection alive
          // SSE comments start with colon. Sending frequently prevents timeouts.
          const intervalId = setInterval(() => {
             try {
                 const enc = new TextEncoder();
                 controller.enqueue(enc.encode(": keepalive\n\n"));
             } catch(e) {
                 clearInterval(intervalId);
             }
          }, 10000);

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
          "X-Accel-Buffering": "no", // Disable buffering for Nginx/Proxies
        },
      });
    }

    // Route: Actions (Upstream)
    if (url.pathname === "/action" && request.method === "POST") {
      try {
        const body = await request.json();
        await handleAction(body, env);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json"
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json"
          }
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
    console.error("Failed to send SSE:", e);
  }
}

/**
 * Handle incoming POST actions
 */
async function handleAction(data, env) {
  const { clientId, type, content, username, secret, targetUser } = data;
  
  let session = CLIENTS.get(clientId);
  const hasKV = !!env.CHAT_KV;
  
  // -- Fetch Registries --
  // We fetch permissions separate from user registry
  const permissions = await getPermissionsRegistry(env, hasKV);
  const registry = await getUserRegistry(env, hasKV);

  // Allow 'join' to set username even if session exists, or update it
  if (type === 'join') {
    // Check if banned in persistent storage
    const userPerm = permissions[username];
    if (userPerm && userPerm.role === 'banned') {
        if (session) {
            sendPrivateSystem(session, `ACCESS DENIED: You are banned from this server.`);
            // Optionally close connection, but simple message is clear enough for now
        }
        return;
    }

    // Determine Role: Persistent Role > Existing Registry Role > 'user'
    let role = userPerm ? userPerm.role : (registry[username]?.role || 'user');

    // If session is local, update it
    if (session) {
        session.username = username || 'Anonymous';
    }

    const userReg = registry[username];
    let isQuickReconnect = false;
    
    if (userReg) {
        if (userReg.status === 'online') {
            const lastSeen = new Date(userReg.lastSeen).getTime();
            if (Date.now() - lastSeen < 10000) {
                isQuickReconnect = true;
            }
        }
    }

    // Update registry with resolved role
    await updateUserRegistry(env, username, { status: 'online', role }, hasKV);
    
    // Broadcast updates
    broadcastUserList(env, hasKV);

    if (!isQuickReconnect) {
        const joinMsg = {
          type: 'system',
          id: `sys-join-${Date.now()}-${Math.random().toString(36).substr(2)}`,
          content: `${username} joined the channel.`,
          timestamp: new Date().toISOString()
        };
        broadcastGlobal(joinMsg);
    }
    return;
  }
  
  // Heartbeat/Ping
  if (type === 'ping') {
      if (username && username !== 'Anonymous') {
          await updateUserRegistry(env, username, { status: 'online' }, hasKV);
      }
      return;
  }

  // Active Leave
  if (type === 'leave') {
      if (username && username !== 'Anonymous') {
          await updateUserRegistry(env, username, { status: 'offline' }, hasKV);
          const leaveMsg = {
                type: 'system',
                id: `sys-leave-${Date.now()}-${Math.random().toString(36).substr(2)}`,
                content: `${username} left the channel.`,
                timestamp: new Date().toISOString()
          };
          broadcastGlobal(leaveMsg);
          broadcastUserList(env, hasKV);
      }
      if (session) CLIENTS.delete(clientId);
      return;
  }

  // Identify sender's role based on PERMISSIONS first, then Registry
  const senderName = username || (session ? session.username : 'Anonymous');
  const senderPerm = permissions[senderName];
  const senderRole = senderPerm ? senderPerm.role : (registry[senderName]?.role || 'user');

  // Block banned users from actions
  if (senderRole === 'banned') {
      sendPrivateSystem(session, `You are banned and cannot perform actions.`);
      return;
  }

  if (type === 'chat') {
    const msgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const chatMsg = {
      type: 'chat',
      id: msgId,
      username: senderName,
      userId: senderName,
      role: senderRole,
      content: content,
      timestamp: new Date().toISOString()
    };
    
    broadcastGlobal(chatMsg);
    await appendToHistory(env, chatMsg, hasKV);
  
  } else if (type === 'cmd_admin') {
      // Claim admin via secret
      const serverSecret = env.ADMIN_SECRET || 'secret123';
      if (secret === serverSecret) {
          await updatePermissionsRegistry(env, senderName, { role: 'admin' }, hasKV);
          await updateUserRegistry(env, senderName, { role: 'admin' }, hasKV); // Sync active
          
          sendPrivateSystem(session, `Admin privileges granted to ${senderName}.`);
          broadcastUserList(env, hasKV);
      } else {
          sendPrivateSystem(session, `Invalid admin secret.`);
      }

  } else if (type === 'cmd_op') {
      if (senderRole !== 'admin') {
          sendPrivateSystem(session, `Permission denied. You are not an admin.`);
          return;
      }
      if (targetUser) {
          await updatePermissionsRegistry(env, targetUser, { role: 'admin' }, hasKV);
          await updateUserRegistry(env, targetUser, { role: 'admin' }, hasKV);
          
          sendPrivateSystem(session, `User ${targetUser} promoted to Admin.`);
          broadcastGlobal({ type: 'system', content: `SERVER: ${targetUser} was promoted to Admin by ${senderName}.` });
          broadcastUserList(env, hasKV);
      }

  } else if (type === 'cmd_deop') {
      if (senderRole !== 'admin') {
          sendPrivateSystem(session, `Permission denied. You are not an admin.`);
          return;
      }
      if (targetUser) {
          // Revert to 'user' in permissions
          await updatePermissionsRegistry(env, targetUser, { role: 'user' }, hasKV);
          await updateUserRegistry(env, targetUser, { role: 'user' }, hasKV);
          
          sendPrivateSystem(session, `User ${targetUser} demoted to User.`);
          broadcastGlobal({ type: 'system', content: `SERVER: ${targetUser} was demoted by ${senderName}.` });
          broadcastUserList(env, hasKV);
      }
  
  } else if (type === 'cmd_ban') {
      if (senderRole !== 'admin') {
          sendPrivateSystem(session, `Permission denied. You are not an admin.`);
          return;
      }
      if (targetUser) {
          if (targetUser === senderName) {
              sendPrivateSystem(session, `You cannot ban yourself.`);
              return;
          }
          
          // Set 'banned' in permissions
          await updatePermissionsRegistry(env, targetUser, { role: 'banned' }, hasKV);
          // Set offline in registry and remove role from registry view
          await updateUserRegistry(env, targetUser, { status: 'offline', role: 'banned' }, hasKV);
          
          broadcastGlobal({ type: 'system', content: `SERVER: ${targetUser} has been BANNED by ${senderName}.` });
          broadcastUserList(env, hasKV);

          // Force disconnect if active
          kickUserByUsername(targetUser);
      }

  } else if (type === 'cmd_unban') {
      if (senderRole !== 'admin') {
          sendPrivateSystem(session, `Permission denied. You are not an admin.`);
          return;
      }
      if (targetUser) {
          // Reset to 'user'
          await updatePermissionsRegistry(env, targetUser, { role: 'user' }, hasKV);
          // Update registry info (though they are likely offline)
          await updateUserRegistry(env, targetUser, { role: 'user' }, hasKV);
          
          sendPrivateSystem(session, `User ${targetUser} unbanned.`);
          broadcastGlobal({ type: 'system', content: `SERVER: ${targetUser} was unbanned by ${senderName}.` });
      }

  } else if (type === 'cmd_list_users') {
     if (session) {
         try {
            sendSSE(session.controller, {
                type: 'cmd_result_list_users',
                registry: registry,
                timestamp: new Date().toISOString()
            });
        } catch (err) {
            sendSSE(session.controller, { type: 'error', content: `Failed to retrieve user list.` });
        }
     }
  }
}

async function handleDisconnect(clientId, env) {
  const session = CLIENTS.get(clientId);
  if (session) {
    CLIENTS.delete(clientId);
    const username = session.username;
    
    if (username !== 'Anonymous') {
        setTimeout(async () => {
             const hasKV = !!env.CHAT_KV;
             const registry = await getUserRegistry(env, hasKV);
             const userReg = registry[username];
             
             if (userReg && userReg.status === 'online') {
                 const lastSeen = new Date(userReg.lastSeen).getTime();
                 const timeDiff = Date.now() - lastSeen;
                 
                 if (timeDiff > 45000) {
                     await updateUserRegistry(env, username, { status: 'offline' }, hasKV);
                     const leaveMsg = {
                        type: 'system',
                        id: `sys-leave-${Date.now()}-${Math.random().toString(36).substr(2)}`,
                        content: `${username} left the channel (timeout).`,
                        timestamp: new Date().toISOString()
                    };
                    broadcastGlobal(leaveMsg);
                    broadcastUserList(env, hasKV);
                 }
             }
        }, 5000); 
    } else {
        broadcastUserList(env, !!env.CHAT_KV);
    }
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

function broadcastGlobal(msg) {
    if (channel) {
        channel.postMessage(msg);
    }
    broadcastToLocalClients(msg);
}

function broadcastToLocalClients(msg) {
  for (const session of CLIENTS.values()) {
    sendSSE(session.controller, msg);
  }
}

function sendPrivateSystem(session, text) {
    if (session) {
        sendSSE(session.controller, { type: 'system', content: text });
    }
}

/**
 * Finds all sessions for a username and closes them with a message
 */
function kickUserByUsername(username) {
    for (const [clientId, session] of CLIENTS.entries()) {
        if (session.username === username) {
            sendPrivateSystem(session, "You have been kicked/banned from the server.");
            // We can't strictly 'close' the SSE from here easily without aborting controller,
            // but we can remove them from CLIENTS which effectively kills their heartbeat logic
            // and interaction ability.
            CLIENTS.delete(clientId);
            try {
                session.controller.close();
            } catch(e) {}
        }
    }
}

async function broadcastUserList(env, hasKV) {
    const registry = await getUserRegistry(env, hasKV);
    const onlineUsers = [];
    
    for (const [username, rawInfo] of Object.entries(registry)) {
        /** @type {UserInfo} */
        const info = /** @type {any} */ (rawInfo);
        const lastSeen = new Date(info.lastSeen).getTime();
        const isActuallyOnline = (Date.now() - lastSeen) < 60000;

        if (info.status === 'online' && isActuallyOnline && info.role !== 'banned') {
            onlineUsers.push({
                username,
                status: 'online',
                role: info.role || 'user',
                color: 'white'
            });
        }
    }

    const msg = {
        type: 'user_list',
        users: onlineUsers
    };
    
    broadcastGlobal(msg);
}

// --- Registry Helpers (Online Status) ---

async function updateUserRegistry(env, username, updates, hasKV) {
    try {
        const now = new Date().toISOString();
        let registry = await getUserRegistry(env, hasKV);
        
        registry[username] = {
            ...(registry[username] || {}),
            ...updates,
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
    } catch(e) { console.error(e); }
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

// --- Permissions Helpers (Roles Persistence) ---

async function updatePermissionsRegistry(env, username, updates, hasKV) {
    try {
        const now = Date.now();
        let permissions = await getPermissionsRegistry(env, hasKV);
        
        permissions[username] = {
            ...(permissions[username] || {}),
            ...updates,
            updatedAt:now
        };

        if (hasKV) {
            await env.CHAT_KV.put(PERMISSIONS_KEY, JSON.stringify(permissions));
        } else {
            MEMORY_PERMISSIONS_REGISTRY = permissions;
        }
    } catch(e) { console.error("Perm Update Error", e); }
}

async function getPermissionsRegistry(env, hasKV) {
    try {
        if (hasKV) {
            const str = await env.CHAT_KV.get(PERMISSIONS_KEY);
            return str ? JSON.parse(str) : {};
        } else {
            return MEMORY_PERMISSIONS_REGISTRY;
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