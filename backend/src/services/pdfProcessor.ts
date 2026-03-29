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

    // Detect and remove watermarks (text that appears on >80% of pages)
    return removeWatermarks(pageTexts);
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
    return removeWatermarks(fallback);
  }
}

/**
 * Detect and remove watermark text from page texts.
 *
 * Watermarks are identified as lines/phrases that appear on a high percentage
 * of pages (>80%). Common examples: "Alexander Lamberty 18.12.2025",
 * "VERTRAULICH", "ENTWURF", diagonal name+date stamps.
 *
 * Approach:
 * 1. Split each page into lines
 * 2. Count how many pages each unique line appears on
 * 3. Lines appearing on >80% of pages are watermark candidates
 * 4. Remove those lines from all pages
 */
function removeWatermarks(pageTexts: string[]): string[] {
  if (pageTexts.length < 3) return pageTexts; // Too few pages to detect patterns

  const threshold = Math.ceil(pageTexts.length * 0.8);

  // === Strategy 1: Whole-line watermarks ===
  const linePageCount = new Map<string, number>();
  for (const pageText of pageTexts) {
    const uniqueLines = new Set(
      pageText.split('\n').map(l => l.trim()).filter(l => l.length >= 3 && l.length <= 200)
    );
    for (const line of uniqueLines) {
      linePageCount.set(line, (linePageCount.get(line) || 0) + 1);
    }
  }

  const watermarkLines = new Set<string>();
  for (const [line, count] of linePageCount) {
    if (count >= threshold) {
      if (/^\d+$/.test(line)) continue;
      if (/^Seite \d+/.test(line)) continue;
      if (/^\d+ von \d+$/.test(line)) continue;
      watermarkLines.add(line);
    }
  }

  // === Strategy 2: Suffix watermarks (appended to end of last line on each page) ===
  // Watermarks like "Alexander Lamberty 18.12.2025" are often appended to existing text
  // Detect by finding common suffixes across pages
  const watermarkSuffixes: string[] = [];
  const suffixCandidates = new Map<string, number>();

  for (const pageText of pageTexts) {
    const lines = pageText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) continue;
    const lastLine = lines[lines.length - 1];

    // Try to find a date-name pattern at the end: "Name Name DD.MM.YYYY" or "DD.MM.YYYY"
    // Common watermark patterns: "Alexander Lamberty 18.12.2025", "Zu 4 Alexander Lamberty 18.12.2025"
    const dateNameMatch = lastLine.match(/\s([A-ZÄÖÜ][a-zäöüß]+ [A-ZÄÖÜ][a-zäöüß]+ \d{2}\.\d{2}\.\d{4})$/);
    if (dateNameMatch) {
      const suffix = dateNameMatch[1];
      suffixCandidates.set(suffix, (suffixCandidates.get(suffix) || 0) + 1);
    }
  }

  for (const [suffix, count] of suffixCandidates) {
    if (count >= threshold) {
      watermarkSuffixes.push(suffix);
    }
  }

  if (watermarkLines.size === 0 && watermarkSuffixes.length === 0) return pageTexts;

  const allPatterns = [...watermarkLines, ...watermarkSuffixes];
  logger.info('Wasserzeichen erkannt und entfernt', {
    wholeLines: watermarkLines.size,
    suffixes: watermarkSuffixes.length,
    patterns: allPatterns.slice(0, 5),
    pagesAffected: pageTexts.length,
  });

  // Remove watermarks from all pages
  return pageTexts.map(pageText => {
    let text = pageText;

    // Remove whole-line watermarks
    if (watermarkLines.size > 0) {
      const lines = text.split('\n');
      text = lines.filter(line => !watermarkLines.has(line.trim())).join('\n');
    }

    // Remove suffix watermarks (from end of lines)
    for (const suffix of watermarkSuffixes) {
      // Escape for regex
      const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp('\\s*' + escaped + '\\s*$', 'gm'), '');
    }

    return text.trim();
  });
}
