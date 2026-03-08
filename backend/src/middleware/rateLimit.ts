import rateLimit from 'express-rate-limit';
import { config } from '../config';

export const extractionRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 Stunde
  max: config.RATE_LIMIT_EXTRACTIONS_PER_HOUR,
  message: {
    error: `Maximale Anzahl Extraktionen pro Stunde (${config.RATE_LIMIT_EXTRACTIONS_PER_HOUR}) erreicht. Bitte warten.`,
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.userId?.toString() || req.ip || 'unknown';
  },
});

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 20,
  message: { error: 'Zu viele Anmeldeversuche. Bitte warten.' },
  standardHeaders: true,
  legacyHeaders: false,
});
