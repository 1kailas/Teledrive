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
  onClick?: (folder: TDFolder, e: React.MouseEvent) => void;
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
  const handleClick = useCallback((e: React.MouseEvent) => onClick?.(folder, e), [onClick, folder]);
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
        className={`flex items-center gap-4 px-4 py-3 rounded-xl cursor-pointer transition-all duration-250 group border
          ${isSelected
            ? 'bg-primary-500/10 dark:bg-primary-500/10 border-primary-500/35 dark:border-primary-400/35 shadow-[0_0_15px_rgba(26,115,232,0.08)]'
            : 'hover:bg-slate-100/70 dark:hover:bg-surface-800/40 border-transparent hover:border-surface-200/50 dark:hover:border-surface-700/50'
          }`}
      >
        <div className="w-10 h-10 rounded-xl bg-primary-500/10 dark:bg-primary-500/15 flex items-center justify-center shrink-0">
          <Folder className="w-6 h-6 text-primary-500 fill-primary-200/50 dark:fill-primary-900/40" />
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
            className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-surface-700 transition-colors"
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
      whileHover={{ y: -3 }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className={`file-card group ${
        isSelected ? 'border-primary-500 dark:border-primary-400 shadow-glow' : ''
      }`}
    >
      <div className="h-28 rounded-xl mb-3 flex items-center justify-center bg-primary-500/10 dark:bg-primary-500/15">
        <Folder className="w-12 h-12 text-primary-500 fill-primary-200/50 dark:fill-primary-900/40" />
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
