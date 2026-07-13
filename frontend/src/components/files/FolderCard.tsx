/**
 * TeleDrive — FolderCard Component
 */

import { memo, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Folder, MoreVertical } from 'lucide-react';
import type { TDFolder, ViewMode } from '../../types';
import { formatDate } from '../../utils/helpers';

interface FolderCardProps {
  folder: TDFolder;
  viewMode: ViewMode;
  isSelected?: boolean;
  onClick?: (folder: TDFolder) => void;
  onDoubleClick?: (folder: TDFolder) => void;
  onContextMenu?: (e: React.MouseEvent, folder: TDFolder) => void;
}

const FolderCard = memo(function FolderCard({
  folder,
  viewMode,
  isSelected,
  onClick,
  onDoubleClick,
  onContextMenu,
}: FolderCardProps) {
  const handleClick = useCallback(() => onClick?.(folder), [onClick, folder]);
  const handleDoubleClick = useCallback(() => onDoubleClick?.(folder), [onDoubleClick, folder]);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu?.(e, folder);
  }, [onContextMenu, folder]);

  if (viewMode === 'list') {
    return (
      <motion.div
        layout
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        className={`flex items-center gap-4 px-4 py-3 rounded-xl cursor-pointer transition-all duration-150 group
          ${isSelected
            ? 'bg-primary-50 dark:bg-primary-900/20 border border-primary-200 dark:border-primary-800'
            : 'hover:bg-surface-100 dark:hover:bg-surface-800/50 border border-transparent'
          }`}
      >
        <div className="w-10 h-10 rounded-xl bg-primary-50 dark:bg-primary-900/30 flex items-center justify-center shrink-0">
          <Folder className="w-6 h-6 text-primary-500 fill-primary-100 dark:fill-primary-900/50" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
            {folder.name}
          </p>
        </div>
        <span className="text-xs text-slate-400 w-20 text-right shrink-0">Folder</span>
        <span className="text-xs text-slate-400 w-24 text-right shrink-0 hidden md:block">
          {formatDate(folder.created_at)}
        </span>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); handleContextMenu(e); }}
            className="p-1 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors"
          >
            <MoreVertical className="w-4 h-4 text-slate-400" />
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ y: -2 }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className={`file-card group ${
        isSelected ? 'ring-2 ring-primary-400 dark:ring-primary-500' : ''
      }`}
    >
      <div className="h-28 rounded-xl mb-3 flex items-center justify-center bg-primary-50/50 dark:bg-primary-900/20">
        <Folder className="w-12 h-12 text-primary-500 fill-primary-100 dark:fill-primary-900/50" />
      </div>
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
        {folder.name}
      </p>
      <span className="text-xs text-slate-400 mt-1">{formatDate(folder.created_at)}</span>

      <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); handleContextMenu(e); }}
          className="p-1.5 rounded-lg bg-white/80 dark:bg-surface-800/80 backdrop-blur-sm shadow-sm"
        >
          <MoreVertical className="w-3.5 h-3.5 text-slate-400" />
        </button>
      </div>
    </motion.div>
  );
});

export default FolderCard;
