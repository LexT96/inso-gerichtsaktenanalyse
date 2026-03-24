import axios from 'axios';

const API_BASE = import.meta.env['VITE_API_URL'] as string || '/api';

export const apiClient = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
});

// Prevent multiple simultaneous refresh attempts
let refreshPromise: Promise<void> | null = null;

function doRefresh(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = axios.post(`${API_BASE}/auth/refresh`, {}, { withCredentials: true })
      .then(() => {})
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

// Response interceptor: handle 401 with cookie-based token refresh
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        await doRefresh();
        return apiClient(originalRequest);
      } catch {
        localStorage.removeItem('user');
        window.location.href = '/';
        return Promise.reject(error);
      }
    }

    return Promise.reject(error);
  }
);
