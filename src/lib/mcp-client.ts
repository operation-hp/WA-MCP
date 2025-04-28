// SPDX-License-Identifier: Apache-2.0

import { ChildProcess } from 'child_process';

import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

import { ChildProcessManager } from '../utils/process-manager';
import { parseCommandLine } from '../utils/command-parser';


enum ConnectionState {
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTING = 'DISCONNECTING',
  DISCONNECTED = 'DISCONNECTED'
}

interface MCPConnection {
  id: string;
  client: MCPClient;
  transport: StdioClientTransport;
  state: ConnectionState;
  process?: ChildProcess;
  heartbeatTimer?: NodeJS.Timeout;
}

// Add type extensions for StdioClientTransport
declare module "@modelcontextprotocol/sdk/client/stdio.js" {
    interface StdioClientTransport {
      process?: import('child_process').ChildProcess;
      on?(event: string, listener: (...args: any[]) => void): void;
    }
  }

  
export class MCPClientManager {
  private connections = new Map<string, MCPConnection>();
  private processManager = new ChildProcessManager();
  private connectionTimeout = 10000;
  async connect(
    id: string,
    serverParams: StdioServerParameters
  ): Promise<void> {
    if (this.connections.has(id)) {
      throw new Error(`Connection ${id} already exists`);
    }
  
    const transport = new StdioClientTransport(serverParams);
  
    const client = new MCPClient(
      {
        name: "WA-MCP-client",
        version: "0.1.0"
      },
      {
        capabilities: {
          prompts: {},
          resources: {},
          tools: {}
        }
      }
    );
  
    const connection: MCPConnection = {
      id,
      client,
      transport,
      state: ConnectionState.CONNECTING
    };
  
    this.connections.set(id, connection);
    await this.establishConnection(connection);
  }

  private createTransport(scriptPath: string): StdioClientTransport {
    const { command, args } = this.parseScriptCommand(scriptPath);
    const transport = new StdioClientTransport({ command, args }) as StdioClientTransport & {
      process?: import('child_process').ChildProcess;
    };
    
    // Store process reference
    const proc = this.processManager.spawn(command, args);
    transport.process = proc;
    return transport;
  }


  private parseScriptCommand(scriptPath: string): { command: string; args: string[] } {
    const parsed = parseCommandLine(scriptPath);
    const isPython = parsed.args[0]?.endsWith('.py');
    
    return {
      command: isPython ? 'python' : 'node',
      args: isPython ? parsed.args : ['--max-old-space-size=256', ...parsed.args]
    };
  }

  private async establishConnection(connection: MCPConnection): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.connectionTimeout);

      // Correct connect() usage
      await connection.client.connect(connection.transport);

      clearTimeout(timeout);
      this.setupConnectionMonitoring(connection);
      connection.state = ConnectionState.CONNECTED;
    } catch (error) {
      this.cleanupConnection(connection.id);
      throw error;
    }
  }

  private setupConnectionMonitoring(connection: MCPConnection): void {
    connection.heartbeatTimer = setInterval(async () => {
      try {
        await connection.client.ping();
      } catch (error) {
        console.error(`Heartbeat failed for ${connection.id}`);
        this.cleanupConnection(connection.id);
      }
    }, 30000);

    if (connection.transport.process) {
        connection.transport.process.on('close', () => 
          this.cleanupConnection(connection.id)
        );
      }
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;

    connection.state = ConnectionState.DISCONNECTING;
    await this.processManager.terminate(connection.transport.process);
    this.cleanupConnection(id);
  }

  private cleanupConnection(id: string): void {
    const connection = this.connections.get(id);
    if (!connection) return;

    clearInterval(connection.heartbeatTimer);
    this.processManager.cleanup(connection.transport.process);
    this.connections.delete(id);
  }

  getConnection(id: string): MCPConnection | undefined {
    return this.connections.get(id);
  }

  listConnections(): string[] {
    return Array.from(this.connections.keys());
  }
}
