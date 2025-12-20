export interface User {
  username: string;
  color: string; // ANSI color code or hex equivalent class
  status: 'online' | 'offline';
}

export interface Message {
  id: string;
  userId: string;
  username: string;
  content: string;
  timestamp: Date;
  type: 'system' | 'chat' | 'error' | 'command_output';
}

export enum ConnectionStatus {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  RECONNECTING = 'RECONNECTING',
}

export interface Command {
  command: string;
  description: string;
  action: () => void;
}

export const AVAILABLE_COMMANDS = [
  { cmd: '/help', desc: 'Show available commands' },
  { cmd: '/connect', desc: 'Connect to server <url>' },
  { cmd: '/nick', desc: 'Change nickname <name>' },
  { cmd: '/color', desc: 'Change theme <name>' },
  { cmd: '/time', desc: 'Show local time' },
  { cmd: '/list users', desc: 'List historical users' },
  { cmd: '/calc', desc: 'Calculate math <expr>' },
  { cmd: '/ciallo', desc: 'Send Ciallo～(∠・ω< )⌒★' },
  { cmd: '/clear', desc: 'Clear screen' },
  { cmd: '/status', desc: 'Show status' },
  { cmd: '/exit', desc: 'Disconnect' },
];