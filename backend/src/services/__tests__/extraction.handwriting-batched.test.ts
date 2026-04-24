import '../../env'; // Load .env before importing config
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chunk, runWithConcurrency } from '../extraction';
import type { ExtractionResult } from '../../types/extraction';

describe('chunk', () => {
  it('returns empty array for empty input', () => {
    expect(chunk([], 4)).toEqual([]);
  });
  it('returns single chunk when input shorter than size', () => {
    expect(chunk([1, 2], 4)).toEqual([[1, 2]]);
  });
  it('splits exact multiple', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
  it('splits uneven, last chunk shorter', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('throws on size <= 0', () => {
    expect(() => chunk([1, 2], 0)).toThrow();
  });
});

describe('runWithConcurrency', () => {
  it('returns results in input order', async () => {
    const tasks = [10, 20, 30, 40].map(n => () => Promise.resolve(n * 2));
    const out = await runWithConcurrency(tasks, 2);
    expect(out).toEqual([
      { status: 'fulfilled', value: 20 },
      { status: 'fulfilled', value: 40 },
      { status: 'fulfilled', value: 60 },
      { status: 'fulfilled', value: 80 },
    ]);
  });

  it('captures rejections via allSettled semantics', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve('c'),
    ];
    const out = await runWithConcurrency(tasks, 2);
    expect(out[0]).toEqual({ status: 'fulfilled', value: 'a' });
    expect(out[1].status).toBe('rejected');
    expect(out[2]).toEqual({ status: 'fulfilled', value: 'c' });
  });

  it('respects concurrency cap (max in-flight = limit)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const make = () => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return 1;
    };
    const tasks = Array.from({ length: 6 }, make);
    await runWithConcurrency(tasks, 2);
    expect(maxInFlight).toBe(2);
  });
});

// ─── Integration tests: image-batched mode ───────────────────────────────────

vi.mock('../anthropic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../anthropic')>();
  return {
    ...actual,
    createAnthropicMessage: vi.fn(),
    callWithRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
  };
});
vi.mock('../../utils/pageImageRenderer', () => ({
  renderPagesToJpeg: vi.fn(),
}));
vi.mock('../extractionProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../extractionProvider')>();
  return {
    ...actual,
    anthropicSupportsNativePdf: () => false, // force image-batched mode
    detectProvider: () => 'langdock' as const,
  };
});

describe('extractHandwrittenFormFields image-batched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges fields from successful batches and skips failed ones', async () => {
    const { extractHandwrittenFormFields } = await import('../extraction');
    const { createAnthropicMessage } = await import('../anthropic');
    const { renderPagesToJpeg } = await import('../../utils/pageImageRenderer');

    // Render returns 5 pages of dummy base64
    (renderPagesToJpeg as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([0, 1, 2, 3, 4].map(i => [i, 'BASE64DATA']))
    );

    // 5 pages -> chunk(_, 4) -> two batches: [0,1,2,3] and [4]
    // Both batches succeed; first returns telefon, second returns email
    let callCount = 0;
    (createAnthropicMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"telefon":{"wert":"06545 9121110","quelle":"Seite 1"}}' }],
        };
      }
      if (callCount === 2) {
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"email":{"wert":"info@example.de","quelle":"Seite 5"}}' }],
        };
      }
      throw new Error('unexpected batch');
    });

    // Minimal Schuldner fixture — only the fields touched by the test need to exist.
    const result = {
      schuldner: {
        telefon: { wert: '', quelle: '' },
        email: { wert: '', quelle: '' },
      },
    } as { schuldner: { telefon: { wert: string; quelle: string }; email: { wert: string; quelle: string } } };

    // pageTexts contains FRAGEBOGEN markers on pages 0-4 to trigger detection
    const pageTexts = ['Fragebogen', 'Fragebogen', 'Fragebogen', 'Fragebogen', 'Fragebogen'];
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF dummy

    await extractHandwrittenFormFields(result as unknown as ExtractionResult, pdfBuffer, pageTexts);

    expect(callCount).toBe(2);
    expect(result.schuldner.telefon.wert).toBe('06545 9121110');
    expect(result.schuldner.email.wert).toBe('info@example.de');
  });

  it('survives a partial batch failure', async () => {
    const { extractHandwrittenFormFields } = await import('../extraction');
    const { createAnthropicMessage } = await import('../anthropic');
    const { renderPagesToJpeg } = await import('../../utils/pageImageRenderer');

    (renderPagesToJpeg as ReturnType<typeof vi.fn>).mockReturnValue(
      new Map([0, 1, 2, 3, 4].map(i => [i, 'BASE64DATA']))
    );

    let callCount = 0;
    (createAnthropicMessage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"telefon":{"wert":"06545 9121110","quelle":"Seite 1"}}' }],
        };
      }
      throw new Error('simulated batch failure');
    });

    const result = {
      schuldner: {
        telefon: { wert: '', quelle: '' },
        email: { wert: '', quelle: '' },
      },
    } as { schuldner: { telefon: { wert: string; quelle: string }; email: { wert: string; quelle: string } } };
    const pageTexts = ['Fragebogen', 'Fragebogen', 'Fragebogen', 'Fragebogen', 'Fragebogen'];
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46]);

    await extractHandwrittenFormFields(result as unknown as ExtractionResult, pdfBuffer, pageTexts);

    // Successful batch's value is merged
    expect(result.schuldner.telefon.wert).toBe('06545 9121110');
    // Failed batch's value did NOT make it through
    expect(result.schuldner.email.wert).toBe('');
  });
});

