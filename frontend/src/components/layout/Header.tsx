import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Upload,
  Grid3X3,
  List,
  Moon,
  Sun,
  Menu,
  LogOut,
  User,
  Bell,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useUIStore, useThemeStore, useUploadStore } from '../../stores';
import { useUpload } from '../../hooks/useUpload';
import type { AuthUser, SearchSuggestion } from '../../types';
import api from '../../services/api';

interface HeaderProps {
  user: AuthUser | null;
  onLogout: () => void;
  currentFolderId?: string | null;
}

export default function Header({ user, onLogout, currentFolderId }: HeaderProps) {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [showUserMenu, setShowUserMenu] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Suggestions state
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  const { viewMode, setViewMode, sidebarOpen, setSidebarOpen, setUploadPanelOpen } = useUIStore();
  const { theme, setTheme } = useThemeStore();
  const { uploadFiles } = useUpload();
  const uploads = useUploadStore((s) => s.uploads);
  const activeUploads = uploads.filter((u) => u.status === 'uploading' || u.status === 'queued');

  // Debounced suggestion fetch
  useEffect(() => {
    if (searchQuery.trim().length < 2) {
      setSuggestions([]);
      return;
    }

    const fetchSuggestions = async () => {
      try {
        const res = await api.get('/search/suggest', { params: { q: searchQuery.trim() } });
        if (res.data.success) {
          setSuggestions(res.data.data || []);
        }
      } catch {
        // Ignore
      }
    };

    const delay = setTimeout(fetchSuggestions, 200);
    return () => clearTimeout(delay);
  }, [searchQuery]);

  // Click outside listener for suggestions
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setShowSuggestions(false);
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  }, [searchQuery, navigate]);

  const handleSuggestionClick = useCallback((text: string) => {
    setSearchQuery(text);
    setShowSuggestions(false);
    navigate(`/search?q=${encodeURIComponent(text)}`);
  }, [navigate]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadFiles(Array.from(files), currentFolderId || null);
      setUploadPanelOpen(true);
    }
    e.target.value = '';
  }, [uploadFiles, currentFolderId, setUploadPanelOpen]);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <header className="h-16 flex items-center justify-between px-4 lg:px-6 gap-4 glass sticky top-0 z-30">
      {/* Left: Menu + Search */}
      <div className="flex items-center gap-3 flex-1">
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="btn-ghost p-2 lg:hidden"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="relative flex-1 max-w-lg" ref={searchContainerRef}>
          <form onSubmit={handleSearch} className="search-bar w-full">
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              type="text"
              placeholder="Search files and folders..."
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              className="flex-1 bg-transparent outline-none text-sm text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
            />
          </form>

          {/* Autocomplete Dropdown */}
          <AnimatePresence>
            {showSuggestions && suggestions.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="absolute left-0 right-0 top-12 z-55 rounded-2xl bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 shadow-xl overflow-hidden py-1.5"
              >
                {suggestions.map((suggestion, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSuggestionClick(suggestion.text)}
                    className="w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-350 hover:bg-surface-50 dark:hover:bg-surface-800 flex items-center gap-2"
                  >
                    <Search className="w-3.5 h-3.5 text-slate-400" />
                    <span>{suggestion.text}</span>
                    {suggestion.type === 'folder' && (
                      <span className="text-[10px] bg-primary-100 dark:bg-primary-900/40 text-primary-600 dark:text-primary-400 px-1.5 py-0.5 rounded-full ml-auto">
                        Folder
                      </span>
                    )}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {/* Upload button */}
        <div className="relative">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="btn-primary"
          >
            <Upload className="w-4 h-4" />
            <span className="hidden sm:inline">Upload</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            /* @ts-expect-error webkitdirectory is not in the standard types */
            webkitdirectory=""
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Active uploads badge */}
          {activeUploads.length > 0 && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-accent-500 text-white text-[10px] font-bold flex items-center justify-center"
            >
              {activeUploads.length}
            </motion.div>
          )}
        </div>

        {/* Upload queue toggle */}
        {uploads.length > 0 && (
          <button
            onClick={() => setUploadPanelOpen(true)}
            className="btn-ghost p-2 relative"
          >
            <Bell className="w-4.5 h-4.5" />
            {activeUploads.length > 0 && (
              <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-accent-500 animate-pulse-soft" />
            )}
          </button>
        )}

        {/* View toggle */}
        <div className="hidden sm:flex items-center rounded-full bg-slate-100 dark:bg-surface-800/80 p-0.5 border border-surface-200/50 dark:border-surface-700/50 gap-0.5">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-1.5 rounded-full transition-all ${
              viewMode === 'grid'
                ? 'bg-white dark:bg-surface-700 shadow-sm text-primary-600 dark:text-primary-400'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Grid3X3 className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded-full transition-all ${
              viewMode === 'list'
                ? 'bg-white dark:bg-surface-700 shadow-sm text-primary-600 dark:text-primary-400'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <List className="w-4 h-4" />
          </button>
        </div>

        {/* Theme toggle */}
        <button onClick={toggleTheme} className="btn-ghost p-2">
          <AnimatePresence mode="wait">
            {theme === 'dark' ? (
              <motion.div key="sun" initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }} transition={{ duration: 0.2 }}>
                <Sun className="w-4.5 h-4.5" />
              </motion.div>
            ) : (
              <motion.div key="moon" initial={{ rotate: 90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: -90, opacity: 0 }} transition={{ duration: 0.2 }}>
                <Moon className="w-4.5 h-4.5" />
              </motion.div>
            )}
          </AnimatePresence>
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="w-9 h-9 rounded-full bg-primary-500 hover:bg-primary-600 flex items-center justify-center text-white text-xs font-semibold shadow-sm select-none cursor-pointer border border-white/10"
          >
            {user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'}
          </button>

          <AnimatePresence>
            {showUserMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowUserMenu(false)} />
                <motion.div
                  initial={{ opacity: 0, y: -8, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.95 }}
                  transition={{ duration: 0.15 }}
                  className="context-menu right-0 top-12 min-w-52"
                >
                  <div className="px-4 py-3 border-b border-surface-200 dark:border-surface-700">
                    <p className="text-sm font-semibold text-slate-800 dark:text-white">
                      {user?.name || 'User'}
                    </p>
                    <p className="text-xs text-slate-400 truncate">
                      {user?.email || 'No email'}
                    </p>
                  </div>
                  <div className="py-1">
                    <button
                      className="context-menu-item w-full"
                      onClick={() => {
                        navigate('/settings');
                        setShowUserMenu(false);
                      }}
                    >
                      <User className="w-4 h-4" />
                      <span>Settings</span>
                    </button>
                    <button
                      className="context-menu-item w-full text-error-500 hover:!text-error-500"
                      onClick={() => {
                        onLogout();
                        setShowUserMenu(false);
                      }}
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Log out</span>
                    </button>
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
