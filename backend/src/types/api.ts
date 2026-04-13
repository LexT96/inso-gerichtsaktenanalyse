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
  user: {
    id: number;
    username: string;
    displayName: string;
    role: string;
  };
}

export type ExtractionStatus = 'processing' | 'completed' | 'failed' | 'expired' | 'deleted_art17';

export interface ExtractionResponse {
  id: number;
  filename: string;
  status: ExtractionStatus;
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
  status: ExtractionStatus;
  statsFound: number;
  statsMissing: number;
  statsLettersReady: number;
  processingTimeMs: number | null;
  createdAt: string;
  progressMessage?: string | null;
  progressPercent?: number | null;
}

export interface ApiError {
  error: string;
  details?: string;
}
