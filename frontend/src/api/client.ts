import axios from 'axios';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { msalInstance, loginRequest } from '../auth/msalConfig';

const API_BASE = import.meta.env['VITE_API_URL'] as string || '/api';

export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// ─── Request interceptor: attach Entra ID access token (if MSAL has an active account) ───

apiClient.interceptors.request.use(async (config) => {
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length > 0) {
    try {
      const response = await msalInstance.acquireTokenSilent({
        scopes: loginRequest.scopes,
        account: accounts[0],
      });
      config.headers.Authorization = `Bearer ${response.accessToken}`;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        try {
          const response = await msalInstance.acquireTokenPopup({
            scopes: loginRequest.scopes,
          });
          config.headers.Authorization = `Bearer ${response.accessToken}`;
        } catch {
          // Could not acquire token — request will go without auth header
        }
      }
    }
  }
  return config;
});

// ─── Response interceptor: handle 401 ───
// For local auth: try cookie-based token refresh (legacy)
// For Entra auth: the request interceptor already handles token renewal via MSAL

// Prevent multiple simultaneous refresh attempts (local auth only)
let refreshPromise: Promise<void> | null = null;

function doRefresh(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = axios.post(`${API_BASE}/auth/refresh`, {}, { withCredentials: true })
      .then(() => {})
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) {
        // Entra mode: try to re-acquire token
        try {
          const response = await msalInstance.acquireTokenSilent({
            scopes: loginRequest.scopes,
            account: accounts[0],
          });
          originalRequest.headers.Authorization = `Bearer ${response.accessToken}`;
          return apiClient(originalRequest);
        } catch {
          // Token acquisition failed — redirect to login
          localStorage.removeItem('user');
          window.location.href = '/';
          return Promise.reject(error);
        }
      } else {
        // Local auth mode: try cookie-based refresh
        try {
          await doRefresh();
          return apiClient(originalRequest);
        } catch {
          localStorage.removeItem('user');
          window.location.href = '/';
          return Promise.reject(error);
        }
      }
    }

    return Promise.reject(error);
  }
);