describe('runHandwritingGapFill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('probes each critical field that is empty after main pass', async () => {
    const { runHandwritingGapFill } = await import('../handwritingGapFill');
    const { createAnthropicMessage } = await import('../anthropic');

    // All 6 critical fields empty -> should fire a probe per critical field
    const result = {
      schuldner: {
        telefon: { wert: '', quelle: '' },
        email: { wert: '', quelle: '' },
        betriebsstaette_adresse: { wert: '', quelle: '' },
        steuerberater: { wert: '', quelle: '' },
        finanzamt: { wert: '', quelle: '' },
        firma: { wert: '', quelle: '' },
      },
    };

    (createAnthropicMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{}' }],
    });

    const imagesByPage = new Map([[0, 'BASE64'], [1, 'BASE64']]);
    const outcome = await runHandwritingGapFill({
      result: result as unknown as import('../../types/extraction').ExtractionResult,
      pageIndices: [0, 1],
      imagesByPage,
    });

    expect(outcome.probesSent).toBe(6);
    expect(outcome.probesFailed).toBe(0);
    expect(outcome.gapsFilled).toBe(0);
  });

  it('skips critical fields that already have a value', async () => {
    const { runHandwritingGapFill } = await import('../handwritingGapFill');
    const { createAnthropicMessage } = await import('../anthropic');

    const result = {
      schuldner: {
        telefon: { wert: '0123 456', quelle: 'existing' },
        email: { wert: '', quelle: '' },
        betriebsstaette_adresse: { wert: '', quelle: '' },
        steuerberater: { wert: 'STB', quelle: 'existing' },
        finanzamt: { wert: '', quelle: '' },
        firma: { wert: 'Foo GmbH', quelle: 'existing' },
      },
    };

    (createAnthropicMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{}' }],
    });

    const outcome = await runHandwritingGapFill({
      result: result as unknown as import('../../types/extraction').ExtractionResult,
      pageIndices: [0],
      imagesByPage: new Map([[0, 'BASE64']]),
    });

    expect(outcome.probesSent).toBe(3);
  });

  it('merges a probe value into the result when found', async () => {
    const { runHandwritingGapFill } = await import('../handwritingGapFill');
    const { createAnthropicMessage } = await import('../anthropic');

    const result = {
      schuldner: {
        telefon: { wert: 'prefilled', quelle: '' },
        email: { wert: 'prefilled', quelle: '' },
        betriebsstaette_adresse: { wert: '', quelle: '' },
        steuerberater: { wert: 'prefilled', quelle: '' },
        finanzamt: { wert: 'prefilled', quelle: '' },
        firma: { wert: 'prefilled', quelle: '' },
      },
    };

    (createAnthropicMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"betriebsstaette_adresse":{"wert":"Zur Oberen Heide 11, 56865 Blankenrath","quelle":"Seite 1, Firmenanschrift"}}' }],
    });

    const outcome = await runHandwritingGapFill({
      result: result as unknown as import('../../types/extraction').ExtractionResult,
      pageIndices: [0],
      imagesByPage: new Map([[0, 'BASE64']]),
    });

    expect(outcome.probesSent).toBe(1);
    expect(outcome.gapsFilled).toBe(1);
    const r = result.schuldner.betriebsstaette_adresse;
    expect(r.wert).toBe('Zur Oberen Heide 11, 56865 Blankenrath');
    expect(r.quelle).toContain('Handschrift-Gap-Fill');
  });

  it('survives a probe that throws', async () => {
    const { runHandwritingGapFill } = await import('../handwritingGapFill');
    const { createAnthropicMessage } = await import('../anthropic');

    const result = {
      schuldner: {
        telefon: { wert: '', quelle: '' },
        email: { wert: 'prefilled', quelle: '' },
        betriebsstaette_adresse: { wert: 'prefilled', quelle: '' },
        steuerberater: { wert: 'prefilled', quelle: '' },
        finanzamt: { wert: 'prefilled', quelle: '' },
        firma: { wert: 'prefilled', quelle: '' },
      },
    };

    (createAnthropicMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    const outcome = await runHandwritingGapFill({
      result: result as unknown as import('../../types/extraction').ExtractionResult,
      pageIndices: [0],
      imagesByPage: new Map([[0, 'BASE64']]),
    });

    expect(outcome.probesSent).toBe(1);
    expect(outcome.probesFailed).toBe(1);
    expect(outcome.gapsFilled).toBe(0);
  });
});
