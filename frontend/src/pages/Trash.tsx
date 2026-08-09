/**
 * TeleDrive — Trash Page
 */

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Trash2, Loader2, AlertTriangle } from 'lucide-react';
import api from '../services/api';
import { useUIStore } from '../stores';
import FileCard from '../components/files/FileCard';
import FolderCard from '../components/files/FolderCard';
import ContextMenu from '../components/files/ContextMenu';
import type { TDFile, TDFolder } from '../types';

export default function Trash() {
  const [files, setFiles] = useState<TDFile[]>([]);
  const [folders, setFolders] = useState<TDFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false);
  const { viewMode, contextMenu, setContextMenu } = useUIStore();

  const fetchTrash = async () => {
    try {
      const res = await api.get('/trash');
      if (res.data.success) {
        setFiles(res.data.data.files || []);
        setFolders(res.data.data.folders || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTrash(); }, []);

  const handleRestore = useCallback(async (item: TDFile | TDFolder, type: 'file' | 'folder') => {
    try {
      await api.post(`/trash/restore/${item.id}?type=${type}`);
      fetchTrash();
      window.dispatchEvent(new CustomEvent('teledrive:refresh-storage'));
    } catch (err) {
      console.error(err);
    }
  }, []);

  const handlePermanentDelete = useCallback(async (item: TDFile | TDFolder, type: 'file' | 'folder') => {
    try {
      await api.delete(`/trash/${item.id}?type=${type}`);
      fetchTrash();
      window.dispatchEvent(new CustomEvent('teledrive:refresh-storage'));
    } catch (err) {
      console.error(err);
    }
  }, []);

  const emptyTrash = async () => {
    try {
      await api.delete('/trash');
      setFiles([]);
      setFolders([]);
      setShowEmptyConfirm(false);
      window.dispatchEvent(new CustomEvent('teledrive:refresh-storage'));
    } catch (err) {
      console.error(err);
    }
  };

  const closeContextMenu = useCallback(() => {
    setContextMenu({ visible: false, x: 0, y: 0, item: null, type: null });
  }, [setContextMenu]);

  if (loading) return <div className="flex items-center justify-center h-48"><Loader2 className="w-8 h-8 text-primary-500 animate-spin" /></div>;

  const isEmpty = files.length === 0 && folders.length === 0;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Trash</h1>
          <p className="text-sm text-slate-400 mt-1">Files in trash will be permanently deleted</p>
        </div>
        {!isEmpty && (
          <button onClick={() => setShowEmptyConfirm(true)} className="btn-danger text-xs">
            <Trash2 className="w-3.5 h-3.5" />
            Empty Trash
          </button>
        )}
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-center justify-center h-48 text-slate-400">
          <Trash2 className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">Trash is empty</p>
        </div>
      ) : (
        <>
          {folders.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Folders</h3>
              <div className={viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3' : 'space-y-1'}>
                {folders.map((f) => (
                  <FolderCard
                    key={f.id}
                    folder={f}
                    viewMode={viewMode}
                    onContextMenu={(e, folder) => setContextMenu({ visible: true, x: e.clientX, y: e.clientY, item: folder, type: 'folder' })}
                  />
                ))}
              </div>
            </div>
          )}

          {files.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Files</h3>
              <div className={viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3' : 'space-y-1'}>
                {files.map((f) => (
                  <FileCard
                    key={f.id}
                    file={f}
                    viewMode={viewMode}
                    onContextMenu={(e, file) => setContextMenu({ visible: true, x: e.clientX, y: e.clientY, item: file, type: 'file' })}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <ContextMenu
        state={contextMenu}
        onClose={closeContextMenu}
        onRestore={handleRestore}
        onPermanentDelete={handlePermanentDelete}
        isTrash
      />

      {/* Empty trash confirmation */}
      {showEmptyConfirm && (
        <div className="modal-overlay" onClick={() => setShowEmptyConfirm(false)}>
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-error-500/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-error-500" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-800 dark:text-white">Empty Trash?</h3>
                <p className="text-sm text-slate-400">This cannot be undone. All files will be permanently deleted.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowEmptyConfirm(false)} className="btn-secondary">Cancel</button>
              <button onClick={emptyTrash} className="btn-danger">Empty Trash</button>
            </div>
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}
