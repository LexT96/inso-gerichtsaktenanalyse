import { useState, useCallback, useRef } from 'react';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { apiClient } from '../api/client';
import { msalInstance, loginRequest } from '../auth/msalConfig';
import type { ExtractionResult, Pruefstatus } from '../types/extraction';
import { recomputeLetterStatuses } from '../utils/checklistValidator';
import mockResult from '../data/mock-result.json';
import demoPdfUrl from '../assets/demo/test-pdf.pdf?url';

const API_BASE = import.meta.env['VITE_API_URL'] as string || '/api';

/** Get Bearer token for fetch() calls that bypass apiClient */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length === 0) return {};
  try {
    const res = await msalInstance.acquireTokenSilent({ scopes: loginRequest.scopes, account: accounts[0] });
    return { Authorization: `Bearer ${res.accessToken}` };
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      const res = await msalInstance.acquireTokenPopup({ scopes: loginRequest.scopes });
      return { Authorization: `Bearer ${res.accessToken}` };
    }
    return {};
  }
}

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
  pdfFile: File | null;
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
    pdfFile: null,
  });

  const abortRef = useRef<AbortController | null>(null);

  const extract = useCallback(async (file: File, proMode?: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState(s => ({
      ...s,
      loading: true,
      error: null,
      progress: 'PDF wird hochgeladen…',
      progressPercent: 3,
    }));

    try {
      const formData = new FormData();
      formData.append('pdf', file);

      const url = proMode ? `${API_BASE}/extract?pro=1` : `${API_BASE}/extract`;
      const authHeaders = await getAuthHeaders();
      const response = await fetch(url, {
        method: 'POST',
        headers: authHeaders,
        body: formData,
        credentials: 'include',
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(errBody?.error || `HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Streaming nicht unterstützt');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6);
          try {
            const event = JSON.parse(json);
            if (event.type === 'progress') {
              setState(s => ({
                ...s,
                progress: event.message,
                progressPercent: event.percent,
              }));
            } else if (event.type === 'result') {
              setState({
                loading: false,
                progress: '',
                progressPercent: 100,
                result: event.result,
                error: null,
                extractionId: event.id,
                statsFound: event.statsFound,
                statsMissing: event.statsMissing,
                statsLettersReady: event.statsLettersReady,
                processingTimeMs: event.processingTimeMs,
                pdfFile: null,
              });
            } else if (event.type === 'error') {
              setState(s => ({
                ...s,
                loading: false,
                progress: '',
                progressPercent: 0,
                error: `Fehler: ${event.error}`,
              }));
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      let message = 'Unbekannter Fehler';
      if (err instanceof Error) message = err.message;
      setState(s => ({
        ...s,
        loading: false,
        progress: '',
        progressPercent: 0,
        error: `Fehler: ${message}`,
      }));
    }
  }, []);

  // Resume: check if an extraction is still processing (e.g. after tab refresh)
  // Polls history every 3s until it completes or fails
  const resumeIfProcessing = useCallback(async () => {
    try {
      const { data: items } = await apiClient.get('/history');
      const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
      const processing = (items as Array<{ id: number; status: string; filename: string; createdAt: string }>)
        .find(item => item.status === 'processing' && item.createdAt > twentyMinutesAgo);

      if (!processing) return false;

      // Found an in-progress extraction — show progress and poll
      setState(s => ({
        ...s,
        loading: true,
        progress: 'Extraktion läuft im Hintergrund — warte auf Ergebnis…',
        progressPercent: 50,
        error: null,
      }));

      const pollInterval = setInterval(async () => {
        try {
          const { data: updated } = await apiClient.get(`/history/${processing.id}`);
          if (updated.status === 'completed' && updated.result) {
            clearInterval(pollInterval);
            const result = updated.result as ExtractionResult;
            result.standardanschreiben = recomputeLetterStatuses(result);
            setState({
              loading: false,
              progress: '',
              progressPercent: 100,
              result,
              error: null,
              extractionId: processing.id,
              statsFound: updated.statsFound ?? 0,
              statsMissing: updated.statsMissing ?? 0,
              statsLettersReady: updated.statsLettersReady ?? 0,
              processingTimeMs: updated.processingTimeMs ?? null,
              pdfFile: null,
            });
          } else if (updated.status === 'failed') {
            clearInterval(pollInterval);
            setState(s => ({
              ...s,
              loading: false,
              progress: '',
              progressPercent: 0,
              error: 'Extraktion fehlgeschlagen.',
            }));
          }
          // else: still processing, keep polling
        } catch {
          clearInterval(pollInterval);
        }
      }, 3000);

      return true;
    } catch {
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
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
      pdfFile: null,
    });
  }, []);

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
      // Recompute letter statuses from current field values (may have been edited)
      const result = data.result as ExtractionResult;
      result.standardanschreiben = recomputeLetterStatuses(result);

      setState({
        loading: false,
        progress: '',
        progressPercent: 100,
        result,
        error: null,
        extractionId: data.id,
        statsFound: data.statsFound,
        statsMissing: data.statsMissing,
        statsLettersReady: data.statsLettersReady,
        processingTimeMs: data.processingTimeMs,
        pdfFile: null,
      });

      // Try to load stored PDF for the viewer
      try {
        const authHeaders = await getAuthHeaders();
        const pdfRes = await fetch(`${API_BASE}/history/${id}/pdf`, {
          headers: authHeaders,
          credentials: 'include',
        });
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          const pdfFile = new File([blob], data.filename || `extraction-${id}.pdf`, { type: 'application/pdf' });
          setState(s => ({ ...s, pdfFile }));
        }
      } catch {
        // PDF not available — that's OK, show without viewer
      }
    } catch (err: unknown) {
      let msg = 'Fehler beim Laden des Verlaufs';
      if (err && typeof err === 'object' && 'response' in err) {
        const axiosErr = err as { response?: { status?: number; data?: { error?: string } } };
        if (axiosErr.response?.status === 410) {
          msg = axiosErr.response.data?.error || 'Extraktion abgelaufen oder gelöscht';
        } else if (axiosErr.response?.data?.error) {
          msg = axiosErr.response.data.error;
        }
      } else if (err instanceof Error) {
        msg = err.message;
      }
      setState(s => ({ ...s, loading: false, error: msg, progress: '' }));
    }
  }, []);

  const loadDemo = useCallback(async () => {
    abortRef.current?.abort();
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
        pdfFile: null,
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
  }, []);

  const loadFromImport = useCallback((result: ExtractionResult) => {
    setState({
      loading: false,
      progress: '',
      progressPercent: 100,
      result,
      error: null,
      extractionId: null, // Not persisted — import is view-only
      statsFound: 0,
      statsMissing: 0,
      statsLettersReady: 0,
      processingTimeMs: null,
      pdfFile: null,
    });
  }, []);

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

  return { ...state, extract, reset, loadDemo, loadFromHistory, loadFromImport, updateField, resumeIfProcessing };
}
