import { createContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { InteractionRequiredAuthError, InteractionStatus } from '@azure/msal-browser';
import { apiClient } from '../api/client';
import { loginRequest } from '../auth/msalConfig';

interface User {
  id: number;
  username: string;
  displayName: string;
  role: string;
}

type AuthMode = 'local' | 'hybrid' | null;

interface AuthContextType {
  user: User | null;
  loading: boolean;
  authMode: AuthMode;
  login: (username: string, password: string) => Promise<void>;
  loginWithEntra: () => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  authMode: null,
  login: async () => {},
  loginWithEntra: async () => {},
  register: async () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const { instance, accounts, inProgress } = useMsal();
  const isEntraAuthenticated = useIsAuthenticated();

  // Detect auth mode from backend
  useEffect(() => {
    apiClient.get('/auth/mode')
      .then(({ data }) => {
        setAuthMode(data.mode as AuthMode);
      })
      .catch(() => {
        // Fallback to local if mode endpoint not available
        setAuthMode('local');
      });
  }, []);

  // Entra ID: after MSAL reports authenticated, fetch user from backend /auth/me
  useEffect(() => {
    if (authMode !== 'hybrid') return;
    // Wait for MSAL to finish initializing before concluding user is not authenticated
    if (inProgress !== InteractionStatus.None) return;
    if (!isEntraAuthenticated || accounts.length === 0) {
      // MSAL finished but no account — not Entra-authenticated, local auth effect handles fallback
      return;
    }

    // Acquire token silently, then call /auth/me
    (async () => {
      try {
        const tokenResponse = await instance.acquireTokenSilent({
          scopes: loginRequest.scopes,
          account: accounts[0],
        });
        // Set token for the /auth/me request
        const { data } = await apiClient.get('/auth/me', {
          headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
        });
        setUser(data.user);
      } catch (err) {
        if (err instanceof InteractionRequiredAuthError) {
          // Token expired, user needs to re-authenticate
          setUser(null);
        } else {
          console.error('Fehler beim Laden des Benutzers:', err);
          setUser(null);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [authMode, isEntraAuthenticated, accounts, instance, inProgress]);

  // Local auth: restore session from localStorage (works in both 'local' and 'hybrid' mode)
  useEffect(() => {
    if (authMode !== 'local' && authMode !== 'hybrid') return;
    // In hybrid mode, don't resolve loading until MSAL finished initializing
    if (authMode === 'hybrid' && inProgress !== InteractionStatus.None) return;
    // In hybrid mode, if MSAL has accounts, the Entra effect handles everything
    if (authMode === 'hybrid' && accounts.length > 0) return;
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {
        localStorage.removeItem('user');
      }
    }
    setLoading(false);
  }, [authMode, accounts, inProgress]);

  // Still loading while we don't know the auth mode
  useEffect(() => {
    if (authMode === null) {
      setLoading(true);
    }
  }, [authMode]);

  // Local auth: username/password login
  const login = useCallback(async (username: string, password: string) => {
    const { data } = await apiClient.post('/auth/login', { username, password });
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
  }, []);

  // Entra ID: popup login
  const loginWithEntra = useCallback(async () => {
    const response = await instance.loginPopup(loginRequest);
    if (response.account) {
      // Fetch user profile from backend
      const tokenResponse = await instance.acquireTokenSilent({
        scopes: loginRequest.scopes,
        account: response.account,
      });
      const { data } = await apiClient.get('/auth/me', {
        headers: { Authorization: `Bearer ${tokenResponse.accessToken}` },
      });
      setUser(data.user);
    }
  }, [instance]);

  // Email + password registration
  const register = useCallback(async (email: string, password: string, displayName: string) => {
    await apiClient.post('/auth/register', { email, password, displayName });
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/auth/logout');
    } catch {
      // Best-effort logout
    }

    if (authMode === 'hybrid') {
      // Only clear local MSAL cache — don't sign out of M365
      const account = instance.getActiveAccount() || instance.getAllAccounts()[0];
      if (account) {
        instance.clearCache();
      }
    }

    localStorage.removeItem('user');
    setUser(null);
  }, [authMode, instance]);

  return (
    <AuthContext.Provider value={{ user, loading, authMode, login, loginWithEntra, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
