import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const teledriveJsonPath = '/mnt/c/Users/Kailasnath T/AppData/Roaming/TeleDrive/data/teledrive.json';
const moviePath = '/mnt/c/Users/Kailasnath T/Videos/Inception.2010.1080p.NF.WEB-DL.English.DDP5.1.H.264-ADDYRIPS.mp4';
const progressPath = path.resolve(__dirname, '../data/inception-upload-progress.json');
const catalogPath = path.resolve(__dirname, '../public/catalog.json');

const PART_SIZE = 19.5 * 1024 * 1024; // 20,447,232 bytes (safely under Telegram's 20MB getFile limit)
const CHANNEL_ID = '-1004396487326';

interface BotInfo {
  id: string;
  token: string;
}

interface UploadedPart {
  partIndex: number;
  size: number;
  telegramFileId: string;
  botId: string;
}

async function main() {
  if (!fs.existsSync(moviePath)) {
    console.error('Movie file not found:', moviePath);
    process.exit(1);
  }

  const rawConfig = fs.readFileSync(teledriveJsonPath, 'utf8');
  const config = JSON.parse(rawConfig) as { bots?: BotInfo[] };
  const bots = config.bots || [];

  if (bots.length === 0) {
    console.error('No bots found in teledrive.json');
    process.exit(1);
  }

  const stat = fs.statSync(moviePath);
  const fileSize = stat.size;
  const totalParts = Math.ceil(fileSize / PART_SIZE);
  console.log(`Movie size: ${fileSize} bytes (~${(fileSize / 1e9).toFixed(2)} GB)`);
  console.log(`Total parts to upload: ${totalParts} (${(PART_SIZE / 1e6).toFixed(1)} MB each)`);
  console.log(`Available bots: ${bots.length}`);

  fs.mkdirSync(path.dirname(progressPath), { recursive: true });
  let progress: UploadedPart[] = [];
  if (fs.existsSync(progressPath)) {
    try {
      progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      console.log(`Resuming from ${progress.length} already uploaded parts.`);
    } catch {}
  }

  const uploadedIndices = new Set(progress.map((p) => p.partIndex));
  const remainingIndices: number[] = [];
  for (let i = 0; i < totalParts; i++) {
    if (!uploadedIndices.has(i)) remainingIndices.push(i);
  }

  console.log(`Remaining parts to upload: ${remainingIndices.length}`);
  const fd = fs.openSync(moviePath, 'r');

  const botApiUrl = (process.env.TELEGRAM_BOT_API_URL || 'http://127.0.0.1:8081').replace(/\/+$/, '');
  console.log(`Using Bot API URL: ${botApiUrl}`);

  async function uploadPart(partIndex: number, bot: BotInfo, attempt = 1): Promise<UploadedPart> {
    const offset = partIndex * PART_SIZE;
    const currentPartSize = Math.min(PART_SIZE, fileSize - offset);
    const buffer = Buffer.alloc(currentPartSize);
    fs.readSync(fd, buffer, 0, currentPartSize, offset);

    const formData = new FormData();
    formData.append('chat_id', CHANNEL_ID);
    formData.append('document', new Blob([buffer]), `inception_part_${partIndex}.mp4`);

    try {
      const res = await fetch(`${botApiUrl}/bot${bot.token}/sendDocument`, {
        method: 'POST',
        body: formData,
      });

      const json = await res.json() as {
        ok?: boolean;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
        result?: { document?: { file_id?: string } };
      };

      if (!json.ok || !json.result?.document?.file_id) {
        if (json.error_code === 429 && json.parameters?.retry_after) {
          const waitSec = json.parameters.retry_after + 1;
          console.warn(`[Bot ${bot.id}] Rate limited (429), waiting ${waitSec}s...`);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          return uploadPart(partIndex, bot, attempt + 1);
        }
        if (attempt < 5) {
          console.warn(`[Part ${partIndex}] Upload error: ${json.description}, retrying (attempt ${attempt + 1})...`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          return uploadPart(partIndex, bot, attempt + 1);
        }
        throw new Error(`Failed to upload part ${partIndex}: ${json.description}`);
      }

      const fileId = json.result.document.file_id;
      return {
        partIndex,
        size: currentPartSize,
        telegramFileId: fileId,
        botId: bot.id,
      };
    } catch (err) {
      if (attempt < 5) {
        console.warn(`[Part ${partIndex}] Network error: ${(err as Error).message}, retrying...`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        return uploadPart(partIndex, bot, attempt + 1);
      }
      throw err;
    }
  }

  // Work queue with concurrency across available bots
  let botIndex = 0;
  const activeWorkers = new Set<Promise<void>>();
  let completedCount = progress.length;

  for (const pIdx of remainingIndices) {
    const assignedBot = bots[botIndex % bots.length]!;
    botIndex++;

    const task = (async () => {
      const result = await uploadPart(pIdx, assignedBot);
      progress.push(result);
      completedCount++;
      fs.writeFileSync(progressPath, JSON.stringify(progress, null, 2));
      const pct = ((completedCount / totalParts) * 100).toFixed(1);
      console.log(`[${completedCount}/${totalParts} - ${pct}%] Part ${result.partIndex} uploaded via bot ${result.botId}`);
    })();

    activeWorkers.add(task);
    task.finally(() => activeWorkers.delete(task));

    if (activeWorkers.size >= bots.length) {
      await Promise.race(activeWorkers);
    }
  }

  await Promise.all(activeWorkers);
  fs.closeSync(fd);

  // Sort parts by index
  progress.sort((a, b) => a.partIndex - b.partIndex);

  // Update catalog.json
  if (fs.existsSync(catalogPath)) {
    const rawCat = fs.readFileSync(catalogPath, 'utf8');
    const cat = JSON.parse(rawCat) as { items: any[] };
    const incIdx = cat.items.findIndex((item) => item.name.toLowerCase().includes('inception'));
    if (incIdx >= 0) {
      cat.items[incIdx].name = 'Inception.2010.1080p.NF.WEB-DL.English.H.264.mp4';
      cat.items[incIdx].mimeType = 'video/mp4';
      cat.items[incIdx].size = fileSize;
      cat.items[incIdx].duration = 8884;
      cat.items[incIdx].description = 'Dom Cobb is a skilled thief who steals valuable secrets from deep within the subconscious during the dream state. Full-length feature film (2h 28m).';
      cat.items[incIdx].parts = progress;
      fs.writeFileSync(catalogPath, JSON.stringify(cat, null, 2));
      console.log(`Successfully updated ${catalogPath} with ${progress.length} parts!`);
    }
  }

  console.log('UPLOAD COMPLETE! All parts are ready for Cloudflare Pages streaming.');
}

void main();
