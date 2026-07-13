/**
 * TeleDrive — Sidebar Component
 *
 * Google Drive-style navigation sidebar with glassmorphism effect.
 */

import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  HardDrive,
  Star,
  Clock,
  Trash2,
  Settings,
  Cloud,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useUIStore } from '../../stores';
import { formatBytes } from '../../utils/helpers';

interface SidebarProps {
  totalStorage?: number;
}

const navItems = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/drive', icon: HardDrive, label: 'My Drive' },
  { path: '/favorites', icon: Star, label: 'Favorites' },
  { path: '/recent', icon: Clock, label: 'Recent' },
  { path: '/trash', icon: Trash2, label: 'Trash' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export default function Sidebar({ totalStorage = 0 }: SidebarProps) {
  const location = useLocation();
  const { sidebarOpen, setSidebarOpen } = useUIStore();

  // Estimate max storage (Telegram doesn't have a strict limit per user)
  const maxStorage = 15 * 1024 * 1024 * 1024; // 15 GB display cap
  const usagePercent = Math.min((totalStorage / maxStorage) * 100, 100);

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <motion.aside
        initial={false}
        animate={{
          x: sidebarOpen ? 0 : -256,
          width: 256,
        }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="sidebar"
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center shadow-glow">
            <Cloud className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight">
              TeleDrive
            </h1>
            <p className="text-[10px] text-slate-400 font-medium tracking-wide uppercase">
              Personal Cloud
            </p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-2 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const isActive =
              item.path === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(item.path);

            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={`sidebar-item ${isActive ? 'active' : ''}`}
                onClick={() => {
                  if (window.innerWidth < 1024) setSidebarOpen(false);
                }}
              >
                <item.icon className="w-[18px] h-[18px]" />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Storage meter */}
        <div className="mx-4 mb-4 p-4 rounded-xl bg-surface-100/80 dark:bg-surface-800/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Storage
            </span>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              {formatBytes(totalStorage)}
            </span>
          </div>
          <div className="storage-meter">
            <motion.div
              className="storage-meter-fill"
              initial={{ width: 0 }}
              animate={{ width: `${usagePercent}%` }}
              transition={{ duration: 1, ease: 'easeOut' }}
            />
          </div>
          <p className="text-[10px] text-slate-400 mt-1.5">
            {formatBytes(totalStorage)} of {formatBytes(maxStorage)} used
          </p>
        </div>

        {/* Toggle button */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="absolute -right-3 top-8 w-6 h-6 rounded-full bg-white dark:bg-surface-700 shadow-md border border-surface-200 dark:border-surface-600 flex items-center justify-center hover:scale-110 transition-transform z-50"
        >
          {sidebarOpen ? (
            <ChevronLeft className="w-3.5 h-3.5 text-slate-500" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
          )}
        </button>
      </motion.aside>
    </>
  );
}
