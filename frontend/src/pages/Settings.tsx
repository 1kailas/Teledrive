/**
 * TeleDrive — Settings Page
 */

import { motion } from 'framer-motion';
import { Moon, Sun, Monitor, Grid3X3, List } from 'lucide-react';
import { useThemeStore, useUIStore } from '../stores';

export default function Settings() {
  const { theme, setTheme } = useThemeStore();
  const { viewMode, setViewMode } = useUIStore();

  const themes = [
    { value: 'light' as const, label: 'Light', icon: Sun },
    { value: 'dark' as const, label: 'Dark', icon: Moon },
    { value: 'system' as const, label: 'System', icon: Monitor },
  ];

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">Customize your TeleDrive experience</p>
      </div>

      {/* Theme */}
      <div className="stat-card">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-4">
          Appearance
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {themes.map((t) => (
            <button
              key={t.value}
              onClick={() => setTheme(t.value)}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                theme === t.value
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                  : 'border-transparent bg-surface-100 dark:bg-surface-800/50 hover:border-surface-300 dark:hover:border-surface-600'
              }`}
            >
              <t.icon className={`w-5 h-5 ${theme === t.value ? 'text-primary-500' : 'text-slate-400'}`} />
              <span className={`text-xs font-medium ${theme === t.value ? 'text-primary-600 dark:text-primary-400' : 'text-slate-500'}`}>
                {t.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Default view */}
      <div className="stat-card">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-4">
          Default View
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setViewMode('grid')}
            className={`flex items-center gap-3 p-4 rounded-xl border-2 transition-all ${
              viewMode === 'grid'
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                : 'border-transparent bg-surface-100 dark:bg-surface-800/50 hover:border-surface-300'
            }`}
          >
            <Grid3X3 className={`w-5 h-5 ${viewMode === 'grid' ? 'text-primary-500' : 'text-slate-400'}`} />
            <span className={`text-sm font-medium ${viewMode === 'grid' ? 'text-primary-600 dark:text-primary-400' : 'text-slate-500'}`}>
              Grid View
            </span>
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`flex items-center gap-3 p-4 rounded-xl border-2 transition-all ${
              viewMode === 'list'
                ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                : 'border-transparent bg-surface-100 dark:bg-surface-800/50 hover:border-surface-300'
            }`}
          >
            <List className={`w-5 h-5 ${viewMode === 'list' ? 'text-primary-500' : 'text-slate-400'}`} />
            <span className={`text-sm font-medium ${viewMode === 'list' ? 'text-primary-600 dark:text-primary-400' : 'text-slate-500'}`}>
              List View
            </span>
          </button>
        </div>
      </div>

      {/* About */}
      <div className="stat-card">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">About</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          TeleDrive v2.0 — Personal cloud storage powered by Telegram
        </p>
        <p className="text-xs text-slate-400 mt-1">
          Your files are stored in your Telegram Saved Messages
        </p>
      </div>
    </motion.div>
  );
}
