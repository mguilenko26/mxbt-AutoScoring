/** Локальный запуск: mock-сервисы + бот в одном процессе. `npm run dev` */
import { createMockServer, optionsFromEnv } from '../mocks/server.js';
import { startBot } from '../src/main.js';

const mockOpts = optionsFromEnv();
await new Promise<void>((resolve) => createMockServer(mockOpts).listen(mockOpts.port, resolve));
console.log(`[mocks] http://localhost:${mockOpts.port} (страница оплаты: ${mockOpts.publicUrl}/pay/…)`);
await startBot();
