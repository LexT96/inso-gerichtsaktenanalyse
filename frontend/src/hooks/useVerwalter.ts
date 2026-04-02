import { useState, useEffect, useCallback } from 'react';
import { apiClient } from '../api/client';
import type { VerwalterProfile } from '../types/extraction';

export function useVerwalter() {
  const [profiles, setProfiles] = useState<VerwalterProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchProfiles = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/verwalter');
      setProfiles(data);
    } catch {
      // Silently fail — profiles just won't be available
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const createProfile = useCallback(async (profile: Omit<VerwalterProfile, 'id'>) => {
    const { data } = await apiClient.post('/verwalter', profile);
    setProfiles(prev => [...prev, data]);
    return data as VerwalterProfile;
  }, []);

  const updateProfile = useCallback(async (id: number, updates: Partial<VerwalterProfile>) => {
    const { data } = await apiClient.put(`/verwalter/${id}`, updates);
    setProfiles(prev => prev.map(p => p.id === id ? data : p));
    return data as VerwalterProfile;
  }, []);

  const deleteProfile = useCallback(async (id: number) => {
    await apiClient.delete(`/verwalter/${id}`);
    setProfiles(prev => prev.filter(p => p.id !== id));
  }, []);

  return { profiles, loading, createProfile, updateProfile, deleteProfile, refetch: fetchProfiles };
}
