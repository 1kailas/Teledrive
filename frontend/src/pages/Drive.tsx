/**
 * TeleDrive — Drive Page (File Browser with G-Drive features)
 *
 * Google Drive-style file browser with grid/list views, breadcrumbs,
 * drag & drop upload, context menu, folder navigation, multi-select,
 * floating selection bar, share modal, move-to modal, file preview, and details panel.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FolderPlus,
  Upload,
  ChevronRight,
  Home,
  Loader2,
  Info,
  Check,
} from 'lucide-react';
import api from '../services/api';
import { useUIStore, useToastStore } from '../stores';
import { useUpload } from '../hooks/useUpload';
import { useDownload } from '../hooks/useDownload';
import FileCard from '../components/files/FileCard';
import FolderCard from '../components/files/FolderCard';
import ContextMenu from '../components/files/ContextMenu';
import FilePreview from '../components/files/FilePreview';
import ShareModal from '../components/files/ShareModal';
import SelectionBar from '../components/files/SelectionBar';
import MoveToModal from '../components/files/MoveToModal';
import DetailPanel from '../components/files/DetailPanel';
import type { TDFile, TDFolder, Breadcrumb } from '../types';

export default function Drive() {
  const [searchParams, setSearchParams] = useSearchParams();
  const folderId = searchParams.get('folder') || null;

  const [files, setFiles] = useState<TDFile[]>([]);
  const [folders, setFolders] = useState<TDFolder[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameModal, setRenameModal] = useState<{ item: TDFile | TDFolder; type: 'file' | 'folder' } | null>(null);
  const [renameName, setRenameName] = useState('');

  // G Drive Feature Modals
  const [showShareModal, setShowShareModal] = useState<TDFile | null>(null);
  const [showMoveModal, setShowMoveModal] = useState<{ items: Array<TDFile | TDFolder> } | null>(null);
  const [previewingFile, setPreviewingFile] = useState<TDFile | null>(null);

  const {
    viewMode,
    contextMenu,
    setContextMenu,
    selectedFiles,
    selectedFolders,
    toggleFileSelection,
    toggleFolderSelection,
    clearSelection,
    selectAll,
    selectAllFolders,
    detailPanelOpen,
    detailPanelItem,
    setDetailPanel,
  } = useUIStore();

  const { uploadFiles } = useUpload();
  const { downloadFile } = useDownload();
  const { addToast } = useToastStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch files and folders
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [filesRes, foldersRes] = await Promise.all([
        api.get('/files', { params: { folderId: folderId || 'root' } }),
        api.get('/folders', { params: { parentId: folderId || 'root' } }),
      ]);

      setFiles(filesRes.data.data || []);
      setFolders(foldersRes.data.data || []);

      // Fetch breadcrumbs if inside a folder
      if (folderId) {
        const folderRes = await api.get(`/folders/${folderId}`);
        setBreadcrumbs(folderRes.data.data?.breadcrumbs || []);
      } else {
        setBreadcrumbs([]);
      }
    } catch (err) {
      console.error('Failed to fetch drive data:', err);
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    fetchData();
    clearSelection();

    const handleUploadComplete = () => {
      fetchData();
    };

    window.addEventListener('teledrive:upload-complete', handleUploadComplete);
    return () => {
      window.removeEventListener('teledrive:upload-complete', handleUploadComplete);
    };
  }, [fetchData, clearSelection]);

  // Keyboard shortcut Ctrl+A to select all files/folders
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInput = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.getAttribute('contenteditable') === 'true'
      );
      if (isInput) return;

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        if (files.length > 0 || folders.length > 0) {
          e.preventDefault();
          selectAll(files.map((f) => f.id));
          selectAllFolders(folders.map((fo) => fo.id));
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [files, folders, selectAll, selectAllFolders]);

  // Navigate to folder
  const openFolder = useCallback((folder: TDFolder) => {
    setSearchParams({ folder: folder.id });
  }, [setSearchParams]);

  // Drag & Drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFiles = Array.from(e.dataTransfer.files);
    if (droppedFiles.length > 0) {
      uploadFiles(droppedFiles, folderId);
      useUIStore.getState().setUploadPanelOpen(true);
    }
  }, [uploadFiles, folderId]);

  // File input handler
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFilesList = e.target.files;
    if (selectedFilesList && selectedFilesList.length > 0) {
      uploadFiles(Array.from(selectedFilesList), folderId);
      useUIStore.getState().setUploadPanelOpen(true);
    }
    e.target.value = '';
  }, [uploadFiles, folderId]);

  // Context menu handlers
  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: TDFile) => {
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, item: file, type: 'file' });
  }, [setContextMenu]);

  const handleFolderContextMenu = useCallback((e: React.MouseEvent, folder: TDFolder) => {
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, item: folder, type: 'folder' });
  }, [setContextMenu]);

  const closeContextMenu = useCallback(() => {
    setContextMenu({ visible: false, x: 0, y: 0, item: null, type: null });
  }, [setContextMenu]);

  // Download action
  const handleDownload = useCallback((file: TDFile) => {
    downloadFile(file.id);
  }, [downloadFile]);

  // Check if file is previewable
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

  // Double click handler
  const handleDoubleClick = useCallback((file: TDFile) => {
    if (isPreviewable(file)) {
      setPreviewingFile(file);
    } else {
      handleDownload(file);
    }
  }, [isPreviewable, handleDownload]);

  // Favorite toggle
  const handleFavorite = useCallback(async (file: TDFile) => {
    try {
      await api.patch(`/files/${file.id}`, { isFavorite: !file.is_favorite });
      fetchData();
      addToast('success', file.is_favorite ? 'Removed from favorites' : 'Added to favorites');
    } catch (err) {
      addToast('error', 'Failed to update favorite status');
    }
  }, [fetchData, addToast]);

  // Single-item delete (soft delete/move to trash)
  const handleDelete = useCallback(async (item: TDFile | TDFolder, type: 'file' | 'folder') => {
    try {
      if (type === 'file') {
        await api.delete(`/files/${item.id}`);
      } else {
        await api.delete(`/folders/${item.id}`);
      }
      fetchData();
      addToast('success', `${type === 'file' ? 'File' : 'Folder'} moved to trash`);
    } catch (err) {
      addToast('error', 'Failed to delete item');
    }
  }, [fetchData, addToast]);

  // Rename actions
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
      fetchData();
      addToast('success', 'Item renamed successfully');
    } catch (err) {
      addToast('error', 'Failed to rename item');
    }
  }, [renameModal, renameName, fetchData, addToast]);

  const handleDuplicate = useCallback(async (file: TDFile) => {
    try {
      await api.post(`/files/${file.id}/duplicate`);
      fetchData();
      addToast('success', 'File duplicated');
    } catch (err) {
      addToast('error', 'Failed to duplicate file');
    }
  }, [fetchData, addToast]);

  const createFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    try {
      await api.post('/folders', {
        name: newFolderName.trim(),
        parentId: folderId || undefined,
      });
      setShowNewFolderModal(false);
      setNewFolderName('');
      fetchData();
      addToast('success', `Folder "${newFolderName}" created`);
    } catch (err) {
      addToast('error', 'Failed to create folder');
    }
  }, [newFolderName, folderId, fetchData, addToast]);

  // Toggle selection on file click (handles range selection too)
  const handleSelectFile = useCallback((file: TDFile, e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFileSelection(file.id);
  }, [toggleFileSelection]);

  const handleSelectFolder = useCallback((folder: TDFolder, e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFolderSelection(folder.id);
  }, [toggleFolderSelection]);

  // Bulk operation triggers
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
      fetchData();
      addToast('success', `Successfully moved ${fileIds.length + folderIds.length} items`);
    } catch {
      addToast('error', 'Failed to move items');
    }
  }, [showMoveModal, clearSelection, fetchData, addToast]);

  const handleBulkTrash = useCallback(async () => {
    const fileIds = Array.from(selectedFiles);
    const folderIds = Array.from(selectedFolders);
    try {
      await api.post('/bulk/trash', { fileIds, folderIds });
      clearSelection();
      fetchData();
      addToast('success', `Moved ${fileIds.length + folderIds.length} items to Trash`);
    } catch {
      addToast('error', 'Failed to trash items');
    }
  }, [selectedFiles, selectedFolders, fetchData, clearSelection, addToast]);

  const handleBulkFavorite = useCallback(async (isFav: boolean) => {
    const fileIds = Array.from(selectedFiles);
    if (fileIds.length === 0) return;
    try {
      await api.post('/bulk/favorite', { fileIds, isFavorite: isFav });
      clearSelection();
      fetchData();
      addToast('success', `Updated favorite status for ${fileIds.length} files`);
    } catch {
      addToast('error', 'Failed to update favorite status');
    }
  }, [selectedFiles, fetchData, clearSelection, addToast]);

  const handleBulkDownload = useCallback(() => {
    selectedFiles.forEach((id) => {
      downloadFile(id);
    });
    clearSelection();
  }, [selectedFiles, downloadFile, clearSelection]);

  // Context Menu Share callback
  const handleContextShare = useCallback((file: TDFile) => {
    setShowShareModal(file);
  }, []);

  // Context Menu Details callback
  const handleContextDetails = useCallback((item: TDFile | TDFolder, type: 'file' | 'folder') => {
    setDetailPanel(true, { id: item.id, type });
  }, [setDetailPanel]);

  const allSelected =
    (files.length > 0 && selectedFiles.size === files.length) &&
    (folders.length > 0 && selectedFolders.size === folders.length);

  const handleSelectAllToggle = useCallback(() => {
    if (allSelected) {
      clearSelection();
    } else {
      selectAll(files.map((f) => f.id));
      selectAllFolders(folders.map((fo) => fo.id));
    }
  }, [allSelected, files, folders, selectAll, selectAllFolders, clearSelection]);

  return (
    <div
      className="min-h-[60vh] relative pr-0"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Main browse container with layout adjustments for detail panel */}
      <div className={`transition-all duration-300 ${detailPanelOpen ? 'lg:mr-80' : ''}`}>
        {/* Breadcrumbs */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-1 flex-wrap">
            <button
              onClick={() => setSearchParams({})}
              className="flex items-center gap-1 text-sm text-slate-500 hover:text-primary-600 transition-colors"
            >
              <Home className="w-4 h-4" />
              <span>My Drive</span>
            </button>
            {breadcrumbs.map((crumb) => (
              <div key={crumb.id} className="flex items-center gap-1">
                <ChevronRight className="w-3.5 h-3.5 text-slate-300" />
                <button
                  onClick={() => setSearchParams({ folder: crumb.id })}
                  className="text-sm text-slate-500 hover:text-primary-600 transition-colors"
                >
                  {crumb.name}
                </button>
              </div>
            ))}
          </div>

          {/* Show details toggler */}
          {(files.length > 0 || folders.length > 0) && (
            <button
              onClick={() => {
                if (detailPanelOpen) {
                  setDetailPanel(false);
                } else {
                  if (files.length > 0) {
                    setDetailPanel(true, { id: files[0].id, type: 'file' });
                  } else if (folders.length > 0) {
                    setDetailPanel(true, { id: folders[0].id, type: 'folder' });
                  }
                }
              }}
              className={`p-2 rounded-xl border transition-all ${
                detailPanelOpen
                  ? 'bg-primary-50 border-primary-200 dark:bg-primary-900/20 dark:border-primary-800 text-primary-500'
                  : 'border-surface-200 dark:border-surface-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
              title="View details"
            >
              <Info className="w-4.5 h-4.5" />
            </button>
          )}
        </div>

        {/* Actions bar */}
        <div className="flex items-center gap-2 mb-4">
          <button onClick={() => setShowNewFolderModal(true)} className="btn-secondary text-xs">
            <FolderPlus className="w-4 h-4" />
            New Folder
          </button>
          <button onClick={() => fileInputRef.current?.click()} className="btn-secondary text-xs">
            <Upload className="w-4 h-4" />
            Upload Files
          </button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

          {(files.length > 0 || folders.length > 0) && (
            <button
              onClick={handleSelectAllToggle}
              className={`btn-secondary text-xs select-none ${
                allSelected ? 'bg-primary-50 border-primary-200 dark:bg-primary-750/20 dark:border-primary-750 text-primary-600 dark:text-primary-350' : ''
              }`}
            >
              <Check className="w-4 h-4" />
              <span>{allSelected ? 'Deselect All' : 'Select All'}</span>
            </button>
          )}
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="w-8 h-8 text-primary-500 animate-spin" />
          </div>
        )}

        {/* Empty state */}
        {!loading && folders.length === 0 && files.length === 0 && (
          <div className={`upload-zone min-h-[300px] ${dragOver ? 'drag-active' : ''}`}>
            <Upload className="w-12 h-12 text-slate-300" />
            <div className="text-center">
              <p className="text-base font-medium text-slate-600 dark:text-slate-300">
                Drop files here or click to upload
              </p>
              <p className="text-sm text-slate-400 mt-1">This folder is empty</p>
            </div>
            <button onClick={() => fileInputRef.current?.click()} className="btn-primary mt-2">
              <Upload className="w-4 h-4" />
              Choose Files
            </button>
          </div>
        )}

        {/* Drag overlay */}
        <AnimatePresence>
          {dragOver && (folders.length > 0 || files.length > 0) && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-30 flex items-center justify-center bg-primary-500/10 backdrop-blur-sm"
            >
              <div className="upload-zone drag-active w-80">
                <Upload className="w-10 h-10 text-primary-500" />
                <p className="text-lg font-semibold text-primary-600 dark:text-primary-400">
                  Drop to upload
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content */}
        {!loading && (folders.length > 0 || files.length > 0) && (
          <>
            {/* Folders */}
            {folders.length > 0 && (
              <div className="mb-6">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                  Folders
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
                      onDoubleClick={openFolder}
                      onClick={(f, e) => {
                        if (e.ctrlKey || e.metaKey || e.shiftKey || selectedFiles.size > 0 || selectedFolders.size > 0) {
                          handleSelectFolder(f, e);
                        } else {
                          setDetailPanel(true, { id: f.id, type: 'folder' });
                        }
                      }}
                      onContextMenu={handleFolderContextMenu}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Files */}
            {files.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
                  Files
                </h3>
                <div
                  className={
                    viewMode === 'grid'
                      ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3'
                      : 'space-y-1'
                  }
                >
                  {files.map((file) => (
                    <FileCard
                      key={file.id}
                      file={file}
                      viewMode={viewMode}
                      isSelected={selectedFiles.has(file.id)}
                      selectionMode={selectedFiles.size > 0 || selectedFolders.size > 0}
                      onContextMenu={handleFileContextMenu}
                      onFavorite={handleFavorite}
                      onDoubleClick={handleDoubleClick}
                      onClick={(f) => {
                        setDetailPanel(true, { id: f.id, type: 'file' });
                      }}
                      onSelect={handleSelectFile}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
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

      {/* Right Detail Sidebar */}
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
        onDuplicate={handleDuplicate}
        onFavorite={handleFavorite}
        onShare={handleContextShare}
        onDetails={handleContextDetails}
        onDelete={handleDelete}
      />

      {/* Inline Modals */}
      <AnimatePresence>
        {/* New Folder Modal */}
        {showNewFolderModal && (
          <div className="modal-overlay" onClick={() => setShowNewFolderModal(false)}>
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="modal-content"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-slate-800 dark:text-white mb-4">
                New Folder
              </h3>
              <input
                type="text"
                placeholder="Folder name"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createFolder()}
                autoFocus
                className="w-full px-4 py-2.5 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-primary-400 focus:ring-2 focus:ring-primary-100 dark:focus:ring-primary-900/30 transition-all"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setShowNewFolderModal(false)} className="btn-secondary">
                  Cancel
                </button>
                <button onClick={createFolder} className="btn-primary">
                  Create
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {/* Rename Modal */}
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

        {/* Share Modal */}
        {showShareModal && (
          <ShareModal file={showShareModal} onClose={() => setShowShareModal(null)} />
        )}

        {/* Move To Folder Modal */}
        {showMoveModal && (
          <MoveToModal
            title="Move items to"
            itemCount={showMoveModal.items.length}
            excludeFolderIds={showMoveModal.items.filter((i) => !('mime_type' in i)).map((i) => i.id)}
            onClose={() => setShowMoveModal(null)}
            onMove={executeBulkMove}
          />
        )}

        {/* File Preview Overlay */}
        {previewingFile && (
          <FilePreview
            file={previewingFile}
            files={files}
            onClose={() => setPreviewingFile(null)}
            onNavigate={setPreviewingFile}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
