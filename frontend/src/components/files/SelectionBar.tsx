/**
 * TeleDrive — Selection Bar Component
 *
 * Floating action bar shown when files/folders are selected.
 * Provides quick actions for bulk operations.
 */

import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  FolderInput,
  Trash2,
  Download,
  Star,
  StarOff,
  Link2,
} from 'lucide-react';

interface SelectionBarProps {
  selectedCount: number;
  onClear: () => void;
  onMove: () => void;
  onTrash: () => void;
  onDownload: () => void;
  onFavorite: () => void;
  onUnfavorite: () => void;
  onShare?: () => void;
}

export default function SelectionBar({
  selectedCount,
  onClear,
  onMove,
  onTrash,
  onDownload,
  onFavorite,
  onUnfavorite,
  onShare,
}: SelectionBarProps) {
  return (
    <AnimatePresence>
      {selectedCount > 0 && (
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 20, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-slate-900/95 dark:bg-slate-800/95 backdrop-blur-xl shadow-2xl border border-white/10"
        >
          {/* Count */}
          <span className="text-sm font-semibold text-white mr-2">
            {selectedCount} selected
          </span>

          <div className="w-px h-5 bg-white/20" />

          {/* Actions */}
          <ActionButton icon={FolderInput} label="Move" onClick={onMove} />
          <ActionButton icon={Download} label="Download" onClick={onDownload} />
          <ActionButton icon={Star} label="Favorite" onClick={onFavorite} />
          <ActionButton icon={StarOff} label="Unfavorite" onClick={onUnfavorite} />
          {onShare && <ActionButton icon={Link2} label="Share" onClick={onShare} />}

          <div className="w-px h-5 bg-white/20" />

          <ActionButton icon={Trash2} label="Trash" onClick={onTrash} danger />

          <div className="w-px h-5 bg-white/20" />

          {/* Clear */}
          <button
            onClick={onClear}
            className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
            title="Clear selection"
          >
            <X className="w-4 h-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`p-2 rounded-lg transition-colors group relative ${
        danger
          ? 'hover:bg-red-500/20 text-red-400 hover:text-red-300'
          : 'hover:bg-white/10 text-slate-300 hover:text-white'
      }`}
      title={label}
    >
      <Icon className="w-4 h-4" />
      {/* Tooltip */}
      <span className="absolute -top-8 left-1/2 -translate-x-1/2 px-2 py-1 rounded-md bg-black text-white text-[10px] font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}
