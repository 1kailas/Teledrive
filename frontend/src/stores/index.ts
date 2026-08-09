/**
 * TeleDrive Frontend — Zustand Store
 *
 * Global state management for theme, upload queue, selections, etc.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UploadTask, DownloadTask, ViewMode, SortConfig, ContextMenuState, Toast, ToastType } from '../types';

// ============================================
// Theme Store
// ============================================

interface ThemeState {
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  resolvedTheme: 'light' | 'dark';
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'dark',
      resolvedTheme: 'dark',
      setTheme: (theme) => {
        let resolved: 'light' | 'dark';
        if (theme === 'system') {
          resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } else {
          resolved = theme;
        }

        document.documentElement.classList.toggle('dark', resolved === 'dark');
        set({ theme, resolvedTheme: resolved });
      },
    }),
    { name: 'teledrive-theme' }
  )
);

// ============================================
// Upload Store
// ============================================

interface UploadState {
  uploads: UploadTask[];
  addUpload: (task: UploadTask) => void;
  updateUpload: (id: string, updates: Partial<UploadTask>) => void;
  removeUpload: (id: string) => void;
  clearCompleted: () => void;
}

export const useUploadStore = create<UploadState>((set) => ({
  uploads: [],
  addUpload: (task) =>
    set((state) => ({ uploads: [...state.uploads, task] })),
  updateUpload: (id, updates) =>
    set((state) => ({
      uploads: state.uploads.map((u) =>
        u.id === id ? { ...u, ...updates } : u
      ),
    })),
  removeUpload: (id) =>
    set((state) => ({
      uploads: state.uploads.filter((u) => u.id !== id),
    })),
  clearCompleted: () =>
    set((state) => ({
      uploads: state.uploads.filter((u) => u.status !== 'complete'),
    })),
}));

// ============================================
// Download Store
// ============================================

interface DownloadState {
  downloads: DownloadTask[];
  addDownload: (task: DownloadTask) => void;
  updateDownload: (id: string, updates: Partial<DownloadTask>) => void;
  removeDownload: (id: string) => void;
  clearCompleted: () => void;
}

export const useDownloadStore = create<DownloadState>((set) => ({
  downloads: [],
  addDownload: (task) =>
    set((state) => ({ downloads: [...state.downloads, task] })),
  updateDownload: (id, updates) =>
    set((state) => ({
      downloads: state.downloads.map((d) =>
        d.id === id ? { ...d, ...updates } : d
      ),
    })),
  removeDownload: (id) =>
    set((state) => ({
      downloads: state.downloads.filter((d) => d.id !== id),
    })),
  clearCompleted: () =>
    set((state) => ({
      downloads: state.downloads.filter((d) => d.status !== 'complete'),
    })),
}));

// ============================================
// UI Store
// ============================================

interface UIState {
  viewMode: ViewMode;
  sort: SortConfig;
  contextMenu: ContextMenuState;
  selectedFiles: Set<string>;
  selectedFolders: Set<string>;
  sidebarOpen: boolean;
  uploadPanelOpen: boolean;
  detailPanelOpen: boolean;
  detailPanelItem: { id: string; type: 'file' | 'folder' } | null;
  previewFile: string | null;
  botCount: number;
  setViewMode: (mode: ViewMode) => void;
  setSort: (sort: SortConfig) => void;
  setContextMenu: (menu: ContextMenuState) => void;
  toggleFileSelection: (id: string) => void;
  toggleFolderSelection: (id: string) => void;
  clearSelection: () => void;
  selectAll: (ids: string[]) => void;
  selectAllFolders: (ids: string[]) => void;
  setSidebarOpen: (open: boolean) => void;
  setUploadPanelOpen: (open: boolean) => void;
  setDetailPanel: (open: boolean, item?: { id: string; type: 'file' | 'folder' } | null) => void;
  setPreviewFile: (fileId: string | null) => void;
  setBotCount: (count: number) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      viewMode: 'grid' as ViewMode,
      sort: { field: 'name', order: 'asc' } as SortConfig,
      contextMenu: { visible: false, x: 0, y: 0, item: null, type: null },
      selectedFiles: new Set<string>(),
      selectedFolders: new Set<string>(),
      sidebarOpen: true,
      uploadPanelOpen: false,
      detailPanelOpen: false,
      detailPanelItem: null,
      previewFile: null,
      botCount: 1,

      setViewMode: (mode) => set({ viewMode: mode }),
      setSort: (sort) => set({ sort }),
      setContextMenu: (menu) => set({ contextMenu: menu }),
      toggleFileSelection: (id) =>
        set((state) => {
          const next = new Set(state.selectedFiles);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { selectedFiles: next };
        }),
      toggleFolderSelection: (id) =>
        set((state) => {
          const next = new Set(state.selectedFolders);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { selectedFolders: next };
        }),
      clearSelection: () => set({ selectedFiles: new Set(), selectedFolders: new Set() }),
      selectAll: (ids) => set({ selectedFiles: new Set(ids) }),
      selectAllFolders: (ids) => set({ selectedFolders: new Set(ids) }),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setUploadPanelOpen: (open) => set({ uploadPanelOpen: open }),
      setDetailPanel: (open, item) => set({ detailPanelOpen: open, detailPanelItem: item || null }),
      setPreviewFile: (fileId) => set({ previewFile: fileId }),
      setBotCount: (count) => set({ botCount: count }),
    }),
    {
      name: 'teledrive-ui',
      partialize: (state) => ({
        viewMode: state.viewMode,
        sort: state.sort,
        sidebarOpen: state.sidebarOpen,
      }),
    }
  )
);

// ============================================
// Toast Store
// ============================================

interface ToastState {
  toasts: Toast[];
  addToast: (type: ToastType, title: string, message?: string, duration?: number) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (type, title, message, duration = 4000) => {
    const id = crypto.randomUUID();
    const toast: Toast = { id, type, title, message, duration };
    set((state) => ({ toasts: [...state.toasts, toast] }));

    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
  clearToasts: () => set({ toasts: [] }),
}));
