import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../api/client';
import type { SachbearbeiterProfile } from '../types/extraction';

export function useSachbearbeiter() {
  const [profiles, setProfiles] = useState<SachbearbeiterProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProfiles = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/sachbearbeiter');
      setProfiles(data);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const createProfile = useCallback(async (profile: Omit<SachbearbeiterProfile, 'id'>) => {
    const { data } = await apiClient.post('/sachbearbeiter', profile);
    setProfiles(prev => [...prev, data]);
    return data as SachbearbeiterProfile;
  }, []);

  const updateProfile = useCallback(async (id: number, updates: Partial<SachbearbeiterProfile>) => {
    const { data } = await apiClient.put(`/sachbearbeiter/${id}`, updates);
    setProfiles(prev => prev.map(p => p.id === id ? data : p));
    return data as SachbearbeiterProfile;
  }, []);

  const deleteProfile = useCallback(async (id: number) => {
    await apiClient.delete(`/sachbearbeiter/${id}`);
    setProfiles(prev => prev.filter(p => p.id !== id));
  }, []);

  return { profiles, loading, createProfile, updateProfile, deleteProfile, refetch: fetchProfiles };
}
