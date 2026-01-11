import React, { useEffect, useRef } from 'react';
import { Message } from '../types';
import { parseAnsi } from '../utils/ansi';

interface MessageListProps {
  messages: Message[];
}

const formatTime = (date: Date) => {
  return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const RoleBadge = ({ role }: { role?: string }) => {
    if (role === 'admin') {
        return <span className="text-red-500 font-bold mr-1">[A]</span>;
    }
    if (role === 'banned') {
        return <span className="text-gray-500 font-bold mr-1 line-through">[BAN]</span>;
    }
    return null;
};

const MessageList: React.FC<MessageListProps> = ({ messages }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  return (
    <div className="flex-grow overflow-y-auto p-2 md:p-4 font-mono text-sm md:text-base space-y-1 crt-effect">
      {messages.map((msg) => (
        <div key={msg.id} className="break-words leading-snug whitespace-pre-wrap">
          {/* Timestamp - Smaller on mobile */}
          <span className="text-gray-600 mr-2 text-xs md:text-sm">[{formatTime(msg.timestamp)}]</span>

          {/* User Prefix */}
          {msg.type !== 'system' && msg.type !== 'error' && (
            <>
                <RoleBadge role={msg.role} />
                <span className={`mr-2 font-bold ${msg.userId === 'currentUser' ? 'text-theme opacity-80' : 'text-theme'}`}>
                  &lt;{msg.username}&gt;
                </span>
            </>
          )}

          {/* System/Error Prefixes */}
          {msg.type === 'system' && <span className="text-theme opacity-60 font-bold mr-2">!</span>}
          {msg.type === 'error' && <span className="text-red-600 font-bold mr-2">ERR:</span>}

          {/* Content with ANSI parsing */}
          <span className={msg.type === 'error' ? 'text-red-500' : 'text-theme'}>
             {parseAnsi(msg.content)}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
};

export default MessageList;
