import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { User, AVAILABLE_COMMANDS, ConnectionStatus } from '../types';

interface InputAreaProps {
  onSendMessage: (message: string) => Promise<boolean>; // Returns success/fail
  disabled: boolean;
  history: string[]; // Command history
  knownUsers: User[];
  status: ConnectionStatus;
}

const MAX_RETRIES = 3;

const InputArea: React.FC<InputAreaProps> = ({ onSendMessage, disabled, history, knownUsers, status }) => {
  const [inputValue, setInputValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tempInput, setTempInput] = useState(''); // Stores input before navigating history
  const [isSending, setIsSending] = useState(false);
  const [commandSuggestions, setCommandSuggestions] = useState<{cmd: string, desc: string}[]>([]);
  
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount and keep focus
  useEffect(() => {
    const keepFocus = () => {
        // Only focus if we aren't selecting text elsewhere
        if (document.getSelection()?.type !== 'Range') {
            inputRef.current?.focus();
        }
    };
    document.addEventListener('click', keepFocus);
    inputRef.current?.focus();
    return () => document.removeEventListener('click', keepFocus);
  }, []);

  // Update suggestions based on input
  useEffect(() => {
    if (inputValue.startsWith('/')) {
        const search = inputValue.toLowerCase();
        // Simple prefix match
        const matches = AVAILABLE_COMMANDS.filter(c => c.cmd.startsWith(search));
        setCommandSuggestions(matches);
    } else {
        setCommandSuggestions([]);
    }
  }, [inputValue]);

  const handleKeyDown = async (e: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    // History Navigation (Up)
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex < history.length - 1) {
        const newIndex = historyIndex + 1;
        if (historyIndex === -1) setTempInput(inputValue);
        setHistoryIndex(newIndex);
        setInputValue(history[history.length - 1 - newIndex]);
      }
    }
    // History Navigation (Down)
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > -1) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        if (newIndex === -1) {
          setInputValue(tempInput);
        } else {
          setInputValue(history[history.length - 1 - newIndex]);
        }
      }
    }
    // Tab Autocomplete
    else if (e.key === 'Tab') {
      e.preventDefault();
      
      // 1. Command Autocomplete
      if (inputValue.startsWith('/') && commandSuggestions.length > 0) {
          // Auto-fill the first suggestion
          setInputValue(commandSuggestions[0].cmd + ' ');
          return;
      }

      // 2. User Autocomplete
      const words = inputValue.split(' ');
      const currentWord = words[words.length - 1];
      
      if (currentWord && !currentWord.startsWith('/')) {
        const match = knownUsers.find(u => u.username.toLowerCase().startsWith(currentWord.toLowerCase()));
        if (match) {
          words[words.length - 1] = match.username;
          setInputValue(words.join(' ') + ' ');
        }
      }
    }
    // Submit
    else if (e.key === 'Enter' && !isSending) {
      const content = inputValue.trim();
      if (!content) return;

      setIsSending(true);
      setInputValue(''); // Optimistic clear
      setHistoryIndex(-1);
      setCommandSuggestions([]); // Clear suggestions
      
      try {
          const isCommand = content.startsWith('/');
          // Only retry if connected and not a command
          const shouldRetry = status === ConnectionStatus.CONNECTED && !isCommand;

          if (!shouldRetry) {
             // Single attempt
             const success = await onSendMessage(content);
             if (!success) {
                 setInputValue(content);
             }
          } else {
              // Retry Logic
              let attempts = 0;
              let success = false;
              
              while (attempts < MAX_RETRIES && !success) {
                try {
                    success = await onSendMessage(content);
                } catch (err) {
                    console.warn('Message send attempt failed:', err);
                    success = false;
                }

                if (!success) {
                    attempts++;
                    if (attempts < MAX_RETRIES) {
                        // Short delay before retry
                        await new Promise(r => setTimeout(r, 500));
                    }
                }
              }
              
              if (!success) {
                  // Restore input if failed after all retries
                  setInputValue(content); 
              }
          }
      } catch (criticalError) {
          console.error("Critical Input Error:", criticalError);
          setInputValue(content);
      } finally {
          setIsSending(false);
          // Ensure focus returns to input after sending
          setTimeout(() => {
              inputRef.current?.focus();
          }, 10);
      }
    }
  };

  return (
    <div className="flex flex-col h-full bg-black border-t-2 border-[#333] p-2 font-mono text-lg relative">
      {/* Command Suggestions Popup */}
      {commandSuggestions.length > 0 && commandSuggestions.length < 10 && (
          <div className="absolute bottom-full left-0 mb-2 ml-2 w-auto max-w-md bg-black border border-theme z-50 p-2 shadow-lg">
              <div className="text-xs text-gray-500 mb-1 border-b border-gray-800 pb-1">SUGGESTIONS [TAB]</div>
              {commandSuggestions.map((s, idx) => (
                  <div key={idx} className="text-sm">
                      <span className="text-theme font-bold">{s.cmd}</span>
                      <span className="text-gray-500 ml-2 text-xs">// {s.desc}</span>
                  </div>
              ))}
          </div>
      )}

      <div className="flex flex-row items-center w-full h-full">
        <span className="text-theme mr-2 select-none font-bold animate-pulse">{">"}</span>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || isSending}
          className="flex-grow bg-transparent border-none outline-none text-theme placeholder-gray-700 caret-theme"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      
      {/* Visual Helpers / Hints */}
      <div className="absolute bottom-1 right-2 text-xs text-gray-600 select-none">
        [TAB] Complete | [↑] History | [/] Cmds
      </div>
    </div>
  );
};

export default InputArea;