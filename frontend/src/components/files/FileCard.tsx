/**
 * TeleDrive — FileCard Component (Enhanced)
 *
 * Displays a file in grid or list view with:
 * - Thumbnail image preview for supported file types
 * - Selection checkbox for multi-select
 * - Icon, name, size, date, favorite star
 */

import { memo, useCallback, useState } from 'react';
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
  Check,
} from 'lucide-react';
import type { TDFile, ViewMode } from '../../types';
import { formatBytes, formatDate, getExtensionColor, getFileCategory } from '../../utils/helpers';
import api from '../../services/api';

interface FileCardProps {
  file: TDFile;
  viewMode: ViewMode;
  isSelected?: boolean;
  selectionMode?: boolean;
  onClick?: (file: TDFile) => void;
  onDoubleClick?: (file: TDFile) => void;
  onContextMenu?: (e: React.MouseEvent, file: TDFile) => void;
  onFavorite?: (file: TDFile) => void;
  onSelect?: (file: TDFile, e: React.MouseEvent) => void;
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

/** Check if file supports thumbnail preview */
function hasThumbnailSupport(file: TDFile): boolean {
  return !!file.thumbnail_msg_id;
}

const FileCard = memo(function FileCard({
  file,
  viewMode,
  isSelected,
  selectionMode,
  onClick,
  onDoubleClick,
  onContextMenu,
  onFavorite,
  onSelect,
}: FileCardProps) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailLoaded, setThumbnailLoaded] = useState(false);
  const [thumbnailError, setThumbnailError] = useState(false);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || selectionMode) {
      onSelect?.(file, e);
    } else {
      onClick?.(file);
    }
  }, [onClick, onSelect, file, selectionMode]);
  const handleDoubleClick = useCallback(() => onDoubleClick?.(file), [onDoubleClick, file]);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu?.(e, file);
  }, [onContextMenu, file]);

  // Lazy-load thumbnail
  const showThumbnail = viewMode === 'grid' && hasThumbnailSupport(file);
  const loadThumbnail = useCallback(() => {
    if (!showThumbnail || thumbnailUrl || thumbnailError) return;
    const baseUrl = (api.defaults.baseURL || '').replace(/\/+$/, '');
    const token = localStorage.getItem('teledrive_token');
    setThumbnailUrl(`${baseUrl}/thumbnails/${file.id}?token=${token}`);
  }, [showThumbnail, thumbnailUrl, thumbnailError, file.id]);

  // Trigger thumbnail load on mount for grid view
  if (showThumbnail && !thumbnailUrl && !thumbnailError) {
    loadThumbnail();
  }

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
        className={`flex items-center gap-4 px-4 py-3 rounded-xl cursor-pointer transition-all duration-250 group border
          ${isSelected
            ? 'bg-primary-500/10 dark:bg-primary-500/10 border-primary-500/35 dark:border-primary-400/35 shadow-[0_0_15px_rgba(139,92,246,0.08)]'
            : 'hover:bg-slate-100/70 dark:hover:bg-surface-800/40 border-transparent hover:border-surface-200/50 dark:hover:border-surface-700/50'
          }`}
      >
        {/* Selection checkbox */}
        <div
          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all cursor-pointer ${
            isSelected
              ? 'bg-primary-500 border-primary-500'
              : selectionMode
              ? 'border-surface-300 dark:border-surface-600 hover:border-primary-400'
              : 'border-transparent group-hover:border-surface-300 dark:group-hover:border-surface-600'
          }`}
          onClick={(e) => { e.stopPropagation(); onSelect?.(file, e); }}
        >
          {isSelected && <Check className="w-3 h-3 text-white" />}
        </div>

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
              className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-surface-700 transition-colors"
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
            className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-surface-700 transition-colors"
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
      whileHover={{ y: -3 }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className={`file-card group ${
        isSelected ? 'border-primary-500 dark:border-primary-400 shadow-glow' : ''
      }`}
    >
      {/* File thumbnail / icon area */}
      <div
        className="h-28 rounded-xl mb-3 flex items-center justify-center relative overflow-hidden"
        style={{ backgroundColor: `${extColor}10` }}
      >
        {/* Thumbnail image */}
        {showThumbnail && thumbnailUrl && !thumbnailError && (
          <>
            {!thumbnailLoaded && (
              <div className="absolute inset-0 bg-surface-100 dark:bg-surface-800 animate-pulse rounded-xl" />
            )}
            <img
              src={thumbnailUrl}
              alt={file.name}
              className={`absolute inset-0 w-full h-full object-cover rounded-xl transition-opacity duration-300 ${
                thumbnailLoaded ? 'opacity-100' : 'opacity-0'
              }`}
              onLoad={() => setThumbnailLoaded(true)}
              onError={() => setThumbnailError(true)}
              loading="lazy"
            />
          </>
        )}

        {/* Fallback icon (shown when no thumbnail) */}
        {(!showThumbnail || thumbnailError || !thumbnailUrl) && (
          <div className="flex flex-col items-center gap-1.5">
            {getFileIcon(file)}
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
              style={{ color: extColor, backgroundColor: `${extColor}15` }}
            >
              {file.extension || 'FILE'}
            </span>
          </div>
        )}
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

      {/* Selection checkbox (top-left) */}
      <div
        className={`absolute top-3 left-3 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all cursor-pointer ${
          isSelected
            ? 'bg-primary-500 border-primary-500 opacity-100'
            : selectionMode
            ? 'border-white/80 bg-black/20 backdrop-blur-sm opacity-100 hover:border-primary-400'
            : 'border-white/80 bg-black/20 backdrop-blur-sm opacity-0 group-hover:opacity-100'
        }`}
        onClick={(e) => { e.stopPropagation(); onSelect?.(file, e); }}
      >
        {isSelected && <Check className="w-3 h-3 text-white" />}
      </div>

      {/* Hover actions (top-right) */}
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
