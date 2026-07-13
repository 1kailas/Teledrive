/**
 * TeleDrive — FileCard Component
 *
 * Displays a file in grid or list view with icon, name, size, date.
 */

import { memo, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  File,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileCode,
  Star,
  MoreVertical,
} from 'lucide-react';
import type { TDFile, ViewMode } from '../../types';
import { formatBytes, formatDate, getExtensionColor, getFileCategory } from '../../utils/helpers';

interface FileCardProps {
  file: TDFile;
  viewMode: ViewMode;
  isSelected?: boolean;
  onClick?: (file: TDFile) => void;
  onDoubleClick?: (file: TDFile) => void;
  onContextMenu?: (e: React.MouseEvent, file: TDFile) => void;
  onFavorite?: (file: TDFile) => void;
}

function getFileIcon(file: TDFile) {
  const category = getFileCategory(file.mime_type, file.extension);
  const size = 'w-6 h-6';
  switch (category) {
    case 'image': return <FileImage className={`${size} text-amber-500`} />;
    case 'video': return <FileVideo className={`${size} text-red-500`} />;
    case 'audio': return <FileAudio className={`${size} text-purple-500`} />;
    case 'pdf': return <FileText className={`${size} text-red-500`} />;
    case 'code': return <FileCode className={`${size} text-blue-500`} />;
    case 'text': return <FileText className={`${size} text-slate-500`} />;
    default: return <File className={`${size} text-slate-400`} />;
  }
}

const FileCard = memo(function FileCard({
  file,
  viewMode,
  isSelected,
  onClick,
  onDoubleClick,
  onContextMenu,
  onFavorite,
}: FileCardProps) {
  const handleClick = useCallback(() => onClick?.(file), [onClick, file]);
  const handleDoubleClick = useCallback(() => onDoubleClick?.(file), [onDoubleClick, file]);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu?.(e, file);
  }, [onContextMenu, file]);

  const extColor = getExtensionColor(file.extension);

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
        {/* Icon */}
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ backgroundColor: `${extColor}15` }}
        >
          {getFileIcon(file)}
        </div>

        {/* Name */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
            {file.name}
          </p>
        </div>

        {/* Size */}
        <span className="text-xs text-slate-400 w-20 text-right shrink-0">
          {formatBytes(file.size)}
        </span>

        {/* Date */}
        <span className="text-xs text-slate-400 w-24 text-right shrink-0 hidden md:block">
          {formatDate(file.created_at)}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {onFavorite && (
            <button
              onClick={(e) => { e.stopPropagation(); onFavorite(file); }}
              className="p-1 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors"
            >
              <Star
                className={`w-4 h-4 ${
                  file.is_favorite ? 'fill-warning-400 text-warning-400' : 'text-slate-400'
                }`}
              />
            </button>
          )}
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

  // Grid view
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
      {/* File icon area */}
      <div
        className="h-28 rounded-xl mb-3 flex items-center justify-center"
        style={{ backgroundColor: `${extColor}10` }}
      >
        <div className="flex flex-col items-center gap-1.5">
          {getFileIcon(file)}
          <span
            className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{ color: extColor, backgroundColor: `${extColor}15` }}
          >
            {file.extension || 'FILE'}
          </span>
        </div>
      </div>

      {/* Name */}
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
        {file.name}
      </p>

      {/* Meta */}
      <div className="flex items-center justify-between mt-1">
        <span className="text-xs text-slate-400">{formatBytes(file.size)}</span>
        <span className="text-xs text-slate-400">{formatDate(file.created_at)}</span>
      </div>

      {/* Hover actions */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {onFavorite && (
          <button
            onClick={(e) => { e.stopPropagation(); onFavorite(file); }}
            className="p-1.5 rounded-lg bg-white/80 dark:bg-surface-800/80 backdrop-blur-sm shadow-sm"
          >
            <Star
              className={`w-3.5 h-3.5 ${
                file.is_favorite ? 'fill-warning-400 text-warning-400' : 'text-slate-400'
              }`}
            />
          </button>
        )}
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

export default FileCard;
