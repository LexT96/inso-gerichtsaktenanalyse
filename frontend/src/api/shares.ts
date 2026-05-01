import { apiClient } from './client';

export interface ExtractionShare {
  userId: number;
  displayName: string;
  username: string;
  grantedBy: number;
  grantedAt: string;
}

export interface ShareCandidate {
  userId: number;
  username: string;
  displayName: string;
}

export async function listShares(extractionId: number): Promise<ExtractionShare[]> {
  const res = await apiClient.get(`/extractions/${extractionId}/shares`);
  return res.data;
}

export async function grantShare(extractionId: number, userId: number): Promise<ExtractionShare> {
  const res = await apiClient.post(`/extractions/${extractionId}/shares`, { userId });
  return res.data;
}

export async function revokeShare(extractionId: number, userId: number): Promise<void> {
  await apiClient.delete(`/extractions/${extractionId}/shares/${userId}`);
}

export async function listShareCandidates(): Promise<ShareCandidate[]> {
  const res = await apiClient.get('/users/share-candidates');
  return res.data;
}
