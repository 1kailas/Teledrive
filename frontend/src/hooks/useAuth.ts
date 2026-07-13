/**
 * TeleDrive Frontend — Auth Hook
 */

import { useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import type { AuthUser } from '../types';

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const verify = useCallback(async () => {
    const token = localStorage.getItem('teledrive_token');
    if (!token) {
      setLoading(false);
      setIsAuthenticated(false);
      return;
    }

    try {
      const res = await api.post('/auth/verify');
      if (res.data.success && res.data.data) {
        setUser(res.data.data);
        setIsAuthenticated(true);
      } else {
        localStorage.removeItem('teledrive_token');
        setIsAuthenticated(false);
      }
    } catch {
      localStorage.removeItem('teledrive_token');
      setIsAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    verify();
  }, [verify]);

  const login = useCallback(async (token: string) => {
    localStorage.setItem('teledrive_token', token);
    await verify();
  }, [verify]);

  const logout = useCallback(() => {
    localStorage.removeItem('teledrive_token');
    setUser(null);
    setIsAuthenticated(false);
    window.location.href = '/login';
  }, []);

  return { user, loading, isAuthenticated, login, logout, verify };
}
