import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateTemplateFolders } from '../server/src/db/repos/folders.js';
import { syncTeleDriveToCatalog } from '../server/src/services/mediaEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const dbPath = path.resolve(rootDir, 'data/teledrive.db');
const catalogPath = path.resolve(rootDir, 'stream-platform/public/catalog.json');

const require = createRequire(import.meta.url);
const Database = require(path.resolve(rootDir, 'server/node_modules/better-sqlite3'));

console.log('Connecting to database:', dbPath);
const db = new Database(dbPath);

console.log('Ensuring TeleDrive template folders...');
const result = generateTemplateFolders(db);
for (const item of result.created) {
  console.log(`  ✔ ${item.path}`);
}

console.log('Syncing streaming catalog...');
const count = syncTeleDriveToCatalog(db, catalogPath);
console.log(`Synced ${count} items/series to ${catalogPath}`);

console.log('\nAll template folders are ready in TeleDrive:');
console.log('  Videos/stream/                        (Direct movies)');
console.log('  Videos/stream/Cosmos: Possible Worlds/Season 1');
console.log('  Videos/stream/Cosmos: Possible Worlds/Season 2');
console.log('  Videos/stream/Example TV Series/Season 1');
console.log('  Videos/stream/Example TV Series/Season 2');
console.log('  Photos/Wallpapers');
console.log('  Audio/Soundtracks');
console.log('  Audio/Podcasts');
console.log('  Documents/Work');
console.log('  Documents/Personal');
