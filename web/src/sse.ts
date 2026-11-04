import { queryClient } from './query';
import { onPartEvent, onFileReady, refreshUploadConfig, resetConfigCache } from './upload';

let es: EventSource | null = null;
let delay = 1000;

export function startSse(): void {
  if (es) return;
  connect();
}
function connect() {
  es = new EventSource('/api/events');
  es.onopen = () => { delay = 1000; };
  es.addEventListener('file.updated', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { fileId: string; status: string };
    onFileReady(d.fileId);
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
    void queryClient.invalidateQueries({ queryKey: ['file', d.fileId] });
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
    void queryClient.invalidateQueries({ queryKey: ['search'] });
  });
  es.addEventListener('upload.part', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { uploadId: string; idx: number; status: string };
    onPartEvent(d.uploadId, d.idx, d.status);
  });
  es.addEventListener('thumbnail.ready', (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { fileId: string };
    void queryClient.invalidateQueries({ queryKey: ['drive'] });
    void queryClient.invalidateQueries({ queryKey: ['file', d.fileId] });
  });
  es.addEventListener('storage.changed', () => {
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
    void queryClient.invalidateQueries({ queryKey: ['system'] });
  });
  es.addEventListener('settings.upload', () => {
    void refreshUploadConfig().catch(() => resetConfigCache());
    void queryClient.invalidateQueries({ queryKey: ['settings-part-size'] });
    void queryClient.invalidateQueries({ queryKey: ['config'] });
  });
  es.onerror = () => {
    es?.close();
    es = null;
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30_000);
  };
}
