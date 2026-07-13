/**
 * TeleDrive — Main Layout Component
 *
 * Wraps all pages with Sidebar + Header.
 */

import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import Sidebar from './Sidebar';
import Header from './Header';
import UploadPanel from '../upload/UploadPanel';
import { useUIStore } from '../../stores';
import type { AuthUser } from '../../types';

interface LayoutProps {
  user: AuthUser | null;
  onLogout: () => void;
  totalStorage?: number;
}

export default function Layout({ user, onLogout, totalStorage = 0 }: LayoutProps) {
  const { sidebarOpen } = useUIStore();

  return (
    <div className="min-h-screen">
      <Sidebar totalStorage={totalStorage} />

      <motion.main
        animate={{
          marginLeft: sidebarOpen ? 256 : 0,
        }}
        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
        className="min-h-screen flex flex-col"
      >
        <Header user={user} onLogout={onLogout} />

        <div className="flex-1 p-4 lg:p-6">
          <Outlet />
        </div>
      </motion.main>

      {/* Upload queue panel */}
      <UploadPanel />
    </div>
  );
}
