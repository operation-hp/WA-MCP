// SPDX-License-Identifier: Apache-2.0

import { MCPWhatsAppClient } from './lib/whatsapp-client';

async function main() {
  const client = new MCPWhatsAppClient();
  
  try {
    await client.start();
    
    process.on('SIGINT', async () => {
      await client.cleanup();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      await client.cleanup();
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Failed to start:', error);
    await client.cleanup();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}