import './env';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { initDatabase, closeDatabase, getDb, cleanupExpiredExtractions, encryptExistingResults } from './db/database';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import extractionRoutes from './routes/extraction';
import historyRoutes from './routes/history';
import generateLetterRoutes from './routes/generateLetter';
import generateGutachtenRoutes from './routes/generateGutachten';
import fieldUpdateRoutes from './routes/fieldUpdate';
import bcrypt from 'bcrypt';

const app = express();

// Security
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Trust only loopback proxies (Docker/Traefik) — prevents X-Forwarded-For spoofing
app.set('trust proxy', 'loopback');

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/extract', extractionRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/generate-letter', generateLetterRoutes);
app.use('/api/generate-gutachten', generateGutachtenRoutes);
app.use('/api/extractions', fieldUpdateRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

// Startup
async function start(): Promise<void> {
  // Initialize DB
  initDatabase(config.DATABASE_PATH);

  // Seed admin user if not exists (only in local auth mode)
  const db = getDb();

  // Add azure_oid column if it doesn't exist (for Entra ID SSO support)
  try {
    db.prepare("SELECT azure_oid FROM users LIMIT 1").get();
  } catch {
    db.prepare("ALTER TABLE users ADD COLUMN azure_oid TEXT").run();
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_azure_oid ON users(azure_oid) WHERE azure_oid IS NOT NULL").run();
    logger.info('Spalte azure_oid zu users-Tabelle hinzugefuegt');
  }

  const isEntraEnabled = Boolean(config.AZURE_TENANT_ID && config.AZURE_CLIENT_ID);
  if (!isEntraEnabled && config.DEFAULT_ADMIN_PASSWORD) {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(config.DEFAULT_ADMIN_USERNAME);
    if (!existing) {
      const hash = await bcrypt.hash(config.DEFAULT_ADMIN_PASSWORD, 12);
      db.prepare(
        'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
      ).run(config.DEFAULT_ADMIN_USERNAME, hash, 'Administrator', 'admin');
      logger.info(`Admin-Benutzer "${config.DEFAULT_ADMIN_USERNAME}" erstellt`);
    }
  }

  // Encrypt any legacy unencrypted result_json rows
  encryptExistingResults(config.DB_ENCRYPTION_KEY);

  // Data retention: cleanup expired extractions on startup and every hour
  cleanupExpiredExtractions(config.DATA_RETENTION_HOURS);
  setInterval(() => cleanupExpiredExtractions(config.DATA_RETENTION_HOURS), 60 * 60 * 1000);

  app.listen(config.PORT, () => {
    logger.info(`Server gestartet auf Port ${config.PORT}`);
  });
}

// Graceful shutdown
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason: String(reason), promise: String(promise) });
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM empfangen, fahre herunter…');
  closeDatabase();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT empfangen, fahre herunter…');
  closeDatabase();
  process.exit(0);
});

start().catch(err => {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error('Startfehler', { message: msg, stack });
  process.exit(1);
});
