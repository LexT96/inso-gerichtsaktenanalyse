import { useEffect, useRef, useState, useCallback } from 'react';
import { apiClient } from '../api/client';

export interface DocumentJob {
  docId: number;
  extractionId: number;
  filename: string;
  sourceType: string;
  status: 'idle' | 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  message: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

const DISMISSED_KEY = 'tbs.documentJobs.dismissed';
const REFRESH_EVENT = 'tbs:document-jobs-refresh';

/**
 * Trigger an immediate refresh of the navbar badge — use after POSTing /extract
 * so the user doesn't have to wait for the next polling tick (8s idle) to see
 * their new job appear.
 */
export function notifyDocumentJobStarted(): void {
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

function loadDismissed(): Set<number> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x): x is number => typeof x === 'number') : []);
  } catch {
    return new Set();
  }
}

function persistDismissed(set: Set<number>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...set]));
  } catch { /* quota or disabled — ignore */ }
}

/**
 * Polls /api/extractions/documents/jobs/active to surface running + recently-finished
 * supplement jobs in the navbar. Completed/failed entries can be dismissed per-client
 * (persisted in localStorage) so they don't linger once the user has acknowledged them.
 */
export function useDocumentJobs(): {
  jobs: DocumentJob[];
  refresh: () => void;
  dismiss: (docId: number) => void;
} {
  const [rawJobs, setRawJobs] = useState<DocumentJob[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(() => loadDismissed());
  const mountedRef = useRef(true);
  const timerRef = useRef<number | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const { data } = await apiClient.get<DocumentJob[]>('/extractions/documents/jobs/active');
      if (!mountedRef.current) return;
      setRawJobs(data);
      // Prune dismissed ids that the server no longer reports (e.g. after apply cleared them).
      setDismissed(prev => {
        const visibleIds = new Set(data.map(j => j.docId));
        const next = new Set<number>();
        for (const id of prev) if (visibleIds.has(id)) next.add(id);
        if (next.size !== prev.size) persistDismissed(next);
        return next;
      });
    } catch {
      // Silent — navbar polling errors should not pop UI errors
    }
  }, []);

  const dismiss = useCallback((docId: number) => {
    setDismissed(prev => {
      if (prev.has(docId)) return prev;
      const next = new Set(prev);
      next.add(docId);
      persistDismissed(next);
      return next;
    });
  }, []);

  const jobs = rawJobs.filter(j => !dismissed.has(j.docId));
  const hasActive = jobs.some(j => j.status === 'pending' || j.status === 'processing');

  useEffect(() => {
    mountedRef.current = true;
    const tick = async () => {
      await fetchJobs();
      if (!mountedRef.current) return;
      const delay = hasActive ? 2000 : 8000;
      timerRef.current = window.setTimeout(tick, delay);
    };
    tick();

    // External trigger: something just kicked off a job, skip ahead to an immediate fetch.
    const onRefresh = () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      tick();
    };
    window.addEventListener(REFRESH_EVENT, onRefresh);

    return () => {
      mountedRef.current = false;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
    };
  }, [hasActive, fetchJobs]);

  return { jobs, refresh: fetchJobs, dismiss };
}
