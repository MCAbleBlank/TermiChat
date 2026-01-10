import { ConnectionStatus, Message, User } from '../types';
import { ANSI } from '../utils/ansi';

type MessageHandler = (msg: Message) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type UserListHandler = (users: User[]) => void;

class SocketService {
  private statusHandler: StatusHandler | null = null;
  private messageHandler: MessageHandler | null = null;
  private userListHandler: UserListHandler | null = null;
  
  private status: ConnectionStatus = ConnectionStatus.DISCONNECTED;
  
  // SSE Source
  private es: EventSource | null = null;
  private remoteBaseUrl: string | null = null;
  private username: string = 'GuestUser';
  private clientId: string = '';

  constructor() {
    // Initial ID
    this.clientId = 'client_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * Initialize handlers
   */
  init(onStatus: StatusHandler, onMessage: MessageHandler, onUserList?: UserListHandler) {
    this.statusHandler = onStatus;
    this.messageHandler = onMessage;
    if (onUserList) this.userListHandler = onUserList;
  }

  /**
   * Connect using Server-Sent Events (SSE)
   */
  connectRemote(url: string, username: string) {
    this.disconnect();
    
    // Rotate ID for new connection to ensure clean state on server
    this.clientId = 'client_' + Math.random().toString(36).substr(2, 9);
    
    // Normalize URL
    let httpUrl = url.trim();
    
    // Remove WebSocket protocols if user copy-pasted them
    if (httpUrl.startsWith('ws://')) httpUrl = httpUrl.replace('ws://', 'http://');
    else if (httpUrl.startsWith('wss://')) httpUrl = httpUrl.replace('wss://', 'https://');
    
    // Auto-add protocol if missing
    if (!httpUrl.startsWith('http://') && !httpUrl.startsWith('https://')) {
        // Assume localhost uses http, everything else https by default for security
        if (httpUrl.includes('localhost') || httpUrl.includes('127.0.0.1')) {
            httpUrl = 'http://' + httpUrl;
        } else {
            httpUrl = 'https://' + httpUrl;
        }
    }
    
    // Remove trailing slash for consistency
    httpUrl = httpUrl.replace(/\/$/, '');

    this.remoteBaseUrl = httpUrl;
    this.username = username;
    this.updateStatus(ConnectionStatus.RECONNECTING);

    try {
      // Connect to SSE stream endpoint
      const streamUrl = `${this.remoteBaseUrl}/stream?clientId=${this.clientId}`;
      const es = new EventSource(streamUrl);
      this.es = es;
      
      es.onopen = () => {
        if (this.es !== es) return;
        this.updateStatus(ConnectionStatus.CONNECTED);
        
        // Immediately send join action via POST
        this.postAction({
          type: 'join',
          username: this.username,
          color: ANSI.CYAN
        });
      };

      es.onmessage = (event) => {
        if (this.es !== es) return;
        try {
          const data = JSON.parse(event.data);
          this.handleRemoteMessage(data);
        } catch (e) {
          // Ignore parse errors
        }
      };

      es.onerror = (e) => {
        if (this.es !== es) return;
        
        // EventSource will automatically try to reconnect if the connection drops.
        // However, if the initial connection fails (e.g. invalid URL, 404), readyState becomes CLOSED.
        if (es.readyState === EventSource.CLOSED) {
            this.updateStatus(ConnectionStatus.DISCONNECTED);
            this.receiveSystemMessage(`Connection failed to ${this.remoteBaseUrl}. Please check the URL.`, 'error');
            
            // Close explicitly to stop browser from potentially retrying in background
            es.close();
            this.es = null;
        } else {
            // It's in CONNECTING state, meaning it's retrying (network blip)
            this.updateStatus(ConnectionStatus.RECONNECTING);
        }
      };

    } catch (e) {
      this.updateStatus(ConnectionStatus.DISCONNECTED);
      this.receiveSystemMessage(`Could not create connection to ${httpUrl}`, 'error');
    }
  }

  disconnect() {
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.updateStatus(ConnectionStatus.DISCONNECTED);
  }

  async sendMessage(content: string, username: string): Promise<void> {
    if (this.status !== ConnectionStatus.CONNECTED) {
      throw new Error('Not connected');
    }
    // We strictly wait for the server to echo the message back via SSE.
    // We do NOT call handleRemoteMessage locally.
    return this.postAction({
        type: 'chat',
        content: content
    });
  }

  async sendCommand(commandType: string, payload: any = {}): Promise<void> {
    if (this.status !== ConnectionStatus.CONNECTED) {
        throw new Error('Not connected');
    }
    return this.postAction({
        type: commandType,
        ...payload
    });
  }

  // --- Internal Helper for Upstream POSTs ---

  private async postAction(body: any): Promise<void> {
      if (!this.remoteBaseUrl) return;

      try {
          const res = await fetch(`${this.remoteBaseUrl}/action`, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                  ...body,
                  clientId: this.clientId
              })
          });
          
