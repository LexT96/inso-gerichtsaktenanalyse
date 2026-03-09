import './env';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config';
import { initDatabase, closeDatabase, getDb } from './db/database';
import { logger } from './utils/logger';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import extractionRoutes from './routes/extraction';
import historyRoutes from './routes/history';
import bcrypt from 'bcrypt';

const app = express();

// Security
app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
app.use(express.json());

// Trust proxy for rate limiter behind Docker/nginx
app.set('trust proxy', 1);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/extract', extractionRoutes);
app.use('/api/history', historyRoutes);

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

  // Seed admin user if not exists
  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(config.DEFAULT_ADMIN_USERNAME);
  if (!existing) {
    const hash = await bcrypt.hash(config.DEFAULT_ADMIN_PASSWORD, 12);
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
    ).run(config.DEFAULT_ADMIN_USERNAME, hash, 'Administrator', 'admin');
    logger.info(`Admin-Benutzer "${config.DEFAULT_ADMIN_USERNAME}" erstellt`);
  }

  app.listen(config.PORT, () => {
    logger.info(`Server gestartet auf Port ${config.PORT}`);
  });
}

// Graceful shutdown
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
