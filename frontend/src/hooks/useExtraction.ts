import { useState, useCallback } from 'react';
import { apiClient } from '../api/client';
import type { ExtractionResult } from '../types/extraction';

interface ExtractionState {
  loading: boolean;
  progress: string;
  result: ExtractionResult | null;
  error: string | null;
  extractionId: number | null;
  statsFound: number;
  statsMissing: number;
  statsLettersReady: number;
  processingTimeMs: number | null;
}

export function useExtraction() {
  const [state, setState] = useState<ExtractionState>({
    loading: false,
    progress: '',
    result: null,
    error: null,
    extractionId: null,
    statsFound: 0,
    statsMissing: 0,
    statsLettersReady: 0,
    processingTimeMs: null,
  });

  const extract = useCallback(async (file: File) => {
    setState(s => ({ ...s, loading: true, error: null, progress: 'PDF wird hochgeladen…' }));

    try {
      const formData = new FormData();
      formData.append('pdf', file);

      setState(s => ({ ...s, progress: 'KI-Analyse läuft — Extraktion mit Quellenangaben…' }));

      const { data } = await apiClient.post('/extract', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 600_000, // 10 min — large PDFs need multiple chunks + possible retry waits
      });

      setState({
        loading: false,
        progress: '',
        result: data.result,
        error: null,
        extractionId: data.id,
        statsFound: data.statsFound,
        statsMissing: data.statsMissing,
        statsLettersReady: data.statsLettersReady,
        processingTimeMs: data.processingTimeMs,
      });
    } catch (err: unknown) {
      let message = 'Unbekannter Fehler';
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        message = axiosErr.response?.data?.error || message;
      } else if (err instanceof Error) {
        message = err.message;
      }
      setState(s => ({
        ...s,
        loading: false,
        progress: '',
        error: `Fehler: ${message}`,
      }));
    }
  }, []);

  const reset = useCallback(() => {
    setState({
      loading: false,
      progress: '',
      result: null,
      error: null,
      extractionId: null,
      statsFound: 0,
      statsMissing: 0,
      statsLettersReady: 0,
      processingTimeMs: null,
    });
  }, []);

  return { ...state, extract, reset };
}
