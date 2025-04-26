// SPDX-License-Identifier: Apache-2.0

export function parseCommandLine(input: string): { command: string[]; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of input.trim()) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);

  // Instead of returning all tokens in "command",
  // slice out the first two for the command, and the rest for args.
  return {
    command: tokens.slice(0, 2),  // e.g. ["mcp", "set-default"]
    args: tokens.slice(2),        // e.g. ["abc", "xyz"] if user typed "mcp set-default abc xyz"
  };
}
