import { EventEmitter } from 'node:events';
import type { UploadSettingsSnapshot } from './settings.js';

export interface EventMap {
  'file.updated': { fileId: string; status: string };
  'upload.part': { uploadId: string; idx: number; status: string };
  'thumbnail.ready': { fileId: string };
  'storage.changed': Record<string, never>;
  'settings.upload': UploadSettingsSnapshot;
}

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof EventMap>(event: K, fn: (payload: EventMap[K]) => void): () => void {
    this.emitter.on(event, fn);
    return () => this.emitter.off(event, fn);
  }

  onAny(fn: (event: keyof EventMap, payload: EventMap[keyof EventMap]) => void): () => void {
    const handlers = (['file.updated', 'upload.part', 'thumbnail.ready', 'storage.changed', 'settings.upload'] as const).map(
      (e) => this.on(e, (payload) => fn(e, payload as EventMap[keyof EventMap])),
    );
    return () => handlers.forEach((off) => off());
  }
}
