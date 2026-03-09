import { createContext, useContext } from 'react';

export interface HighlightRequest {
  page: number;
  text: string;
}

interface PdfContextType {
  goToPage: (page: number) => void;
  goToPageAndHighlight: (page: number, text?: string) => void;
  currentPage: number;
  totalPages: number;
  highlightRequest: HighlightRequest | null;
  clearHighlight: () => void;
}

export const PdfContext = createContext<PdfContextType>({
  goToPage: () => {},
  goToPageAndHighlight: () => {},
  currentPage: 1,
  totalPages: 0,
  highlightRequest: null,
  clearHighlight: () => {},
});

export function usePdf() {
  return useContext(PdfContext);
}
