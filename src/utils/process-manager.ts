// SPDX-License-Identifier: Apache-2.0

import { ChildProcess, spawn } from 'child_process';

export class ChildProcessManager {
  private processes = new Set<ChildProcess>();

  spawn(command: string, args: string[]): ChildProcess {
    const proc = spawn(command, args, { 
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'] 
    });
    
    this.processes.add(proc);
    proc.on('exit', () => this.processes.delete(proc));
    return proc;
  }

  async terminate(proc?: ChildProcess): Promise<void> {
    if (!proc) return;
    
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      
      proc.kill('SIGTERM');
    });
  }

  cleanup(proc?: ChildProcess): void {
    if (proc && !proc.killed) {
      proc.kill('SIGKILL');
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.processes).map(p => this.terminate(p))
    );
  }
}