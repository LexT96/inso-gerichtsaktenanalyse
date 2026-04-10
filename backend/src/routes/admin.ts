import { Router, Request, Response } from 'express';
import { getDb } from '../db/database';
import { adminMiddleware } from '../middleware/adminAuth';

const router = Router();

// All admin routes require admin role
router.use(adminMiddleware);

// ─── Dashboard: aggregated stats ───

router.get('/dashboard', (_req: Request, res: Response): void => {
  const db = getDb();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 7);
  const weekISO = weekStart.toISOString();

  // Today stats
  const today = db.prepare(`
    SELECT
      COUNT(*) as extractions,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      COUNT(DISTINCT user_id) as activeUsers
    FROM extractions WHERE created_at >= ?
  `).get(todayISO) as { extractions: number; completed: number; failed: number; activeUsers: number };

  // Week stats
  const week = db.prepare(`
    SELECT
      COUNT(*) as extractions,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      COUNT(DISTINCT user_id) as activeUsers
    FROM extractions WHERE created_at >= ?
  `).get(weekISO) as { extractions: number; completed: number; failed: number; activeUsers: number };

  // Totals
  const total = db.prepare(`
    SELECT COUNT(*) as extractions FROM extractions
  `).get() as { extractions: number };
  const totalUsers = db.prepare(`
    SELECT COUNT(*) as users FROM users
  `).get() as { users: number };

  // Average processing time (completed, last 30 days)
  const avgTime = db.prepare(`
    SELECT AVG(processing_time_ms) as avg
    FROM extractions WHERE status = 'completed' AND created_at >= datetime('now', '-30 days')
  `).get() as { avg: number | null };

  // Recent failures (last 5)
  const recentFailures = db.prepare(`
    SELECT e.id, e.filename, e.error_message, e.created_at,
           u.username, u.display_name
    FROM extractions e
    LEFT JOIN users u ON e.user_id = u.id
    WHERE e.status = 'failed'
    ORDER BY e.created_at DESC LIMIT 5
  `).all() as Array<{
    id: number; filename: string; error_message: string | null; created_at: string;
    username: string; display_name: string;
  }>;

  res.json({
    today,
    week,
    total: { extractions: total.extractions, users: totalUsers.users },
    avgProcessingTimeMs: avgTime.avg ? Math.round(avgTime.avg) : null,
    recentFailures: recentFailures.map(f => ({
      id: f.id,
      filename: f.filename,
      errorMessage: f.error_message,
      createdAt: f.created_at,
      username: f.username,
      displayName: f.display_name,
    })),
  });
});

// ─── Extractions: paginated list across all users ───

router.get('/extractions', (req: Request, res: Response): void => {
  const db = getDb();

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const offset = (page - 1) * limit;

  const statusFilter = req.query.status as string | undefined;
  const userIdFilter = req.query.user_id ? parseInt(req.query.user_id as string) : undefined;

  let where = '1=1';
  const params: unknown[] = [];

  if (statusFilter && ['completed', 'failed', 'processing', 'expired', 'deleted_art17'].includes(statusFilter)) {
    where += ' AND e.status = ?';
    params.push(statusFilter);
  }
  if (userIdFilter) {
    where += ' AND e.user_id = ?';
    params.push(userIdFilter);
  }

  const totalRow = db.prepare(`
    SELECT COUNT(*) as total FROM extractions e WHERE ${where}
  `).get(...params) as { total: number };

  const extractions = db.prepare(`
    SELECT e.id, e.filename, e.file_size, e.status, e.error_message,
           e.stats_found, e.stats_missing, e.stats_letters_ready,
           e.processing_time_ms, e.created_at,
           u.username, u.display_name
    FROM extractions e
    LEFT JOIN users u ON e.user_id = u.id
    WHERE ${where}
    ORDER BY e.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    id: number; filename: string; file_size: number; status: string;
    error_message: string | null; stats_found: number | null; stats_missing: number | null;
    stats_letters_ready: number | null; processing_time_ms: number | null;
    created_at: string; username: string; display_name: string;
  }>;

  res.json({
    extractions: extractions.map(e => ({
      id: e.id,
      filename: e.filename,
      fileSize: e.file_size,
      status: e.status,
      errorMessage: e.error_message,
      statsFound: e.stats_found,
      statsMissing: e.stats_missing,
      statsLettersReady: e.stats_letters_ready,
      processingTimeMs: e.processing_time_ms,
      createdAt: e.created_at,
      username: e.username,
      displayName: e.display_name,
    })),
    total: totalRow.total,
    page,
    totalPages: Math.ceil(totalRow.total / limit),
  });
});

// ─── Users: list with usage stats ───

router.get('/users', (_req: Request, res: Response): void => {
  const db = getDb();

  const users = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at,
           (SELECT COUNT(*) FROM extractions e WHERE e.user_id = u.id) as extraction_count,
           (SELECT MAX(a.created_at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'login') as last_login
    FROM users u
    ORDER BY u.created_at DESC
  `).all() as Array<{
    id: number; username: string; display_name: string; role: string;
    active: number; created_at: string; extraction_count: number; last_login: string | null;
  }>;

  res.json({
    users: users.map(u => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      role: u.role,
      active: Boolean(u.active),
      createdAt: u.created_at,
      extractionCount: u.extraction_count,
      lastLogin: u.last_login,
    })),
  });
});

export default router;
