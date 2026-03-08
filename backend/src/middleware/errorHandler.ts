import { Request, Response, NextFunction } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  logger.error('Unbehandeter Fehler', {
    message: err.message,
    stack: err.stack,
    name: err.name,
  });

  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: 'Datei zu groß. Maximal 50 MB erlaubt.' });
      return;
    }
    res.status(400).json({ error: `Upload-Fehler: ${err.message}` });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Ungültige Eingabedaten',
      details: err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', '),
    });
    return;
  }

  if (err.message === 'Nur PDF-Dateien werden akzeptiert.') {
    res.status(400).json({ error: err.message });
    return;
  }

  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) {
      res.status(429).json({
        error: 'KI-Rate-Limit erreicht. Bitte warte kurz und versuche es erneut.',
      });
      return;
    }
    if (err.status === 401 || err.status === 403) {
      res.status(502).json({ error: 'KI-API-Authentifizierung fehlgeschlagen. Bitte API-Key prüfen.' });
      return;
    }
    res.status(502).json({ error: `KI-API-Fehler: ${err.message}` });
    return;
  }

  res.status(500).json({ error: 'Interner Serverfehler' });
}
