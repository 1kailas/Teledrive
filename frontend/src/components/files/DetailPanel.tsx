/**
 * TeleDrive — Detail Panel Component
 *
 * Google Drive-style right sidebar showing file details,
 * activity history, tags, and description.
 */

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  File,
  FileImage,
  FileVideo,
  FileAudio,
  FileText,
  FileCode,
  Folder,
  Tag,
  Calendar,
  HardDrive,
  Hash,
  Pencil,
  Check,
  Clock,
} from 'lucide-react';
import api from '../../services/api';
import type { TDFile, TDFolder } from '../../types';
import { formatBytes, formatDate, getFileCategory, getExtensionColor } from '../../utils/helpers';
import { useToastStore } from '../../stores';

interface DetailPanelProps {
  isOpen: boolean;
  itemId: string | null;
  itemType: 'file' | 'folder' | null;
  onClose: () => void;
}

export default function DetailPanel({ isOpen, itemId, itemType, onClose }: DetailPanelProps) {
  const [file, setFile] = useState<TDFile | null>(null);
  const [folder, setFolder] = useState<TDFolder | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [description, setDescription] = useState('');
  const [editingTags, setEditingTags] = useState(false);
  const [tagsInput, setTagsInput] = useState('');
  const [activeTab, setActiveTab] = useState<'details' | 'activity'>('details');

  const { addToast } = useToastStore();

  // Fetch item data
  useEffect(() => {
    if (!itemId || !itemType) return;

    const fetchData = async () => {
      try {
        if (itemType === 'file') {
          const res = await api.get(`/files/${itemId}`);
          if (res.data.success) {
            setFile(res.data.data);
            setFolder(null);
            setDescription(res.data.data.description || '');
            const tags = res.data.data.tags ? JSON.parse(res.data.data.tags) : [];
            setTagsInput(tags.join(', '));
          }
        } else {
          const res = await api.get(`/folders/${itemId}`);
          if (res.data.success) {
            setFolder(res.data.data);
            setFile(null);
          }
        }
      } catch {
        // Ignore
      }
    };
    fetchData();
  }, [itemId, itemType]);

  const saveDescription = useCallback(async () => {
    if (!file) return;
    try {
      await api.patch(`/files/${file.id}`, { description: description.trim() || null });
      setFile((f) => f ? { ...f, description: description.trim() || null } : null);
      setEditingDescription(false);
      addToast('success', 'Description updated');
    } catch {
      addToast('error', 'Failed to update description');
    }
  }, [file, description, addToast]);

  const saveTags = useCallback(async () => {
    if (!file) return;
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      await api.patch(`/files/${file.id}`, { tags });
      setFile((f) => f ? { ...f, tags: JSON.stringify(tags) } : null);
      setEditingTags(false);
      addToast('success', 'Tags updated');
    } catch {
      addToast('error', 'Failed to update tags');
    }
  }, [file, tagsInput, addToast]);

  const getIcon = () => {
    if (folder) return <Folder className="w-8 h-8 text-primary-500 fill-primary-100 dark:fill-primary-900/50" />;
    if (!file) return <File className="w-8 h-8 text-slate-400" />;
    const cat = getFileCategory(file.mime_type, file.extension);
    const cls = 'w-8 h-8';
    switch (cat) {
      case 'image': return <FileImage className={`${cls} text-amber-500`} />;
      case 'video': return <FileVideo className={`${cls} text-red-500`} />;
      case 'audio': return <FileAudio className={`${cls} text-purple-500`} />;
      case 'pdf': return <FileText className={`${cls} text-red-500`} />;
      case 'code': return <FileCode className={`${cls} text-blue-500`} />;
      case 'text': return <FileText className={`${cls} text-slate-500`} />;
      default: return <File className={`${cls} text-slate-400`} />;
    }
  };

  const item = file || folder;
  const tags = file?.tags ? JSON.parse(file.tags) : [];

  return (
    <AnimatePresence>
      {isOpen && item && (
        <motion.div
          initial={{ x: 320, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 320, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 250 }}
          className="fixed right-0 top-16 bottom-0 w-80 z-20 bg-white dark:bg-surface-900 border-l border-surface-200 dark:border-surface-800 shadow-xl overflow-y-auto"
        >
          {/* Header */}
          <div className="sticky top-0 bg-white dark:bg-surface-900 z-10 px-5 pt-5 pb-3 border-b border-surface-100 dark:border-surface-800">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                  style={{ backgroundColor: file ? `${getExtensionColor(file.extension)}15` : undefined }}
                >
                  {getIcon()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800 dark:text-white truncate">
                    {item.name}
                  </p>
                  <p className="text-xs text-slate-400">
                    {file ? (file.extension?.toUpperCase() || 'File') : 'Folder'}
                  </p>
                </div>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors shrink-0">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mt-4">
              <button
                onClick={() => setActiveTab('details')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'details'
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400'
                    : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                }`}
              >
                Details
              </button>
              <button
                onClick={() => setActiveTab('activity')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  activeTab === 'activity'
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400'
                    : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                }`}
              >
                Activity
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="px-5 py-4">
            {activeTab === 'details' && (
              <div className="space-y-5">
                {/* Properties */}
                <div className="space-y-3">
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Properties</h4>

                  {file && (
                    <>
                      <DetailRow icon={HardDrive} label="Size" value={formatBytes(file.size)} />
                      <DetailRow icon={Hash} label="Type" value={file.mime_type || 'Unknown'} />
                      <DetailRow icon={Hash} label="Chunks" value={String(file.chunk_count)} />
                    </>
                  )}
                  <DetailRow icon={Calendar} label="Created" value={formatDate(item.created_at)} />
                  <DetailRow icon={Calendar} label="Modified" value={formatDate(item.updated_at)} />

                  {file?.sha256_hash && (
                    <DetailRow icon={Hash} label="SHA-256" value={file.sha256_hash.substring(0, 16) + '...'} />
                  )}
                </div>

                {/* Description (files only) */}
                {file && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Description</h4>
                      <button
                        onClick={() => {
                          if (editingDescription) saveDescription();
                          else setEditingDescription(true);
                        }}
                        className="p-1 rounded hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                      >
                        {editingDescription ? <Check className="w-3.5 h-3.5 text-primary-500" /> : <Pencil className="w-3.5 h-3.5 text-slate-400" />}
                      </button>
                    </div>
                    {editingDescription ? (
                      <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Add a description..."
                        autoFocus
                        rows={3}
                        className="w-full px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-primary-400 resize-none transition-colors"
                      />
                    ) : (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {file.description || 'No description'}
                      </p>
                    )}
                  </div>
                )}

                {/* Tags (files only) */}
                {file && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Tags</h4>
                      <button
                        onClick={() => {
                          if (editingTags) saveTags();
                          else setEditingTags(true);
                        }}
                        className="p-1 rounded hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                      >
                        {editingTags ? <Check className="w-3.5 h-3.5 text-primary-500" /> : <Pencil className="w-3.5 h-3.5 text-slate-400" />}
                      </button>
                    </div>
                    {editingTags ? (
                      <input
                        type="text"
                        value={tagsInput}
                        onChange={(e) => setTagsInput(e.target.value)}
                        placeholder="tag1, tag2, tag3..."
                        autoFocus
                        className="w-full px-3 py-2 rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 text-xs text-slate-700 dark:text-slate-200 outline-none focus:border-primary-400 transition-colors"
                        onKeyDown={(e) => e.key === 'Enter' && saveTags()}
                      />
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {tags.length > 0 ? (
                          tags.map((tag: string) => (
                            <span
                              key={tag}
                              className="px-2 py-0.5 rounded-full bg-primary-50 dark:bg-primary-900/20 text-primary-600 dark:text-primary-400 text-[10px] font-medium"
                            >
                              {tag}
                            </span>
                          ))
                        ) : (
                          <span className="text-xs text-slate-400">No tags</span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'activity' && (
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Recent Activity</h4>
                <div className="space-y-2">
                  <ActivityRow
                    icon={Calendar}
                    text={`Created ${formatDate(item.created_at)}`}
                  />
                  {item.updated_at !== item.created_at && (
                    <ActivityRow
                      icon={Clock}
                      text={`Modified ${formatDate(item.updated_at)}`}
                    />
                  )}
                  {file?.is_favorite ? (
                    <ActivityRow icon={Tag} text="Marked as favorite" />
                  ) : null}
                </div>
                <p className="text-[11px] text-slate-400 italic mt-4">
                  Detailed activity logging coming soon.
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DetailRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">{label}</p>
        <p className="text-xs text-slate-700 dark:text-slate-200 break-all">{value}</p>
      </div>
    </div>
  );
}

function ActivityRow({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-surface-50 dark:bg-surface-800/50">
      <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
      <p className="text-xs text-slate-600 dark:text-slate-300">{text}</p>
    </div>
  );
}
