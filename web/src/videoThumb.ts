// Client-side video thumbnails: seek a hidden <video> to a frame, draw to
// canvas, POST the JPEG to /api/files/:id/thumbnail (Rust R3). The Node
// server may lack the endpoint — every failure is quiet and non-fatal.
import { queryClient } from './query';

const isDesktop = () =>
  (window as { desktopApi?: { isDesktop?: boolean } }).desktopApi?.isDesktop === true;

const failedKey = 'td-thumb-failed';
const failed = new Set<string>(JSON.parse(localStorage.getItem(failedKey) ?? '[]') as string[]);
const inFlight = new Set<string>();
const queue: string[] = [];
let draining = false;

function persistFailed(): void {
  localStorage.setItem(failedKey, JSON.stringify([...failed]));
}

async function capture(fileId: string): Promise<void> {
  const url = `/api/files/${fileId}/content`;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.src = url;
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 15_000);
      video.onerror = () => { clearTimeout(timer); reject(new Error('video error')); };
      video.onloadedmetadata = () => {
        video.currentTime = Math.min(1, (video.duration || 2) / 2);
      };
      video.onseeked = () => {
        try {
          const scale = Math.min(1, 480 / (video.videoWidth || 480));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((b) => {
            clearTimeout(timer);
            if (b) resolve(b); else reject(new Error('toBlob failed'));
          }, 'image/jpeg', 0.8);
        } catch (e) { clearTimeout(timer); reject(e as Error); }
      };
    });
    const res = await fetch(`/api/files/${fileId}/thumbnail`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-requested-with': 'teledrive', 'content-type': 'image/jpeg' },
      body: blob,
    });
    if (!res.ok) throw new Error(`thumbnail POST failed: ${res.status}`);
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      if (failed.has(id) || inFlight.has(id)) continue;
      inFlight.add(id);
      try { await capture(id); } catch { failed.add(id); persistFailed(); }
      inFlight.delete(id);
    }
  } finally {
    draining = false;
  }
}

/** Queue a thumbnail capture for one video file — desktop-gated by default
 *  so browser/Node sessions aren't spammed with full-file requests. */
export function requestVideoThumbnail(fileId: string, opts?: { force?: boolean }): void {
  if (!opts?.force && !isDesktop()) return;
  if (failed.has(fileId) || inFlight.has(fileId) || queue.includes(fileId)) return;
  queue.push(fileId);
  void drain();
}
