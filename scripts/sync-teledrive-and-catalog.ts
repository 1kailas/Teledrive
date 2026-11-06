import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const teledriveJsonPath = '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/teledrive.json';
const teledriveDbPath = path.resolve(rootDir, 'data/teledrive.db');
const catalogPath = path.resolve(rootDir, 'stream-platform/public/catalog.json');
const distCatalogPath = path.resolve(rootDir, 'stream-platform/dist/catalog.json');

console.log('--- Syncing TeleDrive Desktop & Streaming Catalog ---');

// 1. Read teledrive.json
if (!fs.existsSync(teledriveJsonPath)) {
  console.error('teledrive.json not found at:', teledriveJsonPath);
  process.exit(1);
}

const teledriveData = JSON.parse(fs.readFileSync(teledriveJsonPath, 'utf8'));
const folders: any[] = teledriveData.folders || [];
const files: any[] = teledriveData.files || [];
const parts: any[] = teledriveData.parts || [];

// Ensure root Videos folder
let videosFolder = folders.find((f) => f.name === 'Videos' && !f.parent_id);
if (!videosFolder) {
  videosFolder = {
    id: 'fe3989a2-1188-46d9-9e64-918c953b8e2b',
    parent_id: null,
    name: 'Videos',
    color: null,
    starred: 0,
    trashed_at: null,
    trash_root: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  folders.push(videosFolder);
}

// Helper to ensure a folder
function ensureFolder(parentId: string | null, name: string): any {
  let f = folders.find((item) => item.name === name && item.parent_id === parentId && !item.trashed_at);
  if (!f) {
    f = {
      id: crypto.randomUUID(),
      parent_id: parentId,
      name,
      color: null,
      starred: 0,
      trashed_at: null,
      trash_root: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    folders.push(f);
    console.log(`+ Added folder: ${name} (parent: ${parentId})`);
  }
  return f;
}

// Helper to ensure dummy episode file
function ensureEpisodeFile(folderId: string, filename: string, durationSec: number, sizeBytes: number): any {
  let f = files.find((item) => item.name === filename && item.folder_id === folderId && !item.trashed_at);
  if (!f) {
    const fileId = crypto.randomUUID();
    const blobId = crypto.randomUUID();
    f = {
      id: fileId,
      folder_id: folderId,
      blob_id: blobId,
      name: filename,
      extension: 'mp4',
      mime_type: 'video/mp4',
      category: 'video',
      size: sizeBytes,
      status: 'ready',
      description: `Episode streamed directly from TeleDrive storage.`,
      tags: 'series,stream,video',
      starred: 0,
      has_thumbnail: 0,
      width: 1920,
      height: 1080,
      duration: durationSec,
      metadata: JSON.stringify({ format: 'MP4', duration: durationSec, resolution: '1080p' }),
      taken_at: null,
      trashed_at: null,
      trash_root: 0,
      last_accessed_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    files.push(f);

    // Create 1 part for this episode
    parts.push({
      blob_id: blobId,
      part_index: 0,
      size: sizeBytes,
      telegram_file_id: `f2222222_${fileId.replace(/-/g, '').slice(0, 24)}`,
      bot_id: '2222222',
    });
    console.log(`+ Added episode: ${filename}`);
  }
  return f;
}

// 1. Ensure `stream` folder under Videos
const streamFolder = ensureFolder(videosFolder.id, 'stream');

// 2. Ensure `Lost` series folder (the user created this!)
let lostFolder = folders.find((f) => f.name === 'Lost' && !f.trashed_at);
if (!lostFolder) {
  lostFolder = ensureFolder(videosFolder.id, 'Lost');
}
const lostS1 = ensureFolder(lostFolder.id, 'Season 1');
const lostS2 = ensureFolder(lostFolder.id, 'Season 2');
ensureEpisodeFile(lostS1.id, 'Lost.S01E01.Pilot.Part.1.mp4', 2540, 485120400);
ensureEpisodeFile(lostS1.id, 'Lost.S01E02.Pilot.Part.2.mp4', 2420, 462100800);
ensureEpisodeFile(lostS2.id, 'Lost.S02E01.Man.of.Science.Man.of.Faith.mp4', 2600, 501230000);

// 3. Ensure `Cosmos: Possible Worlds` series folder
const cosmosFolder = ensureFolder(streamFolder.id, 'Cosmos: Possible Worlds');
const cosmosS1 = ensureFolder(cosmosFolder.id, 'Season 1');
const cosmosS2 = ensureFolder(cosmosFolder.id, 'Season 2');
ensureEpisodeFile(cosmosS1.id, 'Cosmos.S01E01.Ladder.to.the.Stars.mp4', 2700, 512000000);
ensureEpisodeFile(cosmosS1.id, 'Cosmos.S01E02.Shadows.of.Forgotten.Ancestors.mp4', 2650, 498000000);
ensureEpisodeFile(cosmosS2.id, 'Cosmos.S02E01.Vast.Universal.Cosmos.mp4', 2800, 530000000);

// 4. Ensure `Example TV Series` folder
const exampleSeriesFolder = ensureFolder(streamFolder.id, 'Example TV Series');
const exampleS1 = ensureFolder(exampleSeriesFolder.id, 'Season 1');
const exampleS2 = ensureFolder(exampleSeriesFolder.id, 'Season 2');
ensureEpisodeFile(exampleS1.id, 'Example.Series.S01E01.Pilot.mp4', 2400, 450000000);

// 5. Ensure `Inception` has complete duration & metadata in teledrive.json
const incFile = files.find((f) => f.name?.toLowerCase().includes('inception') || f.id === '9bd298eb-844b-4062-b216-590c78969698');
if (incFile) {
  incFile.duration = 8884;
  incFile.description = 'Dom Cobb is a skilled thief who steals valuable secrets from deep within the subconscious during the dream state. Full-length feature film (2h 28m).';
  incFile.metadata = JSON.stringify({ format: 'MKV', resolution: '1080p', duration: 8884 });
}

// 6. Write updated teledrive.json
fs.writeFileSync(teledriveJsonPath, JSON.stringify(teledriveData, null, 2));
console.log('✔ Updated teledrive.json with unified template folders and series!');

// 7. Update SQLite teledrive.db as well if exists
async function main() {
  if (fs.existsSync(teledriveDbPath)) {
    try {
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      const Database = req(path.resolve(rootDir, 'server/node_modules/better-sqlite3'));
      const db = new Database(teledriveDbPath);

      // Sync Lost into teledrive.db
      const existingLost = db.prepare("SELECT * FROM folders WHERE name = 'Lost'").get();
      if (!existingLost) {
        db.prepare("INSERT INTO folders (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
          lostFolder.id,
          videosFolder.id,
          'Lost',
          Date.now(),
          Date.now()
        );
        db.prepare("INSERT INTO folders (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
          lostS1.id,
          lostFolder.id,
          'Season 1',
          Date.now(),
          Date.now()
        );
        db.prepare("INSERT INTO folders (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
          lostS2.id,
          lostFolder.id,
          'Season 2',
          Date.now(),
          Date.now()
        );
        console.log('✔ Synced Lost series into data/teledrive.db');
      }
    } catch (e: any) {
      console.warn('SQLite update error:', e.message);
    }
  }

  console.log('Sync complete.');
}

void main();
