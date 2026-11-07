import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import clsx from 'clsx';
import {
  Download, Share2, Pencil, FolderInput, Copy, Star, Info, Trash2, RefreshCw,
  Eye, FolderPlus, Upload, FilePlus2, Image as ImageIcon, Play, ArrowUp, ArrowDown, Loader2,
  LayoutGrid, List, CheckSquare, X, Scissors, Clipboard, Palette,
} from 'lucide-react';
import { api, type FileDTO, type FolderDTO } from '../api';
import { useUi, useDialog, usePreview, useClipboard, toast, type CardSize } from '../store';

export interface CardSpec {
  minWidth: number;
  previewHeight: string;
  folderCols: string;
  folderPadding: string;
  folderIconSize: number;
  folderFontSize: string;
}

const CARD_SPECS: Record<CardSize, CardSpec> = {
  tiny: {
    minWidth: 175,
    previewHeight: 'h-32',
    folderCols: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3',
    folderPadding: 'px-3.5 py-2.5',
    folderIconSize: 18,
    folderFontSize: 'text-xs',
  },
  compact: {
    minWidth: 200,
    previewHeight: 'h-36',
    folderCols: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3',
    folderPadding: 'px-3.5 py-2.5',
    folderIconSize: 18,
    folderFontSize: 'text-[12.5px]',
  },
  standard: {
    minWidth: 235,
    previewHeight: 'h-42',
    folderCols: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5',
    folderPadding: 'px-4 py-3',
    folderIconSize: 20,
    folderFontSize: 'text-[13px]',
  },
  large: {
    minWidth: 280,
    previewHeight: 'h-50',
    folderCols: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4',
    folderPadding: 'px-4.5 py-3.5',
    folderIconSize: 22,
    folderFontSize: 'text-[13.5px]',
  },
  xlarge: {
    minWidth: 340,
    previewHeight: 'h-60',
    folderCols: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4.5',
    folderPadding: 'px-5 py-4',
    folderIconSize: 24,
    folderFontSize: 'text-sm',
  },
};
import { fmtBytes, relDate, itemId, itemName, isTextEditable, FolderIcon, typeLabel, sortItems, type Item } from '../utils';
import { Thumb, FileTypeIcon, StarBadge, EmptyState } from './ui';
import { ContextMenu, type MenuItem } from './Menu';
import { startUpload, startUploadsWithConflictCheck, pickNativeFiles, isDesktopNativeUploads } from '../upload';
import { startDownload } from '../download';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { requestVideoThumbnail } from '../videoThumb';
import { DetailsPanel } from './DetailsPanel';

export function openContent(f: FileDTO, download = false) {
  if (download) {
    void startDownload(f);
  } else {
    usePreview.getState().start([f], 0);
  }
}

export function itemMenu(opts: {
  file?: FileDTO; folder?: FolderDTO;
  onOpen?: () => void; onRefresh: () => void; onDetails?: () => void;
}): (MenuItem | null)[] {
  const { file, folder, onOpen, onRefresh, onDetails } = opts;
  const d = useDialog.getState().open;
  const desktop = useUi.getState().desktopMode;
  if (file) {
    return [
      { label: 'Preview', icon: <Eye size={15} />, onClick: () => onOpen?.() },
      { label: 'Download', icon: <Download size={15} />, onClick: () => openContent(file, true) },
      ...(desktop ? [] : [{ label: 'Share', icon: <Share2 size={15} />, onClick: () => d({ kind: 'share', fileId: file.id, name: file.name }) }]),
      null,
      { label: 'Cut (Ctrl+X)', icon: <Scissors size={15} />, onClick: () => { useClipboard.getState().setClipboard([{ id: file.id, kind: 'file', name: file.name }], 'cut'); toast.info(`Cut "${file.name}"`); } },
      { label: 'Copy (Ctrl+C)', icon: <Copy size={15} />, onClick: () => { useClipboard.getState().setClipboard([{ id: file.id, kind: 'file', name: file.name }], 'copy'); toast.info(`Copied "${file.name}"`); } },
      { label: 'Rename', icon: <Pencil size={15} />, onClick: () => d({ kind: 'rename', item: { id: file.id, name: file.name, isFolder: false } }) },
      { label: 'Move to…', icon: <FolderInput size={15} />, onClick: () => d({ kind: 'move', fileIds: [file.id], folderIds: [], copy: false }) },
      { label: 'Make a duplicate', icon: <Copy size={15} />, onClick: () => void api.post(`/api/files/${file.id}/copy`, {}).then(onRefresh).catch((e) => toast.error(e.message)) },
      { label: file.starred ? 'Unstar' : 'Star', icon: <Star size={15} />, onClick: () => void api.patch(`/api/files/${file.id}`, { starred: !file.starred }).then(onRefresh) },
      null,
      ...(isTextEditable(file) ? [{ label: 'Edit text', icon: <Pencil size={15} />, onClick: () => onOpen?.() }] : []),
      ...(file.category === 'image' || (!desktop && (file.category === 'video' || file.extension === 'pdf' || file.hasThumbnail)) ? [{ label: 'Regenerate thumbnail', icon: <ImageIcon size={15} />, onClick: () => void api.post(`/api/files/${file.id}/thumbnail`).then(onRefresh).catch(() => toast.error('No thumbnail could be generated')) }] : []),
      { label: 'Details', icon: <Info size={15} />, onClick: () => onDetails?.() },
      null,
      { label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, onClick: () => void api.post('/api/items/trash', { fileIds: [file.id] }).then(onRefresh) },
      {
        label: 'Delete permanently',
        icon: <Trash2 size={15} />,
        danger: true,
        onClick: () => {
          d({
            kind: 'confirm',
            title: `Delete "${file.name}"?`,
            body: `Permanently delete this file and remove all parts from your Telegram channel? This cannot be undone.`,
            danger: true,
            onOk: () => void api.post('/api/items/delete', { fileIds: [file.id] }).then(onRefresh),
          });
        },
      },
    ];
  }
  const f = folder!;
  const folderColors = ['#f59e0b', '#0284c7', '#10b981', '#f43f5e', '#8b5cf6', '#64748b'];
  return [
    { label: 'Open', icon: <Eye size={15} />, onClick: () => onOpen?.() },
    ...(desktop ? [] : [{ label: 'Share', icon: <Share2 size={15} />, onClick: () => d({ kind: 'share', folderId: f.id, name: f.name }) }]),
    { label: 'Download as zip', icon: <Download size={15} />, onClick: () => void downloadZip([], [f.id]) },
    null,
    { label: 'Cut (Ctrl+X)', icon: <Scissors size={15} />, onClick: () => { useClipboard.getState().setClipboard([{ id: f.id, kind: 'folder', name: f.name }], 'cut'); toast.info(`Cut "${f.name}"`); } },
    { label: 'Copy (Ctrl+C)', icon: <Copy size={15} />, onClick: () => { useClipboard.getState().setClipboard([{ id: f.id, kind: 'folder', name: f.name }], 'copy'); toast.info(`Copied "${f.name}"`); } },
    { label: 'Rename', icon: <Pencil size={15} />, onClick: () => d({ kind: 'rename', item: { id: f.id, name: f.name, isFolder: true } }) },
    { label: 'Move to…', icon: <FolderInput size={15} />, onClick: () => d({ kind: 'move', fileIds: [], folderIds: [f.id], copy: false }) },
    { label: 'Copy to…', icon: <Copy size={15} />, onClick: () => d({ kind: 'move', fileIds: [], folderIds: [f.id], copy: true }) },
    {
      label: 'Change color',
      icon: <Palette size={15} />,
      onClick: () => {
        const nextColor = folderColors[(folderColors.indexOf(f.color || '#f59e0b') + 1) % folderColors.length];
        void api.patch(`/api/folders/${f.id}`, { color: nextColor }).then(onRefresh);
      },
    },
    { label: f.starred ? 'Unstar' : 'Star', icon: <Star size={15} />, onClick: () => void api.post('/api/items/star', { folderIds: [f.id], starred: !f.starred }).then(onRefresh) },
    { label: 'Details', icon: <Info size={15} />, onClick: () => onDetails?.() },
    null,
    { label: 'Move to trash', icon: <Trash2 size={15} />, danger: true, onClick: () => void api.post('/api/items/trash', { folderIds: [f.id] }).then(onRefresh) },
    {
      label: 'Delete permanently',
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: () => {
        d({
          kind: 'confirm',
          title: `Delete "${f.name}"?`,
          body: `Permanently delete this folder, its nested files, and remove all parts from your Telegram channel? This cannot be undone.`,
          danger: true,
          onOk: () => void api.post('/api/items/delete', { folderIds: [f.id] }).then(onRefresh),
        });
      },
    },
  ];
}

