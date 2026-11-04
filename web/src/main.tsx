import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, createBrowserRouter, RouterProvider } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { queryClient } from './query';
import { applyTheme, useUi } from './store';
import { AppLayout } from './components/Layout';
import { LoginPage } from './pages/Login';
import { HomePage } from './pages/Home';
import { DrivePage } from './pages/Drive';
import { RecentPage } from './pages/Recent';
import { StarredPage } from './pages/Starred';
import { SharesPage } from './pages/Shares';
import { TrashPage } from './pages/Trash';
import { SearchPage } from './pages/Search';
import { SettingsPage } from './pages/Settings';
import { TransfersPage } from './pages/Transfers';
import { PublicSharePage } from './pages/PublicShare';
import { PhotosPage, VideosPage, DocumentsPage, AudioPage } from './pages/MediaPages';

import { RouteErrorBoundary } from './components/RouteErrorBoundary';

applyTheme(useUi.getState().theme);

// Prevent browser context menu (Back, Refresh, Save as, Print) globally across the desktop app
window.addEventListener('contextmenu', (e) => {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}, true);

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteErrorBoundary /> },
  { path: '/s/:token', element: <PublicSharePage />, errorElement: <RouteErrorBoundary /> },
  {
    element: <AppLayout />,
    errorElement: <RouteErrorBoundary />,
    children: [
      { path: '/', element: <Navigate to="/drive" replace /> },
      { path: '/home', element: <HomePage />, errorElement: <RouteErrorBoundary /> },
      { path: '/drive', element: <DrivePage />, errorElement: <RouteErrorBoundary /> },
      { path: '/drive/:folderId', element: <DrivePage />, errorElement: <RouteErrorBoundary /> },
      { path: '/recent', element: <RecentPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/transfers', element: <TransfersPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/starred', element: <StarredPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/photos', element: <PhotosPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/videos', element: <VideosPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/documents', element: <DocumentsPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/audio', element: <AudioPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/shared', element: <SharesPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/trash', element: <TrashPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/search', element: <SearchPage />, errorElement: <RouteErrorBoundary /> },
      { path: '/settings', element: <SettingsPage />, errorElement: <RouteErrorBoundary /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
