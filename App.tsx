import React, { useState, useEffect, useCallback } from 'react';
import MessageList from './components/MessageList';
import InputArea from './components/InputArea';
import { socketService } from './services/socketService';
import { Message, ConnectionStatus, User } from './types';
import { ANSI } from './utils/ansi';

const THEMES: Record<string, string> = {
  amber: '#ffb000',
  green: '#33ff33',
  cyan: '#00ffff',
  white: '#ffffff',
  red: '#ff3333',
  purple: '#d65dff',
};

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  
  // Initialize Username from LocalStorage or Random
  const [username, setUsername] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('termichat_username');
      if (saved) return saved;
    }
    return `User_${Math.floor(Math.random() * 9000) + 1000}`;
  });
  
  const [currentTheme, setCurrentTheme] = useState('white');
  
  // Handlers for socket events
  const handleStatusChange = useCallback((newStatus: ConnectionStatus) => {
    setStatus(newStatus);
    if (newStatus === ConnectionStatus.DISCONNECTED) {
       setUsers([]);
    }
  }, []);

  const handleIncomingMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      // Deduplicate by ID if necessary, though timestamp usually unique enough for this demo
      if (prev.some(m => m.id === msg.id)) return prev;
      
      const updated = [...prev, msg];
      if (updated.length > 100) return updated.slice(updated.length - 100);
      return updated;
    });
  }, []);

  const handleUserListUpdate = useCallback((newUsers: User[]) => {
      setUsers(newUsers);
  }, []);

  // Initialize connection
  useEffect(() => {
    socketService.init(handleStatusChange, handleIncomingMessage, handleUserListUpdate);
    
    // Set default theme
    document.documentElement.style.setProperty('--terminal-color', THEMES['white']);

    // Initial Welcome Message
    const welcomeMsg: Message = {
      id: 'welcome-msg',
      userId: 'system',
      username: 'SYSTEM',
      content: `
${ANSI.GREEN}Welcome to TermiChat v2.5.0${ANSI.RESET}
${ANSI.WHITE}---------------------------${ANSI.RESET}
Client initialized.
Logged in as: ${ANSI.YELLOW}${username}${ANSI.RESET}

Type ${ANSI.CYAN}/help${ANSI.RESET} to see available commands.
`,
      timestamp: new Date(),
      type: 'system'
    };
    
    // Use a timeout to ensure it renders after mount
    setTimeout(() => {
        setMessages([welcomeMsg]);
    }, 100);

    return () => {
      socketService.disconnect();
    };
  }, []); // Run once

  // Handle Theme Change
  useEffect(() => {
    const color = THEMES[currentTheme] || THEMES['white'];
    document.documentElement.style.setProperty('--terminal-color', color);
  }, [currentTheme]);

  // Local System Helper
  const addSystemMessage = (text: string, type: 'system' | 'error' | 'command_output' = 'system') => {
    const msg: Message = {
      id: Date.now().toString() + Math.random(),
      userId: 'system',
      username: 'SYSTEM',
      content: text,
      timestamp: new Date(),
      type: type === 'command_output' ? 'system' : type,
    };
    handleIncomingMessage(msg);
  };

  // Command Implementation
  const executeCommand = async (cmdStr: string): Promise<boolean> => {
    const args = cmdStr.split(' ');
    const mainCmd = args[0].toLowerCase();

    switch (mainCmd) {
      case '/help':
        addSystemMessage(`
${ANSI.WHITE}Available Commands:${ANSI.RESET}
  ${ANSI.CYAN}/connect <url> ${ANSI.RESET} - Connect to HTTP/SSE Server
  ${ANSI.CYAN}/nick <name>   ${ANSI.RESET} - Change your display name
  ${ANSI.CYAN}/color <name>  ${ANSI.RESET} - Switch theme (amber, green, cyan, red, white)
  ${ANSI.CYAN}/time          ${ANSI.RESET} - Display local time
  ${ANSI.CYAN}/list users    ${ANSI.RESET} - List all historical users & status
  ${ANSI.CYAN}/calc <math>   ${ANSI.RESET} - Evaluate a math expression
  ${ANSI.CYAN}/ciallo        ${ANSI.RESET} - Send Ciallo～(∠・ω< )⌒★
  ${ANSI.CYAN}/clear         ${ANSI.RESET} - Clear screen
  ${ANSI.CYAN}/status        ${ANSI.RESET} - Connection details
  ${ANSI.CYAN}/exit          ${ANSI.RESET} - Disconnect
`, 'command_output');
        return true;

      case '/nick':
        if (!args[1]) {
           addSystemMessage('Usage: /nick <new_name>', 'error');
           return true;
        }
        const oldName = username;
        const newName = args[1];
        setUsername(newName);
        localStorage.setItem('termichat_username', newName);
        
        addSystemMessage(`Nickname changed locally from '${oldName}' to '${newName}'. Reconnect to update on server.`);
        return true;

      case '/color':
        const themeName = args[1]?.toLowerCase();
        if (themeName && THEMES[themeName]) {
            setCurrentTheme(themeName);
            addSystemMessage(`Theme set to ${themeName.toUpperCase()}.`);
        } else {
            addSystemMessage(`Available themes: ${Object.keys(THEMES).join(', ')}`, 'error');
        }
        return true;

      case '/time':
        addSystemMessage(`Current Local Time: ${new Date().toString()}`);
        return true;

      case '/calc':
         try {
             const expression = args.slice(1).join('');
             // Safety: Basic validation
             if (!/^[0-9+\-*/().\s]+$/.test(expression)) {
                 addSystemMessage('Invalid characters in expression.', 'error');
                 return true;
             }
             // eslint-disable-next-line no-new-func
             const result = new Function(`return ${expression}`)();
             addSystemMessage(`${expression} = ${result}`, 'command_output');
         } catch(e) {
             addSystemMessage('Calculation error.', 'error');
         }
         return true;

      case '/ciallo':
         return handleSendMessage('Ciallo～(∠・ω< )⌒★');

      case '/status':
         addSystemMessage(`
${ANSI.WHITE}STATUS REPORT:${ANSI.RESET}
----------------
Connection: ${status}
Username:   ${username}
Theme:      ${currentTheme.toUpperCase()}
Uptime:     ${(performance.now() / 1000).toFixed(1)}s
Protocol:   HTTP/SSE
         `, 'command_output');
         return true;

      case '/connect':
        if (args.length < 2) {
            addSystemMessage('Usage: /connect <http_url>', 'error');
            return true;
        }
        const url = args[1];
        addSystemMessage(`Connecting to ${url}...`);
        socketService.connectRemote(url, username);
        return true;

      case '/clear':
        setMessages([]);
        return true;

      case '/list':
        if (args[1] === 'users') {
             if (status !== ConnectionStatus.CONNECTED) {
                 addSystemMessage('You must be connected to query the server.', 'error');
                 return true;
             }
             addSystemMessage('Fetching user list...');
             try {
                await socketService.sendCommand('cmd_list_users');
             } catch(e) {
                addSystemMessage(`Failed to send command: ${e}`, 'error');
             }
             return true;
        }
        addSystemMessage('Usage: /list users', 'error');
        return true;

      case '/users':
        addSystemMessage('Command deprecated. Please use: /list users', 'error');
        return true;

      case '/exit':
        socketService.disconnect();
        setMessages([]); 
        addSystemMessage('Disconnected.');
        return true;

      default:
        addSystemMessage(`Unknown command: ${mainCmd}. Type /help for list.`, 'error');
        return true; 
    }
  };

  const handleSendMessage = async (text: string): Promise<boolean> => {
    setCommandHistory(prev => [...prev, text]);

    if (text.startsWith('/')) {
      return executeCommand(text);
    }

    if (status !== ConnectionStatus.CONNECTED) {
      addSystemMessage('Network disconnected. Type /connect <url> to start.', 'error');
      return false;
    }

    try {
      await socketService.sendMessage(text, username);
      return true;
    } catch (e) {
      addSystemMessage(`Failed to send message.`, 'error');
      return false;
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-black text-theme">
      <div className="h-6 bg-[#111] border-b border-[#333] flex justify-between items-center px-4 text-xs select-none">
        <span>TERM-CHAT v2.5.0</span>
        <div className="flex items-center gap-2">
           <span>{username} @</span>
           <span className={`font-bold ${
             status === ConnectionStatus.CONNECTED ? 'text-green-500' : 
             status === ConnectionStatus.RECONNECTING ? 'text-yellow-500' : 'text-red-500'
           }`}>
             {status}
           </span>
        </div>
      </div>

      <div className="flex-grow flex flex-col min-h-0 relative">
        <MessageList messages={messages} />
      </div>

      <div className="h-1/4 min-h-[150px]">
        <InputArea 
          onSendMessage={handleSendMessage} 
          disabled={false}
          history={commandHistory}
          knownUsers={users}
          status={status}
        />
      </div>
    </div>
  );
};

export default App;