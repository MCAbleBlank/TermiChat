import React from 'react';

// Simplified ANSI parser for demo purposes
// Supports basic foreground colors
export const parseAnsi = (text: string): React.ReactNode[] => {
  const parts = text.split(/(\u001b\[\d+m)/g);
  const nodes: React.ReactNode[] = [];
  let currentColor = 'text-theme'; // Uses CSS variable var(--terminal-color)

  parts.forEach((part, index) => {
    if (part.startsWith('\u001b[')) {
      // It's a color code
      switch (part) {
        case '\u001b[30m': currentColor = 'text-gray-900'; break;
        case '\u001b[31m': currentColor = 'text-red-500'; break;
        case '\u001b[32m': currentColor = 'text-green-500'; break;
        case '\u001b[33m': currentColor = 'text-yellow-500'; break;
        case '\u001b[34m': currentColor = 'text-blue-500'; break;
        case '\u001b[35m': currentColor = 'text-purple-500'; break;
        case '\u001b[36m': currentColor = 'text-cyan-500'; break;
        case '\u001b[37m': currentColor = 'text-white'; break;
        case '\u001b[0m': currentColor = 'text-theme'; break; // Reset to Theme Color
        default: break; // Ignore unsupported codes
      }
    } else if (part) {
      nodes.push(
        <span key={index} className={currentColor}>
          {part}
        </span>
      );
    }
  });

  return nodes;
};

export const ANSI = {
  RESET: '\u001b[0m',
  RED: '\u001b[31m',
  GREEN: '\u001b[32m',
  YELLOW: '\u001b[33m',
  BLUE: '\u001b[34m',
  PURPLE: '\u001b[35m',
  CYAN: '\u001b[36m',
  WHITE: '\u001b[37m',
};