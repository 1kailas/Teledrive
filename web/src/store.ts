import { create } from 'zustand';
import type { FileDTO, FolderDTO } from './api';
import { api } from './api';

export type ThemeMode = 'light' | 'dark' | 'system';
export type CardSize = 'tiny' | 'compact' | 'standard' | 'large' | 'xlarge';
export type NameDisplay = 'full' | 'multiline' | 'single';

export type SortBy = 'name' | 'updatedAt' | 'size' | 'type';
interface UiState {
  theme: ThemeMode;
  viewMode: 'grid' | 'list';
  cardSize: CardSize;
  nameDisplay: NameDisplay;
  sortBy: SortBy;
  sortDir: 'asc' | 'desc';
  detailsOpen: boolean;
  sidebarOpen: boolean;
  uploadConflict: 'rename' | 'replace' | 'error';
  desktopMode: boolean;
  setSort: (b: SortBy, d: 'asc' | 'desc') => void;
  setTheme: (t: ThemeMode) => void;
  setViewMode: (v: 'grid' | 'list') => void;
  setCardSize: (s: CardSize) => void;
  setNameDisplay: (v: NameDisplay) => void;
  setDetailsOpen: (v: boolean) => void;
  setSidebarOpen: (v: boolean) => void;
  setUploadConflict: (v: 'rename' | 'replace' | 'error') => void;
  setDesktopMode: (v: boolean) => void;
  loadServerSettings: () => Promise<void>;
}

const serverSetting = (k: string, v: unknown) => {
  try { localStorage.setItem(`td-${k}`, JSON.stringify(v)); } catch { /* */ }
  void api.patch('/api/settings', { [k]: v }).catch(() => {});
};
const localSetting = <T>(k: string, d: T): T => {
  try { const v = localStorage.getItem(`td-${k}`); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
};

export const useUi = create<UiState>()((set) => ({
  theme: localSetting('theme', 'system'),
  viewMode: localSetting('viewMode', 'grid'),
  cardSize: localSetting('cardSize', 'standard'),
  nameDisplay: localSetting('nameDisplay', 'full'),
  sortBy: localSetting('sortBy', 'name'),
  sortDir: localSetting('sortDir', 'asc'),
  detailsOpen: false,
  sidebarOpen: localSetting('sidebarOpen', typeof window !== 'undefined' ? window.innerWidth >= 768 : true),
  uploadConflict: localSetting('uploadConflict', 'rename'),
  desktopMode: false,
  setTheme: (theme) => { serverSetting('theme', theme); set({ theme }); },
  setSort: (sortBy, sortDir) => { serverSetting('sortBy', sortBy); serverSetting('sortDir', sortDir); set({ sortBy, sortDir }); },
  setViewMode: (viewMode) => { serverSetting('viewMode', viewMode); set({ viewMode }); },
  setCardSize: (cardSize) => { serverSetting('cardSize', cardSize); set({ cardSize }); },
  setNameDisplay: (nameDisplay) => { serverSetting('nameDisplay', nameDisplay); set({ nameDisplay }); },
  setDetailsOpen: (detailsOpen) => set({ detailsOpen }),
  setSidebarOpen: (sidebarOpen) => {
    try { localStorage.setItem('td-sidebarOpen', JSON.stringify(sidebarOpen)); } catch {}
    set({ sidebarOpen });
  },
  setUploadConflict: (uploadConflict) => { serverSetting('uploadConflict', uploadConflict); set({ uploadConflict }); },
  setDesktopMode: (desktopMode) => set({ desktopMode }),
  loadServerSettings: async () => {
    try {
      const { settings } = await api.get<{ settings: Record<string, unknown> }>('/api/settings');
      const patch: Partial<UiState> = {};
      if (settings['theme'] === 'light' || settings['theme'] === 'dark' || settings['theme'] === 'system') patch.theme = settings['theme'];
      if (settings['viewMode'] === 'grid' || settings['viewMode'] === 'list') patch.viewMode = settings['viewMode'];
      if (settings['cardSize'] === 'tiny' || settings['cardSize'] === 'compact' || settings['cardSize'] === 'standard' || settings['cardSize'] === 'large' || settings['cardSize'] === 'xlarge') patch.cardSize = settings['cardSize'];
      if (settings['nameDisplay'] === 'full' || settings['nameDisplay'] === 'multiline' || settings['nameDisplay'] === 'single') patch.nameDisplay = settings['nameDisplay'];
      if (settings['uploadConflict']) patch.uploadConflict = settings['uploadConflict'] as UiState['uploadConflict'];
      set(patch);
    } catch { /* fall back to localStorage */ }
  },
}));

// apply theme to <html>
export function applyTheme(mode: ThemeMode) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const dark = mode === 'dark' || (mode === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}
if (typeof window !== 'undefined' && typeof matchMedia === 'function') {
  useUi.subscribe((s) => applyTheme(s.theme));
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(useUi.getState().theme));
  } catch {}
}

// ---- toasts ----
export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'success' }
let toastId = 0;
interface ToastState { toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: number) => void }
export const useToasts = create<ToastState>()((set) => ({
  toasts: [],
  push: (t) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
export const toast = {
  info: (text: string) => useToasts.getState().push({ text, kind: 'info' }),
  error: (text: string) => useToasts.getState().push({ text, kind: 'error' }),
  success: (text: string) => useToasts.getState().push({ text, kind: 'success' }),
};

// ---- preview (lightbox) ----
interface PreviewState {
  files: FileDTO[];
  index: number;
  open: boolean;
  start: (files: FileDTO[], index: number) => void;
  close: () => void;
  nav: (d: number) => void;
  setIndex: (i: number) => void;
}
export const usePreview = create<PreviewState>()((set) => ({
  files: [], index: 0, open: false,
  start: (files, index) => set({ files, index, open: true }),
  close: () => set({ open: false }),
  nav: (d) => set((s) => ({ index: Math.max(0, Math.min(s.files.length - 1, s.index + d)) })),
  setIndex: (index) => set({ index }),
}));

// ---- dialogs ----
export type DialogKind =
  | { kind: 'rename'; item: { id: string; name: string; isFolder: boolean } }
  | { kind: 'newFolder'; parentId: string | null }
  | { kind: 'newText'; folderId: string | null }
  | { kind: 'move'; fileIds: string[]; folderIds: string[]; copy: boolean }
  | { kind: 'share'; fileId?: string; folderId?: string; name: string }
  | { kind: 'confirm'; title: string; body: string; danger?: boolean; onOk: () => void }
  | {
      kind: 'conflict';
      fileName: string;
      sourceSize: number;
      sourceTime?: number;
      targetSize: number;
      targetTime: number;
      conflictIndex: number;
      totalConflicts: number;
      onResolve: (action: 'replace' | 'rename' | 'skip', applyToAll: boolean) => void;
      onCancel?: () => void;
    };
interface DialogState { dialog: DialogKind | null; open: (d: DialogKind) => void; close: () => void }
export const useDialog = create<DialogState>()((set) => ({
  dialog: null, open: (dialog) => set({ dialog }), close: () => set({ dialog: null }),
}));

// ---- clipboard ----
export interface ClipboardItem {
  id: string;
  kind: 'file' | 'folder';
  name: string;
}
interface ClipboardStore {
  items: ClipboardItem[];
  mode: 'cut' | 'copy' | null;
  setClipboard: (items: ClipboardItem[], mode: 'cut' | 'copy') => void;
  clearClipboard: () => void;
}
export const useClipboard = create<ClipboardStore>()((set) => ({
  items: [],
  mode: null,
  setClipboard: (items, mode) => set({ items, mode }),
  clearClipboard: () => set({ items: [], mode: null }),
}));

// ---- selection handled inside Explorer ----

export type { FileDTO, FolderDTO };
