# Admin Monitoring Dashboard

## Purpose

Allow the KlareProzesse admin to monitor how TBS users are using the extraction tool: see all extractions across all users, spot failures, check usage patterns. Accessible as an extra page in the existing app, visible only to admin role.

## Safety Constraint

All changes are additive. No modifications to existing routes, queries, components, or database schema. New files only, plus minimal additions to Header (admin link) and App router (new route).

## Backend

### Middleware: `requireAdmin`

New file `backend/src/middleware/adminAuth.ts`. Wraps `authMiddleware`, then checks `req.user.role === 'admin'`. Returns 403 if not admin. Applied to all `/api/admin/*` routes.

### Routes: `backend/src/routes/admin.ts`

**`GET /api/admin/dashboard`**

Returns aggregated stats from the extractions and users tables:

```json
{
  "today": { "extractions": 12, "completed": 10, "failed": 2, "activeUsers": 3 },
  "week": { "extractions": 45, "completed": 40, "failed": 5, "activeUsers": 4 },
  "total": { "extractions": 120, "users": 6 },
  "recentFailures": [
    { "id": 41, "filename": "Akte.pdf", "username": "user@tbs.de", "displayName": "Max", "errorMessage": "timeout", "createdAt": "..." }
  ]
}
```

All queries are simple COUNT/GROUP BY on existing tables. No new indexes needed — extractions table is small (hundreds of rows max).

**`GET /api/admin/extractions`**

Paginated list of all extractions across all users. Query params:
- `page` (default 1), `limit` (default 50)
- `status` filter (optional): completed, failed, processing, expired
- `user_id` filter (optional)

Returns: `{ extractions: [...], total: number, page: number, totalPages: number }`

Each extraction includes: id, filename, file_size, status, error_message, stats_found, stats_missing, stats_letters_ready, processing_time_ms, created_at, user (username, display_name).

JOIN with users table on user_id.

**`GET /api/admin/users`**

List of all users with usage stats:
- id, username, display_name, role, active, created_at
- extraction_count (COUNT from extractions)
- last_login (MAX created_at from audit_log WHERE action = 'login')

Single query with LEFT JOINs.

### Route Registration

Add `app.use('/api/admin', adminRouter)` in `backend/src/index.ts` — one line addition after existing route registrations.

## Frontend

### AdminPage (`frontend/src/pages/AdminPage.tsx`)

Single page with two sections:

**Dashboard cards (top):** 4 cards in a row — Extractions Today, Failures Today (red if > 0), Active Users Today, Avg Processing Time. Below cards: week stats as smaller text. Below that: recent failures list (last 5) with clickable links.

**Extractions table (bottom):** Full-width table with columns: Status badge, Filename, User, Found/Missing, Processing Time, Date. Filter bar above with status dropdown and user dropdown. Pagination at bottom. Clicking a row navigates to `/dashboard?id={extractionId}` to reuse the existing extraction detail view.

### Header change

In `frontend/src/components/layout/Header.tsx`: add an "Admin" link next to existing navigation, conditionally rendered when `user.role === 'admin'`. One line addition inside existing JSX.

### Router change

In the app router: add `<Route path="/admin" element={<AdminPage />} />`. One line.

### Styling

Reuse existing design tokens: bg-surface, border-border, text-text, accent color. Same font-mono style. Status badges reuse the same pattern from HistoryPage.

## What We're NOT Building

- No user management (create/edit/disable)
- No audit log viewer
- No real-time updates (websocket)
- No email alerts
- No new database tables or columns
- No modifications to existing endpoints