export async function downloadZip(fileIds: string[], folderIds: string[]) {
  try {
    toast.info('Preparing ZIP archive…');
    const { url } = await api.post<{ url: string }>('/api/zip', { fileIds, folderIds });
    const a = document.createElement('a');
    a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { toast.error((e as Error).message); }
}

export function emptySpaceMenu(
  folderId: string | null,
  onRefresh: () => void,
  onPaste?: () => void,
  clipboardCount = 0
): (MenuItem | null)[] {
  const d = useDialog.getState().open;
  return [
    { label: 'New folder', icon: <FolderPlus size={15} />, onClick: () => d({ kind: 'newFolder', parentId: folderId }) },
    { label: 'New text file', icon: <FilePlus2 size={15} />, onClick: () => d({ kind: 'newText', folderId }) },
    ...(clipboardCount > 0 && onPaste ? [
      { label: `Paste ${clipboardCount} item(s) (Ctrl+V)`, icon: <Clipboard size={15} />, onClick: onPaste },
    ] : []),
    null,
    { label: 'Upload files', icon: <Upload size={15} />, onClick: () => pickFiles(folderId) },
    { label: 'Upload folder', icon: <Upload size={15} />, onClick: () => pickFolder(folderId) },
    null,
    { label: 'Refresh', icon: <RefreshCw size={15} />, onClick: onRefresh },
  ];
}

export function pickFiles(folderId: string | null, existingFiles?: FileDTO[]) {
  // Desktop: the OS picker returns real paths; the Rust server reads them
  // from disk. Browser builds keep the File-input flow.
  if (isDesktopNativeUploads()) {
    void pickNativeFiles(folderId);
    return;
  }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  inp.onchange = async () => {
    const list = Array.from(inp.files ?? []);
    if (!list.length) return;
    let destFiles = existingFiles;
    if (!destFiles) {
      try {
        const driveRes = await api.get<{ files: FileDTO[] }>(folderId ? `/api/drive?folderId=${encodeURIComponent(folderId)}` : '/api/drive');
        destFiles = driveRes.files;
      } catch {
        destFiles = [];
      }
    }
    void startUploadsWithConflictCheck(list, { folderId, existingFiles: destFiles });
  };
  inp.click();
}
export function pickFolder(folderId: string | null) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.setAttribute('webkitdirectory', '');
  inp.onchange = () => {
    for (const f of Array.from(inp.files ?? [])) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || undefined;
      startUpload(f, { folderId, relativePath: rel });
    }
  };
  inp.click();
}

interface Props {
  folders: FolderDTO[];
  files: FileDTO[];
  folderId?: string | null;
  currentFolder?: FolderDTO | null;
  loading?: boolean;
  onRefresh: () => void;
}

