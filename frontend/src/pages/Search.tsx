/**
 * TeleDrive — Advanced Search Page
 *
 * Full-text search with rankings, category filter chips, size filters,
 * date ranges, live suggestions, and parent folder breadcrumb paths.
 * Fully supports G Drive features (previews, details sidebar, shares, and multi-select).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search as SearchIcon,
  Filter,
  Loader2,
  X,
  FolderOpen,
  Layers,
  Info,
  CalendarRange,
} from 'lucide-react';
import api from '../services/api';
import { useUIStore, useToastStore } from '../stores';
import { useDownload } from '../hooks/useDownload';
import FileCard from '../components/files/FileCard';
import FolderCard from '../components/files/FolderCard';
import ContextMenu from '../components/files/ContextMenu';
import FilePreview from '../components/files/FilePreview';
import ShareModal from '../components/files/ShareModal';
import SelectionBar from '../components/files/SelectionBar';
import MoveToModal from '../components/files/MoveToModal';
import DetailPanel from '../components/files/DetailPanel';
import type { TDFile, TDFolder, SearchSuggestion } from '../types';

const CATEGORIES = [
  { id: 'all', label: 'All files' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'document', label: 'Documents' },
  { id: 'code', label: 'Code' },
];

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') || '';

  const [query, setQuery] = useState(q);
  const [files, setFiles] = useState<TDFile[]>([]);
  const [folders, setFolders] = useState<TDFolder[]>([]);
  const [folderPaths, setFolderPaths] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  // Filters state
  const [showFilters, setShowFilters] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [modifiedFilter, setModifiedFilter] = useState('all'); // all, today, week, month
  const [minSizeMB, setMinSizeMB] = useState('');
  const [maxSizeMB, setMaxSizeMB] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);

  // Suggestions state
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // G Drive Feature Modals
  const [showShareModal, setShowShareModal] = useState<TDFile | null>(null);
  const [showMoveModal, setShowMoveModal] = useState<{ items: Array<TDFile | TDFolder> } | null>(null);
  const [previewingFile, setPreviewingFile] = useState<TDFile | null>(null);
  const [renameModal, setRenameModal] = useState<{ item: TDFile | TDFolder; type: 'file' | 'folder' } | null>(null);
  const [renameName, setRenameName] = useState('');

  const {
    viewMode,
    contextMenu,
    setContextMenu,
    selectedFiles,
    selectedFolders,
    toggleFileSelection,
    clearSelection,
    detailPanelOpen,
    detailPanelItem,
    setDetailPanel,
  } = useUIStore();

  const { downloadFile } = useDownload();
  const { addToast } = useToastStore();

  // Search logic
  const performSearch = useCallback(async (searchQuery: string) => {
    setLoading(true);
    try {
      const params: Record<string, string | number | boolean> = { q: searchQuery };

      if (selectedCategory !== 'all') params.type = selectedCategory;
      if (modifiedFilter !== 'all') params.modified = modifiedFilter;
      if (minSizeMB) params.minSize = parseFloat(minSizeMB) * 1024 * 1024;
      if (maxSizeMB) params.maxSize = parseFloat(maxSizeMB) * 1024 * 1024;
      if (starredOnly) params.starred = true;

      const res = await api.get('/search', { params });
      if (res.data.success) {
        setFiles(res.data.data.files || []);
        setFolders(res.data.data.folders || []);
        setFolderPaths(res.data.data.folderPaths || {});
      }
    } catch (err) {
      addToast('error', 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, modifiedFilter, minSizeMB, maxSizeMB, starredOnly, addToast]);

  useEffect(() => {
    if (q) {
      performSearch(q);
    } else {
      setFiles([]);
      setFolders([]);
    }
    clearSelection();
  }, [q, performSearch, clearSelection]);

  // Suggestions fetching
  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    const fetchSuggestions = async () => {
      try {
        const res = await api.get('/search/suggest', { params: { q: query.trim() } });
        if (res.data.success) {
          setSuggestions(res.data.data || []);
        }
      } catch {
        // Ignore
      }
    };

    const delay = setTimeout(fetchSuggestions, 200);
    return () => clearTimeout(delay);
  }, [query]);

  // Handle outside click to hide suggestions
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (suggestionsRef.current && !suggestionsRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setShowSuggestions(false);
    if (query.trim()) {
      setSearchParams({ q: query.trim() });
    }
  };

  const handleSuggestionClick = (suggestionText: string) => {
    setQuery(suggestionText);
    setSearchParams({ q: suggestionText });
    setShowSuggestions(false);
  };

  // Context & double click handlers
  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: TDFile) => {
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, item: file, type: 'file' });
  }, [setContextMenu]);

  const handleFolderContextMenu = useCallback((e: React.MouseEvent, folder: TDFolder) => {
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, item: folder, type: 'folder' });
  }, [setContextMenu]);

  const closeContextMenu = useCallback(() => {
    setContextMenu({ visible: false, x: 0, y: 0, item: null, type: null });
  }, [setContextMenu]);

  const handleFavorite = useCallback(async (file: TDFile) => {
    try {
      await api.patch(`/files/${file.id}`, { isFavorite: !file.is_favorite });
      performSearch(q);
      addToast('success', file.is_favorite ? 'Removed from favorites' : 'Added to favorites');
    } catch {
      addToast('error', 'Failed to update favorite');
    }
  }, [performSearch, q, addToast]);

  const handleDownload = useCallback((file: TDFile) => {
    downloadFile(file.id);
  }, [downloadFile]);

  const isPreviewable = useCallback((file: TDFile) => {
    return file.chunk_count === 1 && (
      file.mime_type?.startsWith('image/') ||
      file.mime_type?.startsWith('video/') ||
      file.mime_type?.startsWith('audio/') ||
      file.mime_type?.startsWith('text/') ||
      file.mime_type === 'application/pdf' ||
      file.mime_type === 'application/json'
    );
  }, []);

  const handleDoubleClick = useCallback((file: TDFile) => {
    if (isPreviewable(file)) {
      setPreviewingFile(file);
    } else {
      handleDownload(file);
    }
  }, [isPreviewable, handleDownload]);

  const handleDelete = useCallback(async (item: TDFile | TDFolder, type: 'file' | 'folder') => {
    try {
      if (type === 'file') {
        await api.delete(`/files/${item.id}`);
      } else {
        await api.delete(`/folders/${item.id}`);
      }
      performSearch(q);
      addToast('success', 'Moved item to trash');
    } catch {
      addToast('error', 'Failed to delete');
    }
  }, [performSearch, q, addToast]);

  const handleRename = useCallback((item: TDFile | TDFolder, type: 'file' | 'folder') => {
    setRenameModal({ item, type });
    setRenameName(item.name);
  }, []);

  const submitRename = useCallback(async () => {
    if (!renameModal || !renameName.trim()) return;
    try {
      if (renameModal.type === 'file') {
        await api.patch(`/files/${renameModal.item.id}`, { name: renameName.trim() });
      } else {
        await api.patch(`/folders/${renameModal.item.id}`, { name: renameName.trim() });
      }
      setRenameModal(null);
      performSearch(q);
      addToast('success', 'Item renamed successfully');
    } catch {
      addToast('error', 'Failed to rename item');
    }
  }, [renameModal, renameName, performSearch, q, addToast]);

  const handleBulkFavorite = useCallback(async (isFav: boolean) => {
    const fileIds = Array.from(selectedFiles);
    if (fileIds.length === 0) return;
    try {
      await api.post('/bulk/favorite', { fileIds, isFavorite: isFav });
      clearSelection();
      performSearch(q);
      addToast('success', `Updated favorite status for ${fileIds.length} files`);
    } catch {
      addToast('error', 'Failed to update favorite status');
    }
  }, [selectedFiles, performSearch, q, clearSelection, addToast]);

  // Bulk operations
  const handleBulkMove = useCallback(() => {
    const itemsToMove: Array<TDFile | TDFolder> = [];
    selectedFiles.forEach((id) => {
      const f = files.find((item) => item.id === id);
      if (f) itemsToMove.push(f);
    });
    selectedFolders.forEach((id) => {
      const f = folders.find((item) => item.id === id);
      if (f) itemsToMove.push(f);
    });
    if (itemsToMove.length > 0) {
      setShowMoveModal({ items: itemsToMove });
    }
  }, [selectedFiles, selectedFolders, files, folders]);

  const executeBulkMove = useCallback(async (targetFolderId: string | null) => {
    if (!showMoveModal) return;
    const fileIds = showMoveModal.items.filter((i) => 'mime_type' in i).map((i) => i.id);
    const folderIds = showMoveModal.items.filter((i) => !('mime_type' in i)).map((i) => i.id);

    try {
      await api.post('/bulk/move', { fileIds, folderIds, targetFolderId });
      setShowMoveModal(null);
      clearSelection();
      performSearch(q);
      addToast('success', `Moved items`);
    } catch {
      addToast('error', 'Failed to move items');
    }
  }, [showMoveModal, clearSelection, performSearch, q, addToast]);

  const handleBulkTrash = useCallback(async () => {
    const fileIds = Array.from(selectedFiles);
    const folderIds = Array.from(selectedFolders);
    try {
      await api.post('/bulk/trash', { fileIds, folderIds });
      clearSelection();
      performSearch(q);
      addToast('success', `Moved selected items to trash`);
    } catch {
      addToast('error', 'Failed to trash items');
    }
  }, [selectedFiles, selectedFolders, performSearch, q, clearSelection, addToast]);

  const handleBulkDownload = useCallback(() => {
    selectedFiles.forEach((id) => downloadFile(id));
    clearSelection();
  }, [selectedFiles, downloadFile, clearSelection]);

  const handleSelectFile = useCallback((file: TDFile, e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFileSelection(file.id);
  }, [toggleFileSelection]);

  return (
    <div className="space-y-6 relative">
      <div className={`transition-all duration-300 ${detailPanelOpen ? 'lg:mr-80' : ''}`}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Search Results</h1>
            <p className="text-sm text-slate-400 mt-1">
              {q ? `Showing results for "${q}"` : 'Search files and folders in your cloud'}
            </p>
          </div>

          {/* Details toggle */}
          {(files.length > 0 || folders.length > 0) && (
            <button
              onClick={() => {
                if (detailPanelOpen) setDetailPanel(false);
                else {
                  if (files.length > 0) setDetailPanel(true, { id: files[0].id, type: 'file' });
                  else if (folders.length > 0) setDetailPanel(true, { id: folders[0].id, type: 'folder' });
                }
              }}
              className={`p-2 rounded-xl border transition-all ${
                detailPanelOpen
                  ? 'bg-primary-50 border-primary-200 dark:bg-primary-900/20 dark:border-primary-800 text-primary-500'
                  : 'border-surface-200 dark:border-surface-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              <Info className="w-4.5 h-4.5" />
            </button>
          )}
        </div>

        {/* Search bar & autocomplete */}
        <div className="relative flex gap-2" ref={suggestionsRef}>
          <form onSubmit={handleSubmit} className="flex-1 flex gap-2">
            <div className="search-bar flex-1 relative">
              <SearchIcon className="w-4 h-4 text-slate-400 shrink-0" />
              <input
                type="text"
                placeholder="Search files, tags, descriptions..."
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(true)}
                className="flex-1 bg-transparent outline-none text-sm text-slate-700 dark:text-slate-200"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setSuggestions([]);
                    setSearchParams({});
                  }}
                  className="p-1 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                >
                  <X className="w-4 h-4 text-slate-400" />
                </button>
              )}
            </div>
            <button type="submit" className="btn-primary">Search</button>
            <button
              type="button"
              onClick={() => setShowFilters(!showFilters)}
              className={`btn-secondary ${showFilters ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-500' : ''}`}
            >
              <Filter className="w-4 h-4" />
            </button>
          </form>

          {/* Autocomplete Suggestions */}
          <AnimatePresence>
            {showSuggestions && suggestions.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute left-0 right-16 top-12 z-50 rounded-2xl bg-white dark:bg-surface-905 border border-surface-200 dark:border-surface-800 shadow-xl overflow-hidden py-2"
              >
                {suggestions.map((suggestion, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSuggestionClick(suggestion.text)}
                    className="w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-surface-50 dark:hover:bg-surface-800/50 flex items-center gap-2"
                  >
                    <SearchIcon className="w-3.5 h-3.5 text-slate-400" />
                    <span>{suggestion.text}</span>
                    {suggestion.type === 'folder' && (
                      <span className="text-[10px] bg-primary-100 dark:bg-primary-900/40 text-primary-600 dark:text-primary-400 px-1.5 py-0.5 rounded-full ml-auto">
                        Folder
                      </span>
                    )}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Filter chips expandable */}
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex flex-col gap-3 p-4 rounded-2xl border border-surface-200 dark:border-surface-700 bg-surface-50 dark:bg-surface-800/30 overflow-hidden"
          >
            {/* Categories */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-400 flex items-center gap-1 shrink-0 font-medium">
                <Layers className="w-3.5 h-3.5" />
                Type:
              </span>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => {
                    setSelectedCategory(cat.id);
                    if (q) performSearch(q);
                  }}
                  className={`px-3 py-1 rounded-full text-xs transition-all ${
                    selectedCategory === cat.id
                      ? 'bg-primary-500 text-white font-medium shadow-sm'
                      : 'bg-white dark:bg-surface-800 hover:bg-surface-100 dark:hover:bg-surface-700 text-slate-650 dark:text-slate-300 border border-surface-200 dark:border-surface-700'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {/* Date range & Size */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Date Filter */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-slate-400 font-medium flex items-center gap-1">
                  <CalendarRange className="w-3.5 h-3.5" />
                  Modified:
                </label>
                <select
                  value={modifiedFilter}
                  onChange={(e) => {
                    setModifiedFilter(e.target.value);
                    if (q) performSearch(q);
                  }}
                  className="px-3 py-1.5 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-xs text-slate-700 dark:text-slate-200 outline-none"
                >
                  <option value="all">Anytime</option>
                  <option value="today">Today</option>
                  <option value="week">Past Week</option>
                  <option value="month">Past Month</option>
                </select>
              </div>

              {/* Sizes MB */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-slate-400 font-medium">Min Size (MB):</label>
                <input
                  type="number"
                  placeholder="Min"
                  value={minSizeMB}
                  onChange={(e) => setMinSizeMB(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-xs text-slate-700 dark:text-slate-200 outline-none"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-slate-400 font-medium">Max Size (MB):</label>
                <input
                  type="number"
                  placeholder="Max"
                  value={maxSizeMB}
                  onChange={(e) => setMaxSizeMB(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-xs text-slate-700 dark:text-slate-200 outline-none"
                />
              </div>
            </div>

            {/* Starred Switch */}
            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={starredOnly}
                  onChange={(e) => {
                    setStarredOnly(e.target.checked);
                    if (q) performSearch(q);
                  }}
                  className="rounded text-primary-500 focus:ring-primary-500 border-surface-300 w-4 h-4"
                />
                <span className="text-xs text-slate-700 dark:text-slate-350">Starred files only</span>
              </label>

              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('all');
                  setModifiedFilter('all');
                  setMinSizeMB('');
                  setMaxSizeMB('');
                  setStarredOnly(false);
                  if (q) performSearch(q);
                }}
                className="text-xs text-primary-500 hover:text-primary-600 font-medium transition-colors"
              >
                Clear all filters
              </button>
            </div>
          </motion.div>
        )}

        {/* Results */}
        {loading && (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
          </div>
        )}

        {!loading && q && files.length === 0 && folders.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400">
            <SearchIcon className="w-10 h-10 mb-3 opacity-30 animate-pulse" />
            <p className="text-sm">No results for "{q}" matching your filters</p>
          </div>
        )}

        {/* Folders block */}
        {!loading && folders.length > 0 && (
          <div className="mt-6">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <FolderOpen className="w-4 h-4" />
              Folders matching search
            </h3>
            <div
              className={
                viewMode === 'grid'
                  ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3'
                  : 'space-y-1'
              }
            >
              {folders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  viewMode={viewMode}
                  isSelected={selectedFolders.has(folder.id)}
                  onClick={(f) => setDetailPanel(true, { id: f.id, type: 'folder' })}
                  onContextMenu={handleFolderContextMenu}
                />
              ))}
            </div>
          </div>
        )}

        {/* Files block */}
        {!loading && files.length > 0 && (
          <div className="mt-6">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              Files ({files.length})
            </h3>
            <div
              className={
                viewMode === 'grid'
                  ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3'
                  : 'space-y-1'
              }
            >
              {files.map((file) => (
                <div key={file.id} className="relative group/search-item">
                  <FileCard
                    file={file}
                    viewMode={viewMode}
                    isSelected={selectedFiles.has(file.id)}
                    selectionMode={selectedFiles.size > 0}
                    onContextMenu={handleFileContextMenu}
                    onFavorite={handleFavorite}
                    onDoubleClick={handleDoubleClick}
                    onClick={(f) => setDetailPanel(true, { id: f.id, type: 'file' })}
                    onSelect={handleSelectFile}
                  />

                  {/* Folder Path label for search results */}
                  {file.folder_id && folderPaths[file.folder_id] && (
                    <span className="absolute bottom-1 right-2 bg-slate-100 dark:bg-surface-800 text-[10px] text-slate-500 px-1.5 py-0.5 rounded-full pointer-events-none opacity-80 max-w-[100px] truncate">
                      {folderPaths[file.folder_id]}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Floating Selection Bar */}
      <SelectionBar
        selectedCount={selectedFiles.size + selectedFolders.size}
        onClear={clearSelection}
        onMove={handleBulkMove}
        onTrash={handleBulkTrash}
        onDownload={handleBulkDownload}
        onFavorite={() => handleBulkFavorite(true)}
        onUnfavorite={() => handleBulkFavorite(false)}
      />

      {/* Detail Sidebar */}
      <DetailPanel
        isOpen={detailPanelOpen}
        itemId={detailPanelItem?.id || null}
        itemType={detailPanelItem?.type || null}
        onClose={() => setDetailPanel(false)}
      />

      {/* Context Menu */}
      <ContextMenu
        state={contextMenu}
        onClose={closeContextMenu}
        onPreview={setPreviewingFile}
        onDownload={handleDownload}
        onRename={handleRename}
        onMove={(item) => setShowMoveModal({ items: [item] })}
        onFavorite={handleFavorite}
        onShare={(file) => setShowShareModal(file)}
        onDetails={(item, type) => setDetailPanel(true, { id: item.id, type })}
        onDelete={handleDelete}
      />

      {/* Modals */}
      <AnimatePresence>
        {showShareModal && (
          <ShareModal file={showShareModal} onClose={() => setShowShareModal(null)} />
        )}

        {showMoveModal && (
          <MoveToModal
            title="Move search items to"
            itemCount={showMoveModal.items.length}
            excludeFolderIds={showMoveModal.items.filter((i) => !('mime_type' in i)).map((i) => i.id)}
            onClose={() => setShowMoveModal(null)}
            onMove={executeBulkMove}
          />
        )}

        {previewingFile && (
          <FilePreview
            file={previewingFile}
            files={files}
            onClose={() => setPreviewingFile(null)}
            onNavigate={setPreviewingFile}
          />
        )}

        {renameModal && (
          <div className="modal-overlay" onClick={() => setRenameModal(null)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="modal-content"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">
                Rename {renameModal.type}
              </h3>
              <input
                type="text"
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitRename()}
                autoFocus
                className="w-full px-4 py-2.5 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100 dark:focus:ring-primary-900/30 transition-all"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setRenameModal(null)} className="btn-secondary">
                  Cancel
                </button>
                <button onClick={submitRename} className="btn-primary">
                  Rename
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
