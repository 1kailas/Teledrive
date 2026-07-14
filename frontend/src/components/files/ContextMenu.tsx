/**
 * TeleDrive — Context Menu Component (Enhanced)
 *
 * Right-click context menu with Preview, Share, and all standard actions.
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
  Eye,
  Link2,
  Info,
} from 'lucide-react';
import type { TDFile, TDFolder, ContextMenuState } from '../../types';
import { isFile } from '../../types';

interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onPreview?: (file: TDFile) => void;
  onDownload?: (file: TDFile) => void;
  onRename?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onMove?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onDuplicate?: (file: TDFile) => void;
  onFavorite?: (file: TDFile) => void;
  onShare?: (file: TDFile) => void;
  onDetails?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onDelete?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onRestore?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  onPermanentDelete?: (item: TDFile | TDFolder, type: 'file' | 'folder') => void;
  isTrash?: boolean;
}

export default function ContextMenu({
  state,
  onClose,
  onPreview,
  onDownload,
  onRename,
  onMove,
  onDuplicate,
  onFavorite,
  onShare,
  onDetails,
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

  // Check if file is previewable
  const canPreview = isFileItem && (item as TDFile).chunk_count === 1 && (
    (item as TDFile).mime_type?.startsWith('image/') ||
    (item as TDFile).mime_type?.startsWith('video/') ||
    (item as TDFile).mime_type?.startsWith('audio/') ||
    (item as TDFile).mime_type?.startsWith('text/') ||
    (item as TDFile).mime_type === 'application/pdf' ||
    (item as TDFile).mime_type === 'application/json'
  );

  // Adjust position to keep menu in viewport
  let { x, y } = state;
  if (typeof window !== 'undefined') {
    if (x + 200 > window.innerWidth) x = window.innerWidth - 210;
    if (y + 400 > window.innerHeight) y = window.innerHeight - 410;
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
          {/* Preview (previewable files only) */}
          {isFileItem && canPreview && onPreview && (
            <button
              className="context-menu-item w-full"
              onClick={() => { onPreview(item as TDFile); onClose(); }}
            >
              <Eye className="w-4 h-4" />
              <span>Preview</span>
            </button>
          )}

          {/* Download */}
          {isFileItem && (
            <button
              className="context-menu-item w-full"
              onClick={() => { onDownload?.(item as TDFile); onClose(); }}
            >
              <Download className="w-4 h-4" />
              <span>Download</span>
            </button>
          )}

          {(isFileItem && (canPreview || true)) && (
            <div className="mx-3 my-1 border-t border-surface-200 dark:border-surface-700" />
          )}

          {/* Share (files only) */}
          {isFileItem && onShare && (
            <button
              className="context-menu-item w-full"
              onClick={() => { onShare(item as TDFile); onClose(); }}
            >
              <Link2 className="w-4 h-4" />
              <span>Share link</span>
            </button>
          )}

          {/* Rename */}
          <button
            className="context-menu-item w-full"
            onClick={() => { onRename?.(item, state.type!); onClose(); }}
          >
            <Pencil className="w-4 h-4" />
            <span>Rename</span>
          </button>

          {/* Move */}
          <button
            className="context-menu-item w-full"
            onClick={() => { onMove?.(item, state.type!); onClose(); }}
          >
            <FolderInput className="w-4 h-4" />
            <span>Move to</span>
          </button>

          {isFileItem && (
            <>
              {/* Duplicate */}
              <button
                className="context-menu-item w-full"
                onClick={() => { onDuplicate?.(item as TDFile); onClose(); }}
              >
                <Copy className="w-4 h-4" />
                <span>Duplicate</span>
              </button>

              {/* Favorite */}
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

          {/* Details */}
          {onDetails && (
            <button
              className="context-menu-item w-full"
              onClick={() => { onDetails(item, state.type!); onClose(); }}
            >
              <Info className="w-4 h-4" />
              <span>Details</span>
            </button>
          )}

          {/* Trash */}
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