export function Explorer({ folders, files, folderId = null, currentFolder = null, loading, onRefresh }: Props) {
  const { viewMode, setViewMode, cardSize, sortBy, sortDir, detailsOpen, nameDisplay, desktopMode, uploadConflict } = useUi();
  const [filterCat, setFilterCat] = useState<string>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | null)[] } | null>(null);
  const [detailItem, setDetailItem] = useState<string | null>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [dragOver, setDragOver] = useState(false);
  const { items: clipItems, mode: clipMode, setClipboard, clearClipboard } = useClipboard();

  const handlePaste = useCallback(async () => {
    if (!clipItems.length || !clipMode) return;
    const fileIds = clipItems.filter((i) => i.kind === 'file').map((i) => i.id);
    const folderIds = clipItems.filter((i) => i.kind === 'folder').map((i) => i.id);

    try {
      if (clipMode === 'cut') {
        await api.post('/api/items/move', { fileIds, folderIds, targetFolderId: folderId });
        toast.success(`Moved ${clipItems.length} item(s)`);
        clearClipboard();
      } else {
        await api.post('/api/items/move', { fileIds, folderIds, targetFolderId: folderId, copy: true });
        toast.success(`Copied ${clipItems.length} item(s)`);
      }
      onRefresh();
      void qc.invalidateQueries({ queryKey: ['drive'] });
    } catch (e) {
      toast.error((e as Error).message || 'Failed to paste items');
    }
  }, [clipItems, clipMode, clearClipboard, folderId, onRefresh, qc]);

  const sortedFolders = useMemo(() => sortItems(folders.map((f) => ({ ...f })), sortBy === 'type' ? 'name' : sortBy, sortDir), [folders, sortBy, sortDir]);
  const sortedFiles = useMemo(() => sortItems(files, sortBy, sortDir), [files, sortBy, sortDir]);

  const displayFolders = useMemo(() => {
    if (filterCat === 'all' || filterCat === 'folders') return sortedFolders;
    return [];
  }, [sortedFolders, filterCat]);

  const displayFiles = useMemo(() => {
    if (filterCat === 'all') return sortedFiles;
    if (filterCat === 'folders') return [];
    return sortedFiles.filter((f) => f.category === filterCat);
  }, [sortedFiles, filterCat]);

  const items: Item[] = useMemo(() => [
    ...displayFolders.map((f) => ({ kind: 'folder' as const, data: f })),
    ...displayFiles.map((f) => ({ kind: 'file' as const, data: f })),
  ], [displayFolders, displayFiles]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: folders.length + files.length,
      folders: folders.length,
      document: 0,
      image: 0,
      video: 0,
      audio: 0,
      archive: 0,
    };
    for (const f of files) {
      if (counts[f.category] !== undefined) {
        counts[f.category] = (counts[f.category] ?? 0) + 1;
      }
    }
    return counts;
  }, [folders, files]);

  const totalSizeOfFiles = useMemo(() => displayFiles.reduce((acc, f) => acc + (f.size || 0), 0), [displayFiles]);

  useEffect(() => { setSel(new Set()); setAnchor(null); setDetailItem(null); }, [folderId]);

  // After a refresh/delete/move, drop selections and details that point at
  // items which no longer exist so bulk actions never target ghosts.
  useEffect(() => {
    const ids = new Set<string>([...folders.map((f) => f.id), ...files.map((f) => f.id)]);
    setSel((prev) => {
      const next = new Set<string>();
      for (const id of prev) if (ids.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
    setAnchor((a) => (a && !ids.has(a) ? null : a));
    setDetailItem((d) => (d && !ids.has(d) ? null : d));
  }, [folders, files]);

  const refresh = useCallback(() => { onRefresh(); void qc.invalidateQueries({ queryKey: ['stats'] }); }, [onRefresh, qc]);

  const openItem = (it: Item) => {
    if (it.kind === 'folder') nav(`/drive/${it.data.id}`);
    else {
      const idx = sortedFiles.findIndex((f) => f.id === it.data.id);
      usePreview.getState().start(sortedFiles, Math.max(0, idx));
    }
  };

  const selItems = items.filter((i) => sel.has(itemId(i)));
  const selFiles = selItems.filter((i) => i.kind === 'file').map((i) => i.data.id);
  const selFolders = selItems.filter((i) => i.kind === 'folder').map((i) => i.data.id);
  const selectedBytes = useMemo(() => selItems.reduce((acc, it) => acc + (it.kind === 'file' ? (it.data.size || 0) : 0), 0), [selItems]);

  const bulk = (action: string) => {
    if (action === 'trash') return api.post('/api/items/trash', { fileIds: selFiles, folderIds: selFolders }).then(() => { setSel(new Set()); refresh(); });
    if (action === 'delete') return api.post('/api/items/delete', { fileIds: selFiles, folderIds: selFolders }).then(() => { setSel(new Set()); refresh(); });
    if (action === 'star') return api.post('/api/items/star', { fileIds: selFiles, folderIds: selFolders, starred: true }).then(refresh);
    if (action === 'download') {
      if (selFolders.length === 0 && selFiles.length > 0) {
        for (const fid of selFiles) {
          const f = files.find((x) => x.id === fid);
          if (f) void startDownload(f);
        }
      } else {
        void downloadZip(selFiles, selFolders);
      }
    }
    return Promise.resolve();
  };

  const selectItem = (it: Item, e: React.MouseEvent | { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
    const id = itemId(it);
    if (e.shiftKey && anchor) {
      const a = items.findIndex((i) => itemId(i) === anchor);
      const b = items.findIndex((i) => itemId(i) === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSel(new Set(items.slice(lo, hi + 1).map(itemId)));
    } else if (e.ctrlKey || e.metaKey) {
      const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); setAnchor(id);
    } else {
      setSel(new Set([id])); setAnchor(id);
    }
  };
  const toggleCheck = (it: Item) => {
    const id = itemId(it);
    const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); setAnchor(id);
  };

  const ctxMenu = (e: React.MouseEvent, it?: Item) => {
    e.preventDefault(); e.stopPropagation();
    if (it && !sel.has(itemId(it))) setSel(new Set([itemId(it)]));
    if (!it) return setMenu({ x: e.clientX, y: e.clientY, items: emptySpaceMenu(folderId, refresh, handlePaste, clipItems.length) });
    const id = itemId(it);
    if (sel.has(id) && sel.size > 1) {
      setMenu({ x: e.clientX, y: e.clientY, items: [
        { label: `Download (${sel.size})`, icon: <Download size={15} />, onClick: () => void bulk('download') },
        {
          label: `Cut ${sel.size} items (Ctrl+X)`,
          icon: <Scissors size={15} />,
          onClick: () => {
            setClipboard(selItems.map((i) => ({ id: itemId(i), kind: i.kind, name: itemName(i) })), 'cut');
            toast.info(`Cut ${sel.size} items to clipboard`);
          },
        },
        {
          label: `Copy ${sel.size} items (Ctrl+C)`,
          icon: <Copy size={15} />,
          onClick: () => {
            setClipboard(selItems.map((i) => ({ id: itemId(i), kind: i.kind, name: itemName(i) })), 'copy');
            toast.success(`Copied ${sel.size} items to clipboard`);
          },
        },
        { label: `Move ${sel.size} items`, icon: <FolderInput size={15} />, onClick: () => useDialog.getState().open({ kind: 'move', fileIds: selFiles, folderIds: selFolders, copy: false }) },
        { label: 'Star', icon: <Star size={15} />, onClick: () => void bulk('star') },
        null,
        { label: `Trash ${sel.size} items`, icon: <Trash2 size={15} />, danger: true, onClick: () => void bulk('trash') },
      ]});
    } else {
      setMenu({
        x: e.clientX, y: e.clientY,
        items: [
          ...itemMenu({
            file: it.kind === 'file' ? it.data : undefined,
            folder: it.kind === 'folder' ? it.data : undefined,
            onOpen: () => openItem(it), onRefresh: refresh,
            onDetails: () => { setDetailItem(id); useUi.getState().setDetailsOpen(true); },
          }),
          {
            label: 'Cut (Ctrl+X)',
            icon: <Scissors size={15} />,
            onClick: () => {
              setClipboard([{ id, kind: it.kind, name: itemName(it) }], 'cut');
              toast.info(`Cut ${itemName(it)} to clipboard`);
            },
          },
          {
            label: 'Copy (Ctrl+C)',
            icon: <Copy size={15} />,
            onClick: () => {
              setClipboard([{ id, kind: it.kind, name: itemName(it) }], 'copy');
              toast.success(`Copied ${itemName(it)} to clipboard`);
            },
          },
        ],
      });
    }
  };

  const keyState = useRef({
    items,
    sel,
    selItems,
    clipItems,
    clipMode,
    folderId,
    sortedFiles,
    anchor,
    onRefresh,
    bulk,
    handlePaste,
    openItem,
  });
  keyState.current = {
    items,
    sel,
    selItems,
    clipItems,
    clipMode,
    folderId,
    sortedFiles,
    anchor,
    onRefresh,
    bulk,
    handlePaste,
    openItem,
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || usePreview.getState().open) return;
      const {
        items, sel, selItems, clipItems, folderId, sortedFiles, anchor,
        onRefresh, bulk, handlePaste, openItem,
      } = keyState.current;

      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        onRefresh();
        toast.info('Refreshed drive');
      }
      if (e.key === 'Escape') setSel(new Set());
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); setSel(new Set(items.map(itemId))); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && sel.size > 0) {
        e.preventDefault();
        setClipboard(selItems.map((i) => ({ id: itemId(i), kind: i.kind, name: itemName(i) })), 'copy');
        toast.success(`Copied ${sel.size} item(s) to clipboard`);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && sel.size > 0) {
        e.preventDefault();
        setClipboard(selItems.map((i) => ({ id: itemId(i), kind: i.kind, name: itemName(i) })), 'cut');
        toast.info(`Cut ${sel.size} item(s) to clipboard`);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clipItems.length > 0) {
        e.preventDefault();
        void handlePaste();
      }
      if ((e.key === 'Backspace' && sel.size === 0) || (e.altKey && e.key === 'ArrowUp')) {
        if (folderId) {
          e.preventDefault();
          nav('/drive');
        }
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && items.length > 0) {
        e.preventDefault();
        let nextIdx = 0;
        if (sel.size > 0 && anchor) {
          const curIdx = items.findIndex((i) => itemId(i) === anchor);
          if (curIdx >= 0) {
            const step = (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 1;
            nextIdx = Math.max(0, Math.min(items.length - 1, curIdx + step));
          }
        }
        const nextItem = items[nextIdx];
        if (nextItem) {
          setSel(new Set([itemId(nextItem)]));
          setAnchor(itemId(nextItem));
        }
      }
      if (e.key === 'Delete' && sel.size) {
        useDialog.getState().open({
          kind: 'confirm',
          title: `Delete ${sel.size} item${sel.size > 1 ? 's' : ''}?`,
          body: `Permanently delete ${sel.size} item${sel.size > 1 ? 's' : ''} and remove all parts from your Telegram channel? This cannot be undone.`,
          danger: true,
          onOk: () => void bulk('delete'),
        });
      }
      if (e.key === 'F2' && sel.size === 1 && selItems[0]) {
        const it = selItems[0];
        useDialog.getState().open({ kind: 'rename', item: { id: itemId(it), name: itemName(it), isFolder: it.kind === 'folder' } });
      }
      if (e.key === 'Enter' && sel.size === 1 && selItems[0]) openItem(selItems[0]);
      if (e.key === ' ' && sel.size === 1 && selItems[0]?.kind === 'file') {
        e.preventDefault();
        usePreview.getState().start(sortedFiles, sortedFiles.findIndex((f) => f.id === itemId(selItems[0]!)));
      }
      if (e.key === 'i') useUi.getState().setDetailsOpen(!useUi.getState().detailsOpen);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && sel.size > 0) {
        e.preventDefault();
        void bulk('download');
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [nav, setClipboard]);

  // OS file drop anywhere in the drive view
  useEffect(() => {
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const dt = e.dataTransfer!;
      if (dt.files.length === 0) return;
      // Collect first, then upload: directory drops must not bypass the
      // conflict dialog for files that land directly in this folder.
      const dropped: { file: File; relativePath?: string }[] = [];
      const reads: Promise<void>[] = [];
      const readEntry = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
        if (entry.isFile) {
          const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
          dropped.push({ file, relativePath: prefix ? `${prefix}/${file.name}` : undefined });
        } else if (entry.isDirectory) {
          const reader = (entry as FileSystemDirectoryEntry).createReader();
          const readAll = async () => {
            const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
            for (const c of batch) await readEntry(c, prefix ? `${prefix}/${entry.name}` : entry.name);
            if (batch.length) await readAll();
          };
          await readAll();
        }
      };
      for (const item of Array.from(dt.items)) {
        const entry = item.webkitGetAsEntry?.();
        if (entry) reads.push(readEntry(entry, ''));
      }
      if (reads.length === 0) {
        const dropFiles = Array.from(dt.files);
        if (dropFiles.length) await startUploadsWithConflictCheck(dropFiles, { folderId, existingFiles: files });
        return;
      }
      await Promise.all(reads);
      const topLevel = dropped.filter((d) => !d.relativePath).map((d) => d.file);
      if (topLevel.length) await startUploadsWithConflictCheck(topLevel, { folderId, existingFiles: files });
      for (const d of dropped) {
        if (!d.relativePath) continue;
        startUpload(d.file, { folderId, relativePath: d.relativePath, onConflict: uploadConflict });
      }
    };
    const onDrag = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer?.types.includes('Files')) setDragOver(true); };
    const onLeave = (e: DragEvent) => { if (e.relatedTarget === null) setDragOver(false); };
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDrag);
    window.addEventListener('dragleave', onLeave);
    return () => { window.removeEventListener('drop', onDrop); window.removeEventListener('dragover', onDrag); window.removeEventListener('dragleave', onLeave); };
  }, [folderId, files, uploadConflict]);

  const moveTo = (targetFolderId: string | null) => {
    if (!sel.size) return;
    void api.post('/api/items/move', { fileIds: selFiles, folderIds: selFolders, targetFolderId }).then(refresh).then(() => setSel(new Set()));
  };
  const onItemDrag = (e: React.DragEvent, it: Item) => {
    if (!sel.has(itemId(it))) setSel(new Set([itemId(it)]));
    e.dataTransfer.setData('application/x-teledrive-items', '1');
    e.dataTransfer.effectAllowed = 'move';
  };

  const spec = CARD_SPECS[cardSize] || CARD_SPECS.standard;

  const renderFolderCard = (f: FolderDTO) => {
    const it: Item = { kind: 'folder', data: f };
    const isCut = clipMode === 'cut' && clipItems.some((ci) => ci.id === f.id);
    return (
      <div key={f.id} draggable
        onDragStart={(e) => onItemDrag(e, it)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); moveTo(f.id); }}
        onClick={(e) => selectItem(it, e)}
        onDoubleClick={() => openItem(it)}
        onContextMenu={(e) => ctxMenu(e, it)}
        className={clsx(
          'gdrive-folder-card select-none flex items-center shrink-0 min-w-0 rounded-xl border border-app transition-colors',
          spec.folderPadding,
          sel.has(f.id) ? 'selected' : 'surface-2 hover:bg-surface-3',
          isCut && 'opacity-40 border-dashed border-accent/60'
        )}
        data-item-id={f.id} title={f.name}>
        <FolderIcon
          size={spec.folderIconSize}
          className="shrink-0"
          style={{ color: f.color || '#f59e0b', fill: f.color ? f.color + '40' : '#f59e0b40' }}
        />
        <span className={clsx('font-medium flex-1 leading-snug', nameDisplay === 'full' ? 'break-words' : nameDisplay === 'multiline' ? 'line-clamp-2 break-all' : 'truncate', spec.folderFontSize)}>{f.name}</span>
        <StarBadge show={f.starred} />
        <button className="icon-btn !w-6 !h-6 -mr-1" onClick={(e) => { e.stopPropagation(); ctxMenu(e as unknown as React.MouseEvent, it); }} aria-label="More">⋯</button>
      </div>
    );
  };

  const renderFileCard = (f: FileDTO) => {
    const it: Item = { kind: 'file', data: f };
    const isSel = sel.has(f.id);
    const isCut = clipMode === 'cut' && clipItems.some((ci) => ci.id === f.id);
    return (
      <div key={f.id} draggable
        onDragStart={(e) => onItemDrag(e, it)}
        onClick={(e) => selectItem(it, e)}
        onDoubleClick={() => openItem(it)}
        onContextMenu={(e) => ctxMenu(e, it)}
        className={clsx('gdrive-file-card group relative', isSel && 'selected', isCut && 'opacity-40 border-dashed border-accent/60')}
        data-item-id={f.id}>
        <button
          className="icon-btn !w-7 !h-7 absolute top-2 right-2 opacity-0 group-hover:opacity-100 bg-surface/90 border border-app shadow-xs z-10 hover:text-accent transition-opacity"
          title="Download"
          onClick={(e) => { e.stopPropagation(); openContent(f, true); }}
        >
          <Download size={13} />
        </button>
        <div className="card-check" onClick={(e) => { e.stopPropagation(); toggleCheck(it); }}>
          <input type="checkbox" className="cbx" checked={isSel} readOnly aria-label={`Select ${f.name}`} />
        </div>
        <div className={clsx('preview-area relative flex items-center justify-center overflow-hidden bg-surface-2', spec.previewHeight || 'h-36')}>
          <Thumb file={f} className="w-full h-full" big />
          {f.category === 'video' && !f.hasThumbnail && <VideoThumbRequest id={f.id} />}
          {f.category === 'video' && (
            <span className="badge absolute bottom-2 left-2"><Play size={10} className="fill-white" />{f.duration != null ? fmtDur(f.duration) : ''}</span>
          )}
          {f.status === 'processing' && <span className="badge storing absolute bottom-2 left-2"><Loader2 size={10} className="animate-spin" />Storing…</span>}
          {f.status === 'uploading' && <span className="badge storing absolute bottom-2 left-2"><Loader2 size={10} className="animate-spin" />Uploading…</span>}
        </div>
        <div className="px-3.5 py-2.5 flex items-center gap-2.5 bg-surface border-t border-app">
          <FileTypeIcon category={f.category} ext={f.extension} size={18} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className={clsx('file-name text-[13px] font-medium text-text', nameDisplay === 'full' ? 'break-words leading-snug' : nameDisplay === 'multiline' ? 'line-clamp-2 break-all leading-snug' : 'truncate')} title={f.name}>{f.name}</div>
            <div className="text-3 text-[11px] truncate mt-0.5">{fmtBytes(f.size)} · {relDate(f.updatedAt)}</div>
          </div>
          {f.starred ? <StarBadge show={f.starred} /> : null}
          <button className="icon-btn !w-6 !h-6 -mr-1 opacity-70 hover:opacity-100 shrink-0" onClick={(e) => { e.stopPropagation(); ctxMenu(e as unknown as React.MouseEvent, it); }} aria-label="More actions">⋯</button>
        </div>
      </div>
    );
  };

  // Column count follows the scroll container's width — ResizeObserver keeps
  // it exact as the window resizes or the details panel toggles.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollW, setScrollW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScrollW(el.clientWidth));
    ro.observe(el);
    setScrollW(el.clientWidth);
    return () => ro.disconnect();
  }, [viewMode, loading]);
  const gridCols = Math.max(1, Math.floor(Math.max(0, scrollW - 48) / ((CARD_SPECS[cardSize]?.minWidth || 220) + 16)));

  // Virtual rows: section headings count as rows; card grids are chunked by
  // the live column count so only rendered rows exist in the DOM. Selection
  // logic always indexes the full `items` array — never the rendered subset.
  type VRow = { kind: 'heading'; label: string } | { kind: 'cards'; items: Item[]; folder: boolean };
  const vRows = useMemo<VRow[]>(() => {
    const rows: VRow[] = [];
    const chunk = (a: Item[], f: boolean) => {
      for (let i = 0; i < a.length; i += gridCols) rows.push({ kind: 'cards', items: a.slice(i, i + gridCols), folder: f });
    };
    const folderItems = displayFolders.map((f): Item => ({ kind: 'folder', data: f }));
    const fileItems = displayFiles.map((f): Item => ({ kind: 'file', data: f }));
    if (folderItems.length) {
      rows.push({ kind: 'heading', label: 'Folders' });
      chunk(folderItems, true);
    }
    if (fileItems.length) {
      if (folderItems.length) rows.push({ kind: 'heading', label: 'Files' });
      chunk(fileItems, false);
    }
    return rows;
  }, [displayFolders, displayFiles, gridCols]);

  const gridVirt = useVirtualizer({
    count: vRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const r = vRows[i];
      return r?.kind === 'heading' ? 34 : r?.kind === 'cards' && r.folder ? 50 : 216;
    },
    overscan: 8,
  });

  if (loading) {
    return <div className="p-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))' }}>
      {Array.from({ length: 12 }).map((_, i) => <div key={i} className="preview-area skel rounded-xl" />)}
    </div>;
  }

  const detailTarget: FileDTO | FolderDTO | null =
    (detailItem ? (files.find((f) => f.id === detailItem) ?? folders.find((f) => f.id === detailItem)) : undefined)
    ?? (selItems.length === 1 ? selItems[0]!.data : null)
    ?? currentFolder;

  return (
    <div className="h-full flex min-w-0 relative">
      <div className="flex-1 flex flex-col min-w-0" onContextMenu={(e) => ctxMenu(e)}>
        {/* Symmetrical Floating Selection Command Dock */}
        {sel.size > 0 && (
          <div
            className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 w-max max-w-[calc(100vw-2rem)] flex items-center gap-2 px-3 py-1.5 rounded-2xl bg-surface-2/95 backdrop-blur-xl border border-app shadow-2xl text-xs font-medium text-text select-none overflow-x-auto scrollbar-none transition-all duration-100"
            role="toolbar"
            aria-label="Selection actions"
          >
            {/* Left count indicator & select/deselect toggle */}
            <button
              className="h-8 flex items-center gap-1.5 px-3 rounded-xl bg-surface hover:bg-surface-3 border border-app shrink-0 font-medium text-text whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs"
              onClick={() => {
                if (sel.size === items.length) setSel(new Set());
                else setSel(new Set(items.map(itemId)));
              }}
              title={sel.size === items.length ? 'Deselect all (Esc)' : 'Select all (Ctrl+A)'}
            >
              <CheckSquare size={13} className="text-accent shrink-0" />
              <span className="tabular-nums font-semibold shrink-0">{sel.size} selected</span>
              {selectedBytes > 0 && <span className="text-3 text-[11px] font-normal shrink-0">({fmtBytes(selectedBytes)})</span>}
            </button>

            <div className="w-[1px] h-4 bg-app-border shrink-0 opacity-60 mx-0.5" />

            {/* Center primary actions */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                className="h-8 px-2.5 rounded-xl text-xs font-medium border border-app/60 bg-surface hover:bg-surface-3 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs shrink-0"
                onClick={() => void bulk('download')}
                title="Download (Ctrl+D)"
              >
                <Download size={13} className="shrink-0" />
                <span className="hidden sm:inline">Download</span>
              </button>

              <button
                className="h-8 px-2.5 rounded-xl text-xs font-medium border border-app/60 bg-surface hover:bg-surface-3 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs shrink-0"
                onClick={() => {
                  setClipboard(selItems.map((i) => ({ id: itemId(i), kind: i.kind, name: itemName(i) })), 'cut');
                  toast.info(`Cut ${sel.size} item(s)`);
                }}
                title="Cut to clipboard (Ctrl+X)"
              >
                <Scissors size={13} className="shrink-0" />
                <span className="hidden sm:inline">Cut</span>
              </button>

              <button
                className="h-8 px-2.5 rounded-xl text-xs font-medium border border-app/60 bg-surface hover:bg-surface-3 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs shrink-0"
                onClick={() => {
                  setClipboard(selItems.map((i) => ({ id: itemId(i), kind: i.kind, name: itemName(i) })), 'copy');
                  toast.success(`Copied ${sel.size} item(s)`);
                }}
                title="Copy to clipboard (Ctrl+C)"
              >
                <Copy size={13} className="shrink-0" />
                <span className="hidden sm:inline">Copy</span>
              </button>

              {clipItems.length > 0 && (
                <button
                  className="h-8 px-2.5 rounded-xl text-xs font-semibold border border-accent/40 bg-accent text-white inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs shrink-0"
                  onClick={() => void handlePaste()}
                  title={`Paste ${clipItems.length} item(s) (Ctrl+V)`}
                >
                  <Clipboard size={13} className="shrink-0" />
                  <span>Paste ({clipItems.length})</span>
                </button>
              )}

              <button
                className="h-8 px-2.5 rounded-xl text-xs font-medium border border-app/60 bg-surface hover:bg-surface-3 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs shrink-0"
                onClick={() => useDialog.getState().open({ kind: 'move', fileIds: selFiles, folderIds: selFolders, copy: false })}
                title="Move"
              >
                <FolderInput size={13} className="shrink-0" />
                <span className="hidden md:inline">Move</span>
              </button>

              <button
                className="h-8 px-2.5 rounded-xl text-xs font-medium border border-app/60 bg-surface hover:bg-surface-3 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs shrink-0"
                onClick={() => void bulk('star')}
                title="Star"
              >
                <Star size={13} className="shrink-0" />
                <span className="hidden md:inline">Star</span>
              </button>

              {!desktopMode && sel.size === 1 && selItems[0]?.kind === 'file' && (
                <button
                  className="h-8 px-2.5 rounded-xl text-xs font-medium border border-app/60 bg-surface hover:bg-surface-3 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs shrink-0"
                  onClick={() => useDialog.getState().open({ kind: 'share', fileId: selFiles[0], name: itemName(selItems[0]!) })}
                  title="Share"
                >
                  <Share2 size={13} className="shrink-0" />
                  <span className="hidden lg:inline">Share</span>
                </button>
              )}
            </div>

            <div className="w-[1px] h-4 bg-app-border shrink-0 opacity-60 mx-0.5" />

            {/* Right destructive and dismiss actions */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                className="h-8 px-3 rounded-xl text-xs font-medium border border-red-500/25 bg-red-500/10 hover:bg-red-500/20 text-red-400 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer active:scale-[0.98] transition-all shadow-2xs shrink-0"
                onClick={() => {
                  useDialog.getState().open({
                    kind: 'confirm',
                    title: `Delete ${sel.size} item${sel.size > 1 ? 's' : ''}?`,
                    body: `Permanently delete ${sel.size} item${sel.size > 1 ? 's' : ''} and remove all parts from your Telegram channel? This cannot be undone.`,
                    danger: true,
                    onOk: () => void bulk('delete'),
                  });
                }}
                title="Permanently delete from channel and drive (Del)"
              >
                <Trash2 size={13} className="shrink-0 text-red-400" />
                <span className="hidden sm:inline whitespace-nowrap">Delete</span>
              </button>

              <button
                className="h-8 w-8 rounded-xl border border-app/60 bg-surface hover:bg-surface-3 text-3 hover:text-text flex items-center justify-center shrink-0 cursor-pointer active:scale-[0.98] transition-all shadow-2xs"
                onClick={() => setSel(new Set())}
                title="Deselect all (Esc)"
                aria-label="Clear selection"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Staged Clipboard Action Banner (when nothing selected but clipboard has items) */}
        {sel.size === 0 && clipItems.length > 0 && (
          <div
            className="fixed bottom-13 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2 rounded-2xl bg-surface-2/95 backdrop-blur-xl border border-accent/40 shadow-2xl text-xs font-medium text-text select-none animate-in fade-in"
            role="toolbar"
          >
            <div className="flex items-center gap-2 text-accent font-semibold">
              <Clipboard size={14} />
              <span>{clipItems.length} item{clipItems.length > 1 ? 's' : ''} staged for {clipMode}</span>
            </div>
            <button
              className="btn btn-primary !py-1 !px-2.5 !text-xs shadow-2xs cursor-pointer"
              onClick={() => void handlePaste()}
            >
              Paste here (Ctrl+V)
            </button>
            <button
              className="icon-btn !w-6 !h-6 text-3 hover:text-text cursor-pointer"
              onClick={clearClipboard}
              title="Clear clipboard"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div
          className="flex-1 overflow-auto min-w-0 pb-20"
          onContextMenu={(e) => ctxMenu(e)}
          onClick={(e) => {
            if (e.target === e.currentTarget) setSel(new Set());
          }}
        >
          {/* Quick Filter Chips with Live Category Counts */}
          <div className="px-6 pt-3 pb-1 flex items-center gap-2 overflow-x-auto no-scrollbar select-none">
            {[
              { id: 'all', label: 'All' },
              { id: 'folders', label: 'Folders' },
              { id: 'document', label: 'Documents' },
              { id: 'image', label: 'Images' },
              { id: 'video', label: 'Videos' },
              { id: 'audio', label: 'Audio' },
              { id: 'archive', label: 'Archives' },
            ]
              .filter((chip) => chip.id === 'all' || (categoryCounts[chip.id] ?? 0) > 0)
              .map((chip) => {
                const count = categoryCounts[chip.id] ?? 0;
                const active = filterCat === chip.id;
                return (
                  <button
                    key={chip.id}
                    onClick={() => setFilterCat(chip.id)}
                    className={clsx(
                      'px-3 py-1 text-xs rounded-full font-medium transition-colors cursor-pointer shrink-0 flex items-center gap-1.5',
                      active
                        ? 'bg-accent/15 text-accent font-semibold border border-accent/35 shadow-2xs'
                        : 'bg-surface-2 text-2 hover:bg-surface-3 hover:text-text border border-app'
                    )}
                  >
                    <span>{chip.label}</span>
                    <span
                      className={clsx(
                        'text-[10.5px] px-1.5 py-0.2 rounded-full tabular-nums font-semibold',
                        active ? 'bg-accent/20 text-accent' : 'bg-surface text-3'
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
          </div>

          {items.length === 0 ? (
          <EmptyState icon={FolderIcon} title={filterCat === 'all' ? 'This folder is empty' : `No ${filterCat} found`}
            body="Drag and drop files here, or use the New button to upload." />
        ) : viewMode === 'grid' ? (
          <div
            ref={scrollRef}
            className="flex-1 overflow-auto p-6"
            onClick={(e) => { if (e.target === e.currentTarget) setSel(new Set()); }}
          >
            <div style={{ height: gridVirt.getTotalSize(), position: 'relative' }}>
              {gridVirt.getVirtualItems().map((vr) => {
                const row = vRows[vr.index]!;
                return (
                  <div
                    key={vr.key}
                    data-index={vr.index}
                    ref={gridVirt.measureElement}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vr.start}px)` }}
                  >
                    {row.kind === 'heading' ? (
                      <h3 className="text-3 text-xs font-semibold uppercase tracking-wider mb-2.5 mt-2">{row.label}</h3>
                    ) : (
                      <div
                        className="grid pb-4"
                        style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gap: row.folder ? 12 : 16 }}
                      >
                        {row.items.map((it) => it.kind === 'folder' ? renderFolderCard(it.data as FolderDTO) : renderFileCard(it.data as FileDTO))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <ListView items={items} sel={sel} onSelect={selectItem} onOpen={openItem} onCtx={ctxMenu} onItemDrag={onItemDrag} moveTo={moveTo} clipItems={clipItems} clipMode={clipMode} />
        )}

        {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
        {dragOver && (
          <div className="fixed inset-0 z-[60] pointer-events-none flex items-center justify-center">
            <div className="absolute inset-4 rounded-2xl border-2 border-dashed" style={{ borderColor: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }} />
            <div className="surface shadow-overlay rounded-xl px-6 py-4 font-medium accent-bg accent">Drop files to upload</div>
          </div>
        )}
        </div>

        {/* ── Native Explorer Status Bar Footer ── */}
        <div className="h-9 px-6 border-t border-app bg-surface flex items-center justify-between text-xs text-3 select-none shrink-0 z-10">
          <div className="flex items-center gap-3">
            {sel.size === 0 ? (
              <span className="tabular-nums">
                {items.length} {items.length === 1 ? 'item' : 'items'}
                {displayFolders.length > 0 && ` (${displayFolders.length} folders, ${displayFiles.length} files)`}
                {totalSizeOfFiles > 0 && ` · ${fmtBytes(totalSizeOfFiles)} total`}
              </span>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-semibold text-accent tabular-nums">
                  {sel.size} of {items.length} selected
                  {selectedBytes > 0 && ` (${fmtBytes(selectedBytes)})`}
                </span>
                <button
                  className="text-xs text-3 hover:text-text hover:underline ml-1 cursor-pointer"
                  onClick={() => setSel(new Set())}
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 text-[11.5px]">
            <span className="hidden sm:inline text-3">
              <kbd className="px-1.5 py-0.5 rounded bg-surface-2 border border-app text-[10px] mr-1">Space</kbd>Preview
              <span className="mx-2 text-app">•</span>
              <kbd className="px-1.5 py-0.5 rounded bg-surface-2 border border-app text-[10px] mr-1">Enter</kbd>Open
              <span className="mx-2 text-app">•</span>
              <kbd className="px-1.5 py-0.5 rounded bg-surface-2 border border-app text-[10px] mr-1">F2</kbd>Rename
            </span>
            <div className="flex items-center gap-1 border-l border-app pl-3">
              <button
                className={clsx('p-1 rounded hover:bg-surface-2 transition-colors cursor-pointer', viewMode === 'grid' && 'text-accent font-bold')}
                onClick={() => setViewMode('grid')}
                title="Grid view"
              >
                <LayoutGrid size={14} />
              </button>
              <button
                className={clsx('p-1 rounded hover:bg-surface-2 transition-colors cursor-pointer', viewMode === 'list' && 'text-accent font-bold')}
                onClick={() => setViewMode('list')}
                title="List view"
              >
                <List size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>
      {detailsOpen && detailTarget && (
        <>
          <div className="hidden md:block h-full overflow-y-auto"><DetailsPanel item={detailTarget} /></div>
          <div className="md:hidden bottom-sheet fadein"><DetailsPanel item={detailTarget} sheet /></div>
        </>
      )}
    </div>
  );
}

function fmtDur(s: number | null) {
  if (s == null) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function ListView({ items, sel, onSelect, onOpen, onCtx, onItemDrag, moveTo, clipItems = [], clipMode = null }: {
  items: Item[]; sel: Set<string>; onSelect: (i: Item, e: React.MouseEvent) => void;
  onOpen: (i: Item) => void; onCtx: (e: React.MouseEvent, i: Item) => void;
  onItemDrag: (e: React.DragEvent, i: Item) => void; moveTo: (id: string) => void;
  clipItems?: { id: string; kind: 'file' | 'folder' }[];
  clipMode?: 'cut' | 'copy' | null;
}) {
  const { sortBy, sortDir, setSort, nameDisplay } = useUi();
  const listRef = useRef<HTMLDivElement>(null);
  const listVirt = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });
  const hdr = (key: 'name' | 'updatedAt' | 'size' | 'type', label: string) => (
    <button className="flex items-center gap-1 text-left hover:text-[var(--text)]" onClick={() => setSort(key, sortBy === key && sortDir === 'asc' ? 'desc' : 'asc')}>
      {label}{sortBy === key && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="grid grid-cols-[1fr_150px_110px_130px_40px] gap-3 px-6 py-2.5 border-b border-app text-3 text-xs font-semibold uppercase tracking-wider sticky top-0 bg-surface z-10">
        {hdr('name', 'Name')}{hdr('updatedAt', 'Last modified')}{hdr('size', 'File size')}{hdr('type', 'Type')}<span />
      </div>
      <div ref={listRef} className="flex-1 overflow-auto px-2 py-1">
        <div style={{ height: listVirt.getTotalSize(), position: 'relative' }}>
        {listVirt.getVirtualItems().map((vr) => {
          const it = items[vr.index];
          if (!it) return null;
          const id = itemId(it);
          const isFolder = it.kind === 'folder';
          const isCut = clipMode === 'cut' && clipItems.some((ci) => ci.id === id);
          return (
            <div
              key={id}
              data-index={vr.index}
              ref={listVirt.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vr.start}px)` }}
              draggable
              onDragStart={(e) => onItemDrag(e, it)}
              onDragOver={(e) => { if (isFolder) e.preventDefault(); }}
              onDrop={(e) => { if (isFolder) { e.preventDefault(); moveTo(id); } }}
              onClick={(e) => onSelect(it, e)}
              onDoubleClick={() => onOpen(it)}
              onContextMenu={(e) => onCtx(e, it)}
              className={clsx(
                'grid grid-cols-[1fr_150px_110px_130px_40px] gap-3 px-4 py-2 items-center cursor-pointer select-none rounded-lg transition-colors text-[13.5px] hover:bg-surface-2',
                sel.has(id) && 'accent-bg accent font-medium',
                isCut && 'opacity-40 border-dashed border-accent/60'
              )}
              data-item-id={id}
            >
              <span className="flex items-center gap-3 min-w-0">
                {isFolder
                  ? <FolderIcon size={20} className="shrink-0" style={{ color: (it.data as FolderDTO).color || '#f59e0b', fill: (it.data as FolderDTO).color ? (it.data as FolderDTO).color + '40' : '#f59e0b40' }} />
                  : <Thumb file={it.data as FileDTO} className="w-6 h-6 rounded shrink-0" />}
                <span className={clsx('file-name font-medium', nameDisplay === 'full' ? 'break-words' : nameDisplay === 'multiline' ? 'line-clamp-2 break-all' : 'truncate')} title={itemName(it)}>{itemName(it)}</span>
                <StarBadge show={!!it.data.starred} />
              </span>
              <span className="text-2 text-xs">{relDate(it.data.updatedAt)}</span>
              <span className="text-2 text-xs">{isFolder ? '—' : fmtBytes((it.data as FileDTO).size)}</span>
              <span className="text-3 text-xs truncate">{isFolder ? 'Folder' : typeLabel({ category: (it.data as FileDTO).category, ext: (it.data as FileDTO).extension })}</span>
              <button className="icon-btn !w-7 !h-7 text-3 hover:text-text" onClick={(e) => { e.stopPropagation(); onCtx(e as unknown as React.MouseEvent, it); }} aria-label="More">⋯</button>
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}


/** In-view lazy trigger for client-side video thumbnails (desktop-gated). */
function VideoThumbRequest({ id }: { id: string }) {
  useEffect(() => {
    requestVideoThumbnail(id);
  }, [id]);
  return null;
}
