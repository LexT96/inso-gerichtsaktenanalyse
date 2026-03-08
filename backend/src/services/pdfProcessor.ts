import pdfParse from 'pdf-parse';
import { PDFDocument } from 'pdf-lib';
import { logger } from '../utils/logger';

export interface PdfProcessResult {
  text: string;
  pageCount: number;
}

export async function extractTextFromPdf(buffer: Buffer): Promise<PdfProcessResult> {
  try {
    const data = await pdfParse(buffer);
    logger.info('PDF-Text extrahiert', { pages: data.numpages, textLength: data.text.length });
    return { text: data.text, pageCount: data.numpages };
  } catch (error) {
    logger.error('PDF-Text-Extraktion fehlgeschlagen', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('PDF konnte nicht gelesen werden.');
  }
}

export async function getPageCount(buffer: Buffer): Promise<number> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

/**
 * Extracts text per page using pdf-parse's pagerender callback.
 * Returns an array where each element is the text of one page.
 * Falls back to splitting the full text evenly if pagerender fails.
 */
export async function extractTextPerPage(buffer: Buffer): Promise<string[]> {
  const pageTexts: string[] = [];

  try {
    await pdfParse(buffer, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pagerender: (pageData: any): Promise<string> => {
        return pageData.getTextContent({ normalizeWhitespace: true })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((content: { items: Array<{ str: string; hasEOL?: boolean }> }) => {
            let text = '';
            for (const item of content.items) {
              text += item.str;
              text += item.hasEOL ? '\n' : ' ';
            }
            pageTexts.push(text.trim());
            return text;
          });
      },
    });

    logger.info('PDF: Text pro Seite extrahiert', { pages: pageTexts.length });
    return pageTexts;
  } catch (error) {
    // Fallback: full text split evenly across estimated page count
    logger.warn('Per-Seite-Extraktion fehlgeschlagen, verwende Volltext-Fallback', {
      error: error instanceof Error ? error.message : String(error),
    });

    const { text, pageCount } = await extractTextFromPdf(buffer);
    const charsPerPage = Math.ceil(text.length / Math.max(pageCount, 1));
    const fallback: string[] = [];
    for (let i = 0; i < text.length; i += charsPerPage) {
      fallback.push(text.slice(i, i + charsPerPage));
    }
    return fallback;
  }
}
