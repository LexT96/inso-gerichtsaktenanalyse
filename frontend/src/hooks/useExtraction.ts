import { useState, useCallback, useRef, useEffect } from 'react';
import { apiClient } from '../api/client';
import type { ExtractionResult, Pruefstatus } from '../types/extraction';
import { recomputeLetterStatuses } from '../utils/checklistValidator';
import mockResult from '../data/mock-result.json';
import demoPdfUrl from '../assets/demo/test-pdf.pdf?url';

const PROGRESS_CAP = 88;
const PROGRESS_INTERVAL_MS = 2500;
const PROGRESS_STEP = 4;

interface ExtractionState {
  loading: boolean;
  progress: string;
  progressPercent: number;
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
    progressPercent: 0,
    result: null,
    error: null,
    extractionId: null,
    statsFound: 0,
    statsMissing: 0,
    statsLettersReady: 0,
    processingTimeMs: null,
  });

  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearProgressInterval = useCallback(() => {
    if (progressIntervalRef.current) {
      clearInterval(progressIntervalRef.current);
      progressIntervalRef.current = null;
    }
  }, []);

  // Cleanup interval on unmount to prevent setState on unmounted component
  useEffect(() => {
    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
      }
    };
  }, []);

  const extract = useCallback(async (file: File) => {
    clearProgressInterval();
    setState(s => ({
      ...s,
      loading: true,
      error: null,
      progress: 'PDF wird hochgeladen…',
      progressPercent: 5,
    }));

    progressIntervalRef.current = setInterval(() => {
      setState(s => {
        if (!s.loading || s.progressPercent >= PROGRESS_CAP) return s;
        return { ...s, progressPercent: Math.min(PROGRESS_CAP, s.progressPercent + PROGRESS_STEP) };
      });
    }, PROGRESS_INTERVAL_MS);

    try {
      const formData = new FormData();
      formData.append('pdf', file);

      setState(s => ({ ...s, progress: 'KI-Analyse läuft — Extraktion mit Quellenangaben…' }));

      const { data } = await apiClient.post('/extract', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 600_000, // 10 min — large PDFs need multiple chunks + possible retry waits
      });

      clearProgressInterval();
      setState({
        loading: false,
        progress: '',
        progressPercent: 100,
        result: data.result,
        error: null,
        extractionId: data.id,
        statsFound: data.statsFound,
        statsMissing: data.statsMissing,
        statsLettersReady: data.statsLettersReady,
        processingTimeMs: data.processingTimeMs,
      });
    } catch (err: unknown) {
      clearProgressInterval();
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
        progressPercent: 0,
        error: `Fehler: ${message}`,
      }));
    }
  }, [clearProgressInterval]);

  const reset = useCallback(() => {
    clearProgressInterval();
    setState({
      loading: false,
      progress: '',
      progressPercent: 0,
      result: null,
      error: null,
      extractionId: null,
      statsFound: 0,
      statsMissing: 0,
      statsLettersReady: 0,
      processingTimeMs: null,
    });
  }, [clearProgressInterval]);

  const loadFromHistory = useCallback(async (id: number) => {
    setState(s => ({ ...s, loading: true, error: null, progress: 'Lade Verlauf…', progressPercent: 50 }));
    try {
      const { data } = await apiClient.get(`/history/${id}`);
      if (!data.result) {
        setState(s => ({
          ...s,
          loading: false,
          error: `Extraktion #${id} hat kein Ergebnis (Status: ${data.status ?? 'unbekannt'})`,
          progress: '',
        }));
        return;
      }
      setState({
        loading: false,
        progress: '',
        progressPercent: 100,
        result: data.result,
        error: null,
        extractionId: data.id,
        statsFound: data.statsFound,
        statsMissing: data.statsMissing,
        statsLettersReady: data.statsLettersReady,
        processingTimeMs: data.processingTimeMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fehler beim Laden des Verlaufs';
      setState(s => ({ ...s, loading: false, error: msg, progress: '' }));
    }
  }, []);

  const loadDemo = useCallback(async () => {
    clearProgressInterval();
    setState(s => ({ ...s, loading: true, error: null, progress: 'Demo wird geladen…', progressPercent: 10 }));
    try {
      let pdfBlob: Blob;
      try {
        const pdfRes = await fetch(demoPdfUrl);
        if (!pdfRes.ok) throw new Error(`Asset ${pdfRes.status}`);
        pdfBlob = await pdfRes.blob();
      } catch {
        const staticBase = ((import.meta.env.BASE_URL || '/').replace(/\/$/, '') || '') || '/';
        const fallbackUrl = staticBase ? `${staticBase}/demo/test-pdf.pdf` : '/demo/test-pdf.pdf';
        const fallbackRes = await fetch(fallbackUrl);
        if (!fallbackRes.ok) throw new Error('Demo-PDF nicht verfügbar. Bitte Backend starten oder Demo-Dateien prüfen.');
        pdfBlob = await fallbackRes.blob();
      }
      const file = new File([pdfBlob], 'demo-test.pdf', { type: 'application/pdf' });
      const found = 25;
      const missing = 10;
      setState({
        loading: false,
        progress: '',
        progressPercent: 0,
        result: mockResult as ExtractionResult,
        error: null,
        extractionId: null,
        statsFound: found,
        statsMissing: missing,
        statsLettersReady: 1,
        processingTimeMs: 0,
      });
      return file;
    } catch (err) {
      setState(s => ({
        ...s,
        loading: false,
        progress: '',
        progressPercent: 0,
        error: `Demo fehlgeschlagen: ${err instanceof Error ? err.message : 'Unbekannter Fehler'}`,
      }));
      return null;
    }
  }, [clearProgressInterval]);

  const updateField = useCallback(async (fieldPath: string, wert: string | null, pruefstatus: Pruefstatus) => {
    if (!state.result) return;

    // Optimistic local update
    const updatedResult = structuredClone(state.result);
    const parts = fieldPath.split('.');
    let obj: Record<string, unknown> = updatedResult as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]] as Record<string, unknown>;
    }
    const leafKey = parts[parts.length - 1];
    const field = obj[leafKey] as { wert: unknown; quelle: string; verifiziert?: boolean; pruefstatus?: string };
    field.wert = wert;
    field.pruefstatus = pruefstatus;

    // Recompute letter statuses
    updatedResult.standardanschreiben = recomputeLetterStatuses(updatedResult);

    setState(s => ({ ...s, result: updatedResult }));

    // Persist to backend (skip for demo mode where extractionId is null)
    if (state.extractionId) {
      try {
        await apiClient.patch(`/extractions/${state.extractionId}/fields`, {
          fieldPath,
          wert,
          pruefstatus,
        });
      } catch (err) {
        console.error('Failed to persist field update:', err);
      }
    }
  }, [state.result, state.extractionId]);

  return { ...state, extract, reset, loadDemo, loadFromHistory, updateField };
}
