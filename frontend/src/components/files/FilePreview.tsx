/**
 * TeleDrive — File Preview Component
 *
 * Full-screen modal for previewing images, videos, audio, PDFs, and text files.
 * Supports keyboard navigation (Escape, arrows for next/prev).
 */

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCw,
  ChevronLeft,
  ChevronRight,
  Loader2,
  FileText,
  Music,
  Check,
} from 'lucide-react';
import api from '../../services/api';
import { useDownload } from '../../hooks/useDownload';
import { useToastStore } from '../../stores';
import type { TDFile } from '../../types';
import { formatBytes, getFileCategory } from '../../utils/helpers';

interface FilePreviewProps {
  file: TDFile | null;
  files?: TDFile[];
  onClose: () => void;
  onNavigate?: (file: TDFile) => void;
}

export default function FilePreview({ file, files = [], onClose, onNavigate }: FilePreviewProps) {
  const [loading, setLoading] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { downloadFile } = useDownload();

  const category = file ? getFileCategory(file.mime_type, file.extension) : 'file';
  const currentIndex = file ? files.findIndex((f) => f.id === file.id) : -1;
  const canGoBack = currentIndex > 0;
  const canGoForward = currentIndex < files.length - 1;

  // Load preview content
  useEffect(() => {
    if (!file) return;

    setLoading(true);
    setError(null);
    setPreviewUrl(null);
    setTextContent(null);
    setEditContent('');
    setIsEditing(false);

    // Only single-chunk files can be previewed inline
    if (file.chunk_count > 1) {
      setError('Large files cannot be previewed. Download to view.');
      setLoading(false);
      return;
    }

    const loadPreview = async () => {
      try {
        const token = localStorage.getItem('teledrive_token');
        const baseUrl = (api.defaults.baseURL || '').replace(/\/+$/, '');

        if (category === 'image' || category === 'video' || category === 'audio' || category === 'pdf') {
          // Stream from preview endpoint
          const url = `${baseUrl}/preview/${file.id}`;
          setPreviewUrl(url + `?token=${token}`);
        } else if (category === 'text' || category === 'code') {
          // Fetch text content
          const res = await api.get(`/preview/${file.id}`, { responseType: 'text' });
          const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
          setTextContent(text);
          setEditContent(text);
        } else {
          setError('This file type cannot be previewed.');
        }
      } catch (err) {
        setError('Failed to load preview.');
        console.error('Preview error:', err);
      } finally {
        setLoading(false);
      }
    };

    loadPreview();
  }, [file, category]);

  // Save edited text content
  const handleSave = useCallback(async () => {
    if (!file || saving) return;
    setSaving(true);
    try {
      const res = await api.put(`/files/${file.id}/text`, { content: editContent });
      if (res.data.success) {
        setTextContent(editContent);
        setIsEditing(false);
        file.size = res.data.size;
        file.updated_at = new Date().toISOString();
        
        // Notify dynamic file listings to refresh
        window.dispatchEvent(new CustomEvent('teledrive:upload-complete'));
        
        useToastStore.getState().addToast('success', 'File saved successfully');
      }
    } catch (err: any) {
      useToastStore.getState().addToast('error', err.response?.data?.error || err.message || 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [file, editContent, saving]);

  // Tab support for editor textarea
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = e.currentTarget.selectionStart;
      const end = e.currentTarget.selectionEnd;
      const value = e.currentTarget.value;
      setEditContent(value.substring(0, start) + '  ' + value.substring(end));
      setTimeout(() => {
        e.currentTarget.selectionStart = e.currentTarget.selectionEnd = start + 2;
      }, 0);
    }
  };

  // Keyboard shortcut listener for Ctrl+S
  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        if (isEditing && !saving) {
          e.preventDefault();
          handleSave();
        }
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [isEditing, saving, handleSave]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && canGoBack && onNavigate) {
        onNavigate(files[currentIndex - 1]);
      }
      if (e.key === 'ArrowRight' && canGoForward && onNavigate) {
        onNavigate(files[currentIndex + 1]);
      }
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(z + 0.25, 5));
      if (e.key === '-') setZoom((z) => Math.max(z - 0.25, 0.25));
      if (e.key === 'r') setRotation((r) => r + 90);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, canGoBack, canGoForward, onNavigate, files, currentIndex]);

  const handleDownload = useCallback(() => {
    if (file) downloadFile(file.id);
  }, [file, downloadFile]);

  if (!file) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-md"
        onClick={onClose}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 bg-black/50"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">{file.name}</p>
            <p className="text-xs text-slate-400">{formatBytes(file.size)}</p>
          </div>

          <div className="flex items-center gap-1">
            {(category === 'text' || category === 'code') && !loading && !error && (
              <>
                {isEditing ? (
                  <>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary-500 hover:bg-primary-600 disabled:bg-slate-700 text-white text-xs font-semibold cursor-pointer select-none transition-colors"
                    >
                      {saving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setEditContent(textContent || '');
                        setIsEditing(false);
                      }}
                      disabled={saving}
                      className="px-3 py-1.5 rounded-lg hover:bg-white/10 text-white text-xs font-semibold cursor-pointer select-none transition-colors"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setIsEditing(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-semibold cursor-pointer select-none transition-colors"
                  >
                    Edit file
                  </button>
                )}
                <div className="w-px h-5 bg-white/20 mx-1" />
              </>
            )}
            {category === 'image' && (
              <>
                <button onClick={() => setZoom((z) => Math.min(z + 0.25, 5))} className="p-2 rounded-lg hover:bg-white/10 text-white transition-colors">
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))} className="p-2 rounded-lg hover:bg-white/10 text-white transition-colors">
                  <ZoomOut className="w-4 h-4" />
                </button>
                <button onClick={() => setRotation((r) => r + 90)} className="p-2 rounded-lg hover:bg-white/10 text-white transition-colors">
                  <RotateCw className="w-4 h-4" />
                </button>
                <div className="w-px h-5 bg-white/20 mx-1" />
              </>
            )}
            <button onClick={handleDownload} className="p-2 rounded-lg hover:bg-white/10 text-white transition-colors">
              <Download className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10 text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div
          className="flex-1 flex items-center justify-center overflow-auto relative"
          onClick={(e) => e.stopPropagation()}
        >
          {loading && (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-8 h-8 text-white animate-spin" />
              <p className="text-sm text-slate-400">Loading preview...</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center gap-3 text-center px-4">
              <FileText className="w-12 h-12 text-slate-500" />
              <p className="text-sm text-slate-400">{error}</p>
              <button onClick={handleDownload} className="btn-primary mt-2">
                <Download className="w-4 h-4" />
                Download File
              </button>
            </div>
          )}

          {!loading && !error && category === 'image' && previewUrl && (
            <motion.img
              src={previewUrl}
              alt={file.name}
              className="max-w-full max-h-full object-contain select-none"
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transition: 'transform 0.2s ease',
              }}
              onLoad={() => setLoading(false)}
              draggable={false}
            />
          )}

          {!loading && !error && category === 'video' && previewUrl && (
            <video
              src={previewUrl}
              controls
              autoPlay
              className="max-w-full max-h-full"
              onLoadedData={() => setLoading(false)}
            >
              Your browser does not support video playback.
            </video>
          )}

          {!loading && !error && category === 'audio' && previewUrl && (
            <div className="flex flex-col items-center gap-6 p-8">
              <div className="w-32 h-32 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center shadow-2xl">
                <Music className="w-16 h-16 text-white" />
              </div>
              <p className="text-white font-medium">{file.name}</p>
              <audio
                src={previewUrl}
                controls
                autoPlay
                className="w-80"
                onLoadedData={() => setLoading(false)}
              />
            </div>
          )}

          {!loading && !error && category === 'pdf' && previewUrl && (
            <iframe
              src={previewUrl}
              className="w-full h-full border-0"
              title={file.name}
              onLoad={() => setLoading(false)}
            />
          )}

          {!loading && !error && (category === 'text' || category === 'code') && textContent !== null && (
            <div className="w-full max-w-4xl mx-auto p-6 flex flex-col h-[75vh] overflow-hidden">
              {isEditing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  placeholder="Type code or text here..."
                  className="w-full flex-1 p-6 rounded-xl bg-black/60 text-sm text-slate-200 font-mono border border-white/10 outline-none focus:border-primary-500/50 resize-none overflow-y-auto"
                />
              ) : (
                <pre className="text-sm text-slate-300 font-mono whitespace-pre-wrap bg-black/50 rounded-xl p-6 border border-white/10 overflow-auto max-h-full">
                  {textContent}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Navigation arrows */}
        {files.length > 1 && (
          <>
            {canGoBack && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigate?.(files[currentIndex - 1]);
                }}
                className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
            )}
            {canGoForward && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onNavigate?.(files[currentIndex + 1]);
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/50 hover:bg-black/70 text-white transition-colors"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            )}
          </>
        )}

        {/* Footer with file info */}
        <div className="px-4 py-2 bg-black/50 text-center" onClick={(e) => e.stopPropagation()}>
          <p className="text-xs text-slate-500">
            {currentIndex >= 0 && files.length > 1 && `${currentIndex + 1} of ${files.length} · `}
            {file.extension?.toUpperCase()} · {formatBytes(file.size)}
            {category === 'image' && ` · ${Math.round(zoom * 100)}%`}
          </p>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
