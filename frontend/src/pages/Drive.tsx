/**
 * TeleDrive — Drive Page (File Browser)
 *
 * Google Drive-style file browser with grid/list views, breadcrumbs,
 * drag & drop upload, context menu, and folder navigation.
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
} from 'lucide-react';
import api from '../services/api';
import { useUIStore } from '../stores';
import { useUpload } from '../hooks/useUpload';
import { useDownload } from '../hooks/useDownload';
import FileCard from '../components/files/FileCard';
import FolderCard from '../components/files/FolderCard';
import ContextMenu from '../components/files/ContextMenu';
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

  const { viewMode, contextMenu, setContextMenu } = useUIStore();
  const { uploadFiles } = useUpload();
  const { downloadFile } = useDownload();
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
  }, [fetchData]);

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
    const selectedFiles = e.target.files;
    if (selectedFiles && selectedFiles.length > 0) {
      uploadFiles(Array.from(selectedFiles), folderId);
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

  // Actions
  const handleDownload = useCallback((file: TDFile) => {
    downloadFile(file.id);
  }, [downloadFile]);

  const handleFavorite = useCallback(async (file: TDFile) => {
    try {
      await api.patch(`/files/${file.id}`, { isFavorite: !file.is_favorite });
      fetchData();
    } catch (err) {
      console.error('Failed to toggle favorite:', err);
    }
  }, [fetchData]);

  const handleDelete = useCallback(async (item: TDFile | TDFolder, type: 'file' | 'folder') => {
    try {
      if (type === 'file') {
        await api.delete(`/files/${item.id}`);
      } else {
        await api.delete(`/folders/${item.id}`);
      }
      fetchData();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  }, [fetchData]);

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
    } catch (err) {
      console.error('Failed to rename:', err);
    }
  }, [renameModal, renameName, fetchData]);

  const handleDuplicate = useCallback(async (file: TDFile) => {
    try {
      await api.post(`/files/${file.id}/duplicate`);
      fetchData();
    } catch (err) {
      console.error('Failed to duplicate:', err);
    }
  }, [fetchData]);

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
    } catch (err) {
      console.error('Failed to create folder:', err);
    }
  }, [newFolderName, folderId, fetchData]);

  return (
    <div
      className="min-h-[60vh]"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 mb-4 flex-wrap">
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
            <p className="text-sm text-slate-400 mt-1">
              This folder is empty
            </p>
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
              <div className={
                viewMode === 'grid'
                  ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3'
                  : 'space-y-1'
              }>
                {folders.map((folder) => (
                  <FolderCard
                    key={folder.id}
                    folder={folder}
                    viewMode={viewMode}
                    onDoubleClick={openFolder}
                    onClick={openFolder}
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
              <div className={
                viewMode === 'grid'
                  ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3'
                  : 'space-y-1'
              }>
                {files.map((file) => (
                  <FileCard
                    key={file.id}
                    file={file}
                    viewMode={viewMode}
                    onContextMenu={handleFileContextMenu}
                    onFavorite={handleFavorite}
                    onDoubleClick={handleDownload}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Context menu */}
      <ContextMenu
        state={contextMenu}
        onClose={closeContextMenu}
        onDownload={handleDownload}
        onRename={handleRename}
        onDuplicate={handleDuplicate}
        onFavorite={handleFavorite}
        onDelete={handleDelete}
      />

      {/* New Folder Modal */}
      <AnimatePresence>
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
      </AnimatePresence>

      {/* Rename Modal */}
      <AnimatePresence>
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
