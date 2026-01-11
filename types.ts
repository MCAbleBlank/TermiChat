export interface User {
  username: string;
  color: string; // ANSI color code or hex equivalent class
  status: 'online' | 'offline';
  role?: 'admin' | 'user' | 'banned';
}

export interface Message {
  id: string;
  userId: string;
  username: string;
  role?: 'admin' | 'user' | 'banned';
  content: string;
  timestamp: Date;
  type: 'system' | 'chat' | 'error' | 'command_output';
}

export enum ConnectionStatus {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  RECONNECTING = 'RECONNECTING',
}

export interface CommandDef {
  cmd: string;
  desc: string;
  adminOnly?: boolean;
}

export const AVAILABLE_COMMANDS: CommandDef[] = [
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/connect', desc: 'Connect to server <url>' },
  { cmd: '/nick', desc: 'Change nickname <name>' },
  { cmd: '/color', desc: 'Change theme <name>' },
  { cmd: '/list users', desc: 'List historical users' },
  { cmd: '/ciallo', desc: 'Send Ciallo～(∠・ω< )⌒★' },
  { cmd: '/clear', desc: 'Clear screen' },
  { cmd: '/exit', desc: 'Disconnect' },
  { cmd: '/admin', desc: '<secret> Claim admin rights' },
  { cmd: '/op', desc: '<user> Grant admin rights', adminOnly: true },
  { cmd: '/deop', desc: '<user> Revoke admin rights', adminOnly: true },
  { cmd: '/ban', desc: '<user> Ban user from server', adminOnly: true },
  { cmd: '/unban', desc: '<user> Unban user', adminOnly: true },
];
