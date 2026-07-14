/**
 * TeleDrive — Move To Folder Modal
 *
 * Tree-view folder picker for moving files/folders.
 * Supports creating new folders inline and navigating the folder tree.
 */

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Folder,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Home,
  Loader2,
  Check,
} from 'lucide-react';
import api from '../../services/api';
import { useToastStore } from '../../stores';
import type { TDFolder } from '../../types';

interface MoveToModalProps {
  title?: string;
  itemCount?: number;
  excludeFolderIds?: string[];
  onClose: () => void;
  onMove: (targetFolderId: string | null) => void;
}

interface FolderNode extends TDFolder {
  children?: FolderNode[];
  isOpen?: boolean;
  isLoading?: boolean;
}

export default function MoveToModal({
  title = 'Move to',
  itemCount = 1,
  excludeFolderIds = [],
  onClose,
  onMove,
}: MoveToModalProps) {
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const { addToast } = useToastStore();

  // Load root folders
  useEffect(() => {
    const loadFolders = async () => {
      try {
        const res = await api.get('/folders', { params: { parentId: 'root' } });
        if (res.data.success) {
          setFolders(
            (res.data.data || [])
              .filter((f: TDFolder) => !excludeFolderIds.includes(f.id))
              .map((f: TDFolder) => ({ ...f, children: undefined, isOpen: false }))
          );
        }
      } catch {
        addToast('error', 'Failed to load folders');
      } finally {
        setLoading(false);
      }
    };
    loadFolders();
  }, [excludeFolderIds, addToast]);

  // Toggle folder open/close and load children
  const toggleFolder = useCallback(async (folderId: string) => {
    setFolders((prev) => {
      const update = (nodes: FolderNode[]): FolderNode[] =>
        nodes.map((node) => {
          if (node.id === folderId) {
            return { ...node, isOpen: !node.isOpen, isLoading: !node.isOpen && !node.children };
          }
          if (node.children) {
            return { ...node, children: update(node.children) };
          }
          return node;
        });
      return update(prev);
    });

    // Load children if not already loaded
    try {
      const res = await api.get('/folders', { params: { parentId: folderId } });
      if (res.data.success) {
        const children = (res.data.data || [])
          .filter((f: TDFolder) => !excludeFolderIds.includes(f.id))
          .map((f: TDFolder) => ({ ...f, children: undefined, isOpen: false }));

        setFolders((prev) => {
          const update = (nodes: FolderNode[]): FolderNode[] =>
            nodes.map((node) => {
              if (node.id === folderId) {
                return { ...node, children, isLoading: false };
              }
              if (node.children) {
                return { ...node, children: update(node.children) };
              }
              return node;
            });
          return update(prev);
        });
      }
    } catch {
      // Ignore
    }
  }, [excludeFolderIds]);

  // Create new folder
  const createFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    setCreating(true);
    try {
      const res = await api.post('/folders', {
        name: newFolderName.trim(),
        parentId: newFolderParent || undefined,
      });
      if (res.data.success) {
        const newFolder: FolderNode = {
          id: res.data.data.id,
          user_id: '',
          name: newFolderName.trim(),
          parent_id: newFolderParent,
          is_trashed: 0,
          trashed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          isOpen: false,
        };

        if (newFolderParent) {
          setFolders((prev) => {
            const addChild = (nodes: FolderNode[]): FolderNode[] =>
              nodes.map((node) => {
                if (node.id === newFolderParent) {
                  return {
                    ...node,
                    children: [...(node.children || []), newFolder],
                    isOpen: true,
                  };
                }
                if (node.children) {
                  return { ...node, children: addChild(node.children) };
                }
                return node;
              });
            return addChild(prev);
          });
        } else {
          setFolders((prev) => [...prev, newFolder]);
        }

        setSelectedFolderId(newFolder.id);
        setNewFolderName('');
        setShowNewFolder(false);
        addToast('success', `Folder "${newFolderName.trim()}" created`);
      }
    } catch {
      addToast('error', 'Failed to create folder');
    } finally {
      setCreating(false);
    }
  }, [newFolderName, newFolderParent, addToast]);

  // Render folder tree recursively
  const renderFolderNode = (node: FolderNode, depth: number = 0) => {
    const isSelected = selectedFolderId === node.id;
    const isExcluded = excludeFolderIds.includes(node.id);

    return (
      <div key={node.id}>
        <button
          onClick={() => {
            if (!isExcluded) setSelectedFolderId(node.id);
          }}
          onDoubleClick={() => toggleFolder(node.id)}
          disabled={isExcluded}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all ${
            isExcluded
              ? 'opacity-40 cursor-not-allowed'
              : isSelected
              ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400'
              : 'hover:bg-surface-100 dark:hover:bg-surface-800/50 text-slate-700 dark:text-slate-200'
          }`}
          style={{ paddingLeft: `${12 + depth * 20}px` }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleFolder(node.id);
            }}
            className="p-0.5 rounded hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors"
          >
            {node.isOpen ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
          </button>
          <Folder className={`w-4 h-4 shrink-0 ${isSelected ? 'text-primary-500 fill-primary-100' : 'text-primary-400 fill-primary-50 dark:fill-primary-900/30'}`} />
          <span className="text-sm truncate">{node.name}</span>
          {isSelected && <Check className="w-4 h-4 text-primary-500 ml-auto shrink-0" />}
          {node.isLoading && <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin ml-auto shrink-0" />}
        </button>

        {/* Children */}
        <AnimatePresence>
          {node.isOpen && node.children && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {node.children.map((child) => renderFolderNode(child, depth + 1))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="modal-content max-w-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-slate-800 dark:text-white">
            {title} {itemCount > 1 && `(${itemCount} items)`}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Folder tree */}
        <div className="max-h-64 overflow-y-auto rounded-xl border border-surface-200 dark:border-surface-700 mb-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 text-primary-500 animate-spin" />
            </div>
          ) : (
            <div className="py-1">
              {/* Root option */}
              <button
                onClick={() => setSelectedFolderId(null)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-all ${
                  selectedFolderId === null
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400'
                    : 'hover:bg-surface-100 dark:hover:bg-surface-800/50 text-slate-700 dark:text-slate-200'
                }`}
              >
                <Home className="w-4 h-4 text-slate-400 ml-5" />
                <span className="text-sm">My Drive (root)</span>
                {selectedFolderId === null && <Check className="w-4 h-4 text-primary-500 ml-auto" />}
              </button>

              {folders.map((folder) => renderFolderNode(folder))}

              {folders.length === 0 && (
                <p className="text-sm text-slate-400 text-center py-4">No folders</p>
              )}
            </div>
          )}
        </div>

        {/* New folder inline */}
        {showNewFolder ? (
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createFolder()}
              autoFocus
              className="flex-1 px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-sm text-slate-700 dark:text-slate-200 outline-none focus:border-primary-400 transition-colors"
            />
            <button onClick={createFolder} disabled={creating} className="btn-primary text-xs">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
            </button>
            <button onClick={() => setShowNewFolder(false)} className="btn-secondary text-xs">
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => {
              setNewFolderParent(selectedFolderId);
              setShowNewFolder(true);
            }}
            className="flex items-center gap-1.5 text-xs text-primary-500 hover:text-primary-600 mb-4 transition-colors"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            New folder
          </button>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={() => onMove(selectedFolderId)}
            className="btn-primary"
          >
            <FolderPlus className="w-4 h-4" />
            Move here
          </button>
        </div>
      </motion.div>
    </div>
  );
}
