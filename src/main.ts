import { startTelegram } from './assistant/main.js';
startTelegram().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
