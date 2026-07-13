/**
 * TeleDrive — Context Menu Component
 */

import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  Download,
  Star,
  Pencil,
  FolderInput,
  Copy,
  Trash2,
  RotateCcw,
} from 'lucide-react';
import type { TDFile, TDFolder, ContextMenuState } from '../../types';
import { isFile } from '../../types';

interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onDownload?: (file: TDFile) => void;
  onRename?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onMove?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onDuplicate?: (file: TDFile) => void;
  onFavorite?: (file: TDFile) => void;
  onDelete?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onRestore?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onPermanentDelete?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  isTrash?: boolean;
}

export default function ContextMenu({
  state,
  onClose,
  onDownload,
  onRename,
  onMove,
  onDuplicate,
  onFavorite,
  onDelete,
  onRestore,
  onPermanentDelete,
  isTrash = false,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  if (!state.visible || !state.item) return null;

  const item = state.item;
  const isFileItem = isFile(item);

  // Adjust position to keep menu in viewport
  let { x, y } = state;
  if (typeof window !== 'undefined') {
    if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
    if (y + 300 > window.innerHeight) y = window.innerHeight - 310;
  }

  return (
    <motion.div
      ref={menuRef}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.1 }}
      className="context-menu"
      style={{ left: x, top: y }}
    >
      {isTrash ? (
        <>
          <button
            className="context-menu-item w-full"
            onClick={() => { onRestore?.(item, state.type!); onClose(); }}
          >
            <RotateCcw className="w-4 h-4" />
            <span>Restore</span>
          </button>
          <button
            className="context-menu-item w-full text-error-500"
            onClick={() => { onPermanentDelete?.(item, state.type!); onClose(); }}
          >
            <Trash2 className="w-4 h-4" />
            <span>Delete permanently</span>
          </button>
        </>
      ) : (
        <>
          {isFileItem && (
            <button
              className="context-menu-item w-full"
              onClick={() => { onDownload?.(item as TDFile); onClose(); }}
            >
              <Download className="w-4 h-4" />
              <span>Download</span>
            </button>
          )}
          <button
            className="context-menu-item w-full"
            onClick={() => { onRename?.(item, state.type!); onClose(); }}
          >
            <Pencil className="w-4 h-4" />
            <span>Rename</span>
          </button>
          <button
            className="context-menu-item w-full"
            onClick={() => { onMove?.(item, state.type!); onClose(); }}
          >
            <FolderInput className="w-4 h-4" />
            <span>Move</span>
          </button>
          {isFileItem && (
            <>
              <button
                className="context-menu-item w-full"
                onClick={() => { onDuplicate?.(item as TDFile); onClose(); }}
              >
                <Copy className="w-4 h-4" />
                <span>Duplicate</span>
              </button>
              <button
                className="context-menu-item w-full"
                onClick={() => { onFavorite?.(item as TDFile); onClose(); }}
              >
                <Star className={`w-4 h-4 ${(item as TDFile).is_favorite ? 'fill-warning-400 text-warning-400' : ''}`} />
                <span>{(item as TDFile).is_favorite ? 'Remove from favorites' : 'Add to favorites'}</span>
              </button>
            </>
          )}
          <div className="mx-3 my-1 border-t border-surface-200 dark:border-surface-700" />
          <button
            className="context-menu-item w-full text-error-500"
            onClick={() => { onDelete?.(item, state.type!); onClose(); }}
          >
            <Trash2 className="w-4 h-4" />
            <span>Move to trash</span>
          </button>
        </>
      )}
    </motion.div>
  );
}