          if (!res.ok) {
              throw new Error(`Server error: ${res.status}`);
          }
      } catch (e) {
          console.error("Action failed:", e);
          throw e;
      }
  }

  // --- Internals for Remote Mode ---

  private handleRemoteMessage(data: any) {
    if (data.type === 'user_list' && Array.isArray(data.users)) {
        if (this.userListHandler) this.userListHandler(data.users);
        return;
    }

    // Handle RAW registry data response
    if (data.type === 'cmd_result_list_users' && data.registry) {
        const formattedText = this.formatRegistryToAnsi(data.registry);
        this.receiveSystemMessage(formattedText, 'system');
        return;
    }

    // Standard Chat or System messages
    if (this.messageHandler) {
        // Map server message to UI Message type
        const msg: Message = {
            id: data.id || (Date.now().toString() + Math.random()), // Use Server ID if available
            userId: data.userId || 'system',
            username: data.username || 'SYSTEM',
            content: data.content,
            timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
            type: data.type === 'system' ? 'system' : 'chat'
        };
        
        // If it's my own message coming back from server, mark it as current user style
        if (msg.username === this.username && data.type !== 'system') {
            msg.userId = 'currentUser';
        }

        this.messageHandler(msg);
    }
  }

  /**
   * Client-side processing of user registry data
   */
  private formatRegistryToAnsi(registry: Record<string, { status: string, lastSeen: string }>): string {
    const entries = Object.entries(registry);
    if (entries.length === 0) return 'User registry is empty.';

    entries.sort((a, b) => {
        if (a[1].status === 'online' && b[1].status !== 'online') return -1;
        if (a[1].status !== 'online' && b[1].status === 'online') return 1;
        return new Date(b[1].lastSeen).getTime() - new Date(a[1].lastSeen).getTime();
    });

    const limitedEntries = entries.slice(0, 50);

    const lines = limitedEntries.map(([user, info]) => {
        const statusColor = info.status === 'online' ? ANSI.GREEN : ANSI.RED;
        const statusIcon = info.status === 'online' ? '●' : '○';
        const dateStr = info.lastSeen ? new Date(info.lastSeen).toLocaleString() : 'Never';
        
        return `  ${statusColor}${statusIcon} ${ANSI.RESET}${user.padEnd(15)} [${info.status.toUpperCase()}] Last Seen: ${dateStr}`;
    });

    if (entries.length > 50) {
        lines.push(`  ... (${entries.length - 50} more hidden) ...`);
    }

    return `\n${ANSI.WHITE}USER REGISTRY (Historical) [${entries.length}]:${ANSI.RESET}\n-----------------------------------\n${lines.join('\n')}\n`;
  }

  private updateStatus(status: ConnectionStatus) {
    if (this.status !== status) {
        this.status = status;
        if (this.statusHandler) this.statusHandler(status);
    }
  }

  private receiveSystemMessage(content: string, type: 'system' | 'error' = 'system') {
    if (this.messageHandler) {
      this.messageHandler({
        id: Date.now().toString() + Math.random(),
        userId: 'system',
        username: 'SYSTEM',
        content,
        timestamp: new Date(),
        type: type,
      });
    }
  }
}

export const socketService = new SocketService();