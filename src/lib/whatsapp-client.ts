// SPDX-License-Identifier: Apache-2.0

import { Client, LocalAuth, Message } from 'whatsapp-web.js';
import puppeteer from 'puppeteer';
import { MCPClientManager } from './mcp-client';
import Anthropic from '@anthropic-ai/sdk';
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseCommandLine } from '../utils/command-parser';
import { Messages } from '@anthropic-ai/sdk/resources/index.mjs';
import fs from 'node:fs';

import { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IOType } from 'node:child_process';
import Stream from 'node:stream';
import path from 'node:path';
// Add this interface at the top of your file
interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  stderr?: IOType | Stream | number;
  cwd?: string;
}



interface MCPConfigFile {
  mcpServers: Record<string, MCPServerConfig>;
}

// Use dynamic path resolution
const configPath = path.join(__dirname, 'mcp-server.conf');
const config: MCPConfigFile = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
export class MCPWhatsAppClient {
  private whatsapp: Client;
  private mcpManager = new MCPClientManager();
  private anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  private defaultServerId?: string;
  // toolName -> connection id mapping for quick routing
  private toolDirectory = new Map<string, string>();
  // Cached array to send to Anthropic on every request
  private cachedAvailableTools: {
    name: string;
    description?: string;
    input_schema: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  }[] = [];

  constructor() {
    // Dynamically import Puppeteer so we can use the executable that ships with
    // the library instead of relying on a system-installed Chrome.  This avoids
    // the common "Only Chrome at revision rXXXXXX is guaranteed to work" launch
    // error that occurs when Puppeteer tries to drive an unsupported local
    // browser build.
    //
    // We also remove the 30 second default connection timeout by setting
    // `timeout: 0` (meaning "wait indefinitely") and keep the rest of the
    // launch flags that make running inside containers / CI friendlier.
    //
    // NOTE: we pass the *library* instance through the `puppeteer` top-level
    // option so that whatsapp-web.js will use the same copy we are configuring.
    this.whatsapp = new Client({
      authStrategy: new LocalAuth(),
      puppeteer: {
        headless: true,
        defaultViewport: null,
        executablePath: puppeteer.executablePath(),
        // Disable Puppeteer's 30 s connection limit – some machines (e.g. on
        // first run when Chromium still needs to be un-zipped) can take longer.
        timeout: 0,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ]
      }
    });
    this.setupEvents();
  }

  private setupEvents(): void {
    //this.whatsapp.initialize();

    this.whatsapp.on('loading_screen', (percent, message) => {
      console.log('LOADING SCREEN', percent, message);
    });

// Pairing code only needs to be requested once
    let pairingCodeRequested = false;
      this.whatsapp.on('qr', async (qr) => {
    // NOTE: This event will not be fired if a session is specified.
    console.log('QR RECEIVED', qr);

    // paiuting code example
    const pairingCodeEnabled = true;
    if (pairingCodeEnabled && !pairingCodeRequested) {
        const pairingCode = await this.whatsapp.requestPairingCode('  ?? '); // enter the target phone number
        console.log('Pairing code enabled, code: '+ pairingCode);
        pairingCodeRequested = true;
    }
    });
    
    this.whatsapp.on('ready', async () => {
      console.log('WhatsApp ready');
      
      try {
        // Reload configuration each time WhatsApp becomes ready so that any
        // changes made to the config file while the process is running are
        // picked up.  Use the absolute path next to the compiled JS file to
        // avoid ENOENT errors when the working directory is different.

        const refreshedConfig: MCPConfigFile = JSON.parse(
          fs.readFileSync(configPath, 'utf-8')
        );
        
        const serverEntries = Object.entries(refreshedConfig.mcpServers || {});
        
        if (serverEntries.length === 0) {
          console.log('No MCP servers found in configuration file');
          return;
        }
    
        const serverNames = serverEntries.map(([id]) => id);
        console.log(`Starting MCP servers: ${serverNames.join(', ')}`);
    
        await Promise.all(serverEntries.map(async ([serverId, serverConfig]) => {
          try {
            console.log(`Initializing ${serverId} server...`);
            
            // Explicitly type the serverConfig
            const params: StdioServerParameters = {
              command: serverConfig.command,
              args: serverConfig.args || [],
              env: {
                ...process.env as Record<string, string>,
                ...(serverConfig.env)
              },
              stderr: serverConfig.stderr,
              cwd: serverConfig.cwd
            };
    
            await this.mcpManager.connect(serverId, params);
            console.log(`Successfully connected ${serverId} server`);
            this.defaultServerId = serverId;

          } catch (error) {
            console.error(`Failed to start ${serverId} server:`, error);
          }
        }));
    
        console.log('All MCP servers initialization completed');

        // Build tool directory after all initial connections are up
        await this.refreshToolDirectory();
      } catch (error) {
        console.error('Error initializing MCP servers:', error);
      }
    });

    this.whatsapp.on('message', async msg => {
    console.info('MESSAGE RECEIVED', msg);
       	    if (msg.body.toLowerCase().startsWith('mcp')) {
        await this.handleCommand(msg);
      } else {
        await this.handleQuery(msg);
      }
    });
  }

  private async handleCommand(msg: Message): Promise<void> {
    const { command, args } = parseCommandLine(msg.body);
    
    try {
      switch (command[1]?.toLowerCase()) {
        case 'connect':

          await this.handleConnect(msg, args);
          break;
        case 'disconnect':
          await this.handleDisconnect(msg, args);
          break;
        case 'list':
          await msg.reply(`Servers: ${this.mcpManager.listConnections().join(', ')}`);
          break;
        case 'set-default': // canonical form
        case 'setdefault':  // allow "mcp setdefault <id>"
        case 'set':         // allow "mcp set <id>" or "mcp set default <id>"
          {
            // If user typed "mcp set default <id>", drop the literal word
            // "default" so that <id> becomes args[0].
            if (args.length > 0 && args[0].toLowerCase() === 'default') {
              args.shift();
            }
            await this.handleSetDefault(msg, args);
            break;
          }
        default:
          await msg.reply('Invalid command');
      }
    } catch (error) {
      await msg.reply(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleConnect(msg: Message, args: string[]): Promise<void> {
    const [id, ...scriptPathParts] = args;
    const scriptPath = scriptPathParts.join(' ');
    
    await this.mcpManager.connect("new-server", {command: "cmd", args: [scriptPath]});
    this.defaultServerId ||= id;

    // Refresh directory after new connection
    await this.refreshToolDirectory();

    await msg.reply(`Connected ${id}`);
  }

  private async handleDisconnect(msg: Message, args: string[]): Promise<void> {
    const [id] = args;
    if (!id) {
      await msg.reply('Usage: mcp disconnect <server-id>');
      return;
    }
    
    await this.mcpManager.disconnect(id);

    // Refresh directory after disconnection
    await this.refreshToolDirectory();
    await msg.reply(`Disconnected server: ${id}`);
  }

  private async handleSetDefault(msg: Message, args: string[]): Promise<void> {
    const [id] = args;
    if (!id) {
      await msg.reply('Usage: mcp set-default <server-id>');
      return;
    }
    
    // Make the lookup case-insensitive so users don't have to remember the
    // exact letter-case used when the server was registered.
    const matchId = this.mcpManager
      .listConnections()
      .find(existing => existing.toLowerCase() === id.toLowerCase());

    if (matchId) {
      this.defaultServerId = matchId;
      await msg.reply(`Default server set to: ${matchId}`);
    } else {
      await msg.reply(`Server ${id} not found`);
    }
  }

  private async handleQuery(msg: Message): Promise<void> {
    if (!this.defaultServerId) {
      await msg.reply('No MCP server connected');
      return;
    }

    try {
      const response = await this.processQuery(msg.body);
      await msg.reply(response);
    } catch (error) {
      await msg.reply('Processing failed');
    }
  }

  private conversationHistory: Anthropic.MessageParam[] = [];

  /**
   * Query every active MCP connection for the tools it exposes and rebuild
   * the lookup tables used by processQuery().  This should be called whenever
   * the set of connections changes or a connection signals that its tool list
   * has changed.
   */
  private async refreshToolDirectory(): Promise<void> {
    const connectionIds = this.mcpManager.listConnections();

    const newDirectory = new Map<string, string>();
    const newAvailableTools: {
      name: string;
      description?: string;
      input_schema: {
        type: 'object';
        properties: Record<string, unknown>;
        required: string[];
      };
    }[] = [];

    await Promise.all(
      connectionIds.map(async (id) => {
        const conn = this.mcpManager.getConnection(id);
        if (!conn) return;

        try {
          const res = await conn.client.listTools();
          res.tools.forEach((tool: any) => {
            // Prefer first occurrence when duplicate names arise
            if (!newDirectory.has(tool.name)) {
              newDirectory.set(tool.name, id);
              newAvailableTools.push({
                name: tool.name,
                description: tool.description || undefined,
                input_schema: {
                  type: 'object',
                  properties: tool.inputSchema?.properties || {},
                  required: tool.inputSchema?.required || [],
                },
              });
            }
          });
        } catch (err) {
          console.warn(`Failed to list tools for connection ${id}:`, err);
        }
      })
    );

    this.toolDirectory = newDirectory;
    this.cachedAvailableTools = newAvailableTools;
  }

private async processQuery(query: string): Promise<string> {
    // Ensure at least one MCP connection exists
    if (this.mcpManager.listConnections().length === 0) {
      throw new Error('No active MCP connections');
    }

    // Refresh tool directory on-demand if it is empty
    if (this.toolDirectory.size === 0) {
      await this.refreshToolDirectory();
    }

    const availableTools = [...this.cachedAvailableTools];

    let messages: Anthropic.MessageParam[] = [
      ...this.conversationHistory,
      {
        role: 'user' as const,
        content: `${query}\n\nFor WhatsApp chat, be concise and direct`,
      },
    ];

    const finalText: string[] = [];
    let currentResponse = await this.anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2000,
      messages,
      tools: availableTools,
    });

    let toolCallCount = 0;
    const MAX_TOOL_CALLS = 4;

    while (toolCallCount < MAX_TOOL_CALLS) {
      let hasToolUse = false;

      for (const content of currentResponse.content) {
        if (content.type === 'text') {
          finalText.push(content.text);
        } else if (content.type === 'tool_use') {
          hasToolUse = true;
          toolCallCount++;

          const toolName = content.name;
          const toolArgs = content.input;

          const providerId = this.toolDirectory.get(toolName);
          const providerConn = providerId ? this.mcpManager.getConnection(providerId) : undefined;

          if (!providerConn) {
            finalText.push(`[No MCP server provides tool ${toolName}]`);
            continue;
          }

          try {
            const result = await providerConn.client.request(
              {
                method: 'tools/call',
                params: {
                  name: toolName,
                  arguments: toolArgs,
                },
              },
              CallToolResultSchema
            );

            //finalText.push(`[Called tool ${toolName}]`);

            if (result?.content) {
              const textContent = result.content
                .filter((c) => c.type === 'text')
                .map((c) => c.text)
                .join('\n\n');

              if (/https?:\/\/[^\s]+/.test(textContent)) {
                finalText.push(`Tool result: ${textContent}`);
              }
            }

            messages.push({ role: 'assistant' as const, content: currentResponse.content });
            messages.push({
              role: 'user' as const,
              content: [
                {
                  type: 'tool_result' as const,
                  tool_use_id: content.id,
                  content: JSON.stringify(result.content ?? {}),
                },
              ],
            });

            currentResponse = await this.anthropic.messages.create({
              model: 'claude-3-5-sonnet-20241022',
              max_tokens: 2000,
              messages,
              tools: availableTools,
            });
          } catch (error) {
            finalText.push(`[Error calling tool ${toolName}: ${error instanceof Error ? error.message : 'Unknown'}]`);
          }
        }
      }

      if (!hasToolUse) break;
    }

    if (toolCallCount >= MAX_TOOL_CALLS) {
      finalText.push(`[Maximum tool call limit (${MAX_TOOL_CALLS}) reached]`);
    }

    this.conversationHistory = messages;
    return finalText.join('\n');
}
  async start(): Promise<void> {
    await this.whatsapp.initialize();
  }

  async cleanup(): Promise<void> {
    try {
      await this.whatsapp.destroy();
    } catch (error) {
      // If the browser never launched (e.g. puppeteer TimeoutError) there will
      // be no underlying page / browser instance and destroy() will throw a
      // TypeError when it tries to close a null reference. Swallow those
      // specific errors so that shutdown can proceed gracefully.
      if (error instanceof Error && error.message.includes('close')) {
        console.warn('whatsapp-web.js destroy() failed during cleanup:', error.message);
      } else {
        console.warn('Unexpected error during whatsapp-web.js cleanup:', error);
      }
    }

    // Disconnect any MCP servers that may have been started.
    this.mcpManager.listConnections().forEach(id => this.mcpManager.disconnect(id));
  }
}
