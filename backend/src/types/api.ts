import type { ExtractionResult } from './extraction';

export interface JwtPayload {
  userId: number;
  username: string;
  role: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: number;
    username: string;
    displayName: string;
    role: string;
  };
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export interface ExtractionResponse {
  id: number;
  filename: string;
  status: 'processing' | 'completed' | 'failed';
  result: ExtractionResult | null;
  statsFound: number;
  statsMissing: number;
  statsLettersReady: number;
  processingTimeMs: number | null;
  createdAt: string;
}

export interface HistoryItem {
  id: number;
  filename: string;
  fileSize: number;
  status: 'processing' | 'completed' | 'failed';
  statsFound: number;
  statsMissing: number;
  statsLettersReady: number;
  processingTimeMs: number | null;
  createdAt: string;
}

export interface ApiError {
  error: string;
  details?: string;
}
