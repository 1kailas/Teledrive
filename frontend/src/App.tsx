/**
 * TeleDrive — Main Application
 *
 * Routes, authentication, and global providers.
 */

import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './hooks/useAuth';
import { useThemeStore } from './stores';
import Layout from './components/layout/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Drive from './pages/Drive';
import SearchPage from './pages/Search';
import Favorites from './pages/Favorites';
import Recent from './pages/Recent';
import Trash from './pages/Trash';
import Settings from './pages/Settings';
import api from './services/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      retry: 2,
    },
  },
});

function AppContent() {
  const { user, loading, isAuthenticated, login, logout } = useAuth();
  const { theme, setTheme } = useThemeStore();
  const [totalStorage, setTotalStorage] = useState(0);

  // Apply theme on mount
  useEffect(() => {
    setTheme(theme);
  }, []);

  // Fetch storage stats when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      api.get('/stats').then((res) => {
        if (res.data.success) {
          setTotalStorage(res.data.data.totalStorage || 0);
        }
      }).catch(() => {});
    }
  }, [isAuthenticated]);

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-50 dark:bg-surface-950">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center shadow-glow animate-pulse-soft">
            <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // Not authenticated — show login
  if (!isAuthenticated) {
    return <Login onLogin={login} />;
  }

  // Authenticated — show app
  return (
    <Routes>
      <Route element={<Layout user={user} onLogout={logout} totalStorage={totalStorage} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/drive" element={<Drive />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/favorites" element={<Favorites />} />
        <Route path="/recent" element={<Recent />} />
        <Route path="/trash" element={<Trash />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppContent />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
