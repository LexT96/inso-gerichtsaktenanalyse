import { createContext, useContext } from 'react';

interface ExtractionContextType {
  extractionId: number | null;
}

const ExtractionContext = createContext<ExtractionContextType>({ extractionId: null });

export const ExtractionProvider = ExtractionContext.Provider;

export function useExtractionId(): number | null {
  return useContext(ExtractionContext).extractionId;
}
