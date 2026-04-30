# Akten-Teilen zwischen Sachbearbeitern — Design

**Datum:** 2026-04-30
**Status:** Spec — wartet auf User-Review

## Zielbild

Ein Owner-Sachbearbeiter kann eine Akte mit beliebig vielen anderen aktiven Sachbearbeitern desselben Instanz teilen. Mitbearbeiter dürfen voll editieren (Felder, Anschreiben, Gutachten, Nachreichungen). Owner-exklusiv bleiben: Löschen (Art. 17 DSGVO), `.iae`-Export, Re-Share/Revoke. Jeder Zugriff eines Mitbearbeiters wird auditiert. Architektur lässt ein späteres Team-Modell zu, ohne das Schema zu refactoren.

## Entscheidungen aus dem Brainstorming

1. **Sharing-Modell:** Co-Bearbeitung (B). Team-Modell (D) potenziell später.
2. **Owner-Exklusivität:** Owner-only sind Delete (Art. 17), `.iae`-Export, Share gewähren/entziehen.
3. **Invite-Flow:** direkt (Owner picked aus Dropdown aktiver User), kein Annahme-Schritt.
4. **Audit-Tiefe:** Full-Audit — jeder Read und Edit eines Mitbearbeiters wird geloggt; Owner-Reads nicht.
5. **Architektur:** Dedizierte Tabelle `extraction_shares`, `extractions.user_id` bleibt der Owner.

Bewusst herausgehalten (YAGNI):
- Read-only-Shares — Co-Edit ist Co-Edit
- Annahme-Workflow — alle TBS-User sind §203-vereidigt
- Token/Magic-Link-Shares — `.iae`-Export deckt Cross-Instance ab
- Per-Feld-Permissions — keine realen Use-Cases
- Auto-Expire auf Shares — Owner kann jederzeit revoken

## Schema

Migration `backend/src/db/migrations/008_add_extraction_shares.sql`:

```sql
CREATE TABLE IF NOT EXISTS extraction_shares (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_id INTEGER NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  granted_by    INTEGER NOT NULL REFERENCES users(id),
  granted_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(extraction_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_extraction_shares_user
  ON extraction_shares(user_id);
CREATE INDEX IF NOT EXISTS idx_extraction_shares_extraction
  ON extraction_shares(extraction_id);
```

Begründung:
- `extractions.user_id` bleibt der Owner — keine bestehende Query muss geändert werden, wenn sie nur Owner-Akten betrachtet.
- Kein `role`-Feld → implizit nur "collaborator". Owner sitzt in `extractions.user_id`, Admin in `users.role`. Erweiterung später trivial via `ALTER TABLE`.
- `ON DELETE CASCADE` ist Vorsicht: aktueller Code macht nur Soft-Delete (`status='deleted_art17'`), aber falls je ein hartes Delete kommt, wird sauber abgeräumt.
- `UNIQUE(extraction_id, user_id)` → kein Doppel-Share möglich.

Späteres Team-Modell (D) addiert eine separate Tabelle `team_extraction_shares (extraction_id, team_id)` plus `team_members (team_id, user_id)`. Auth-Helper expandiert um Team-Membership-Check. **Kein Refactor an `extraction_shares`.**

## Authorization Layer

Neuer Helper `backend/src/utils/extractionAccess.ts`:

```ts
export type AccessRole = 'owner' | 'collaborator' | 'admin';

export interface ExtractionAccess {
  extractionId: number;
  role: AccessRole;
  ownerId: number;
}

export function getExtractionAccess(
  extractionId: number,
  userId: number,
  userRole: 'admin' | 'user'
): ExtractionAccess | null;

export function accessibleExtractionIds(
  userId: number,
  userRole: 'admin' | 'user'
): { ownedIds: number[]; sharedIds: number[] };
```

Neue Middleware `backend/src/middleware/extractionAccess.ts`:

```ts
export function requireExtractionAccess(opts?: { ownerOnly?: boolean }): RequestHandler;
```

Verhalten:
- Lädt einmal pro Request den Access-Record und hängt ihn an `req.access`.
- 404 sowohl für "nicht existent" als auch "kein Zugriff" — Info-Leak-Schutz gegen Akten-ID-Enumeration.
- `ownerOnly: true` → 403 mit `code: 'OWNER_ONLY'` für Mitbearbeiter (User kennt Akten-Existenz schon legitim).
- Admin verhält sich überall wie heute = sieht und darf alles, auch ownerOnly.
- Audit-Hook über `res.on('finish')`: bei `role==='collaborator'` und 2xx → Insert in `audit_log` (`share_read` für GET, `share_edit` für POST/PUT/PATCH/DELETE). Owner-Reads nicht geloggt. Admin-Operations loggen mit `role:'admin'` im details-JSON.

Routes werden umgestellt von Inline-`WHERE user_id = ?` auf `requireExtractionAccess(...)`.

## API-Surface

### Neu

```
GET    /api/extractions/:id/shares
       Owner+Admin → 200 [{ userId, displayName, username, grantedBy, grantedAt }]
       sonst       → 403 OWNER_ONLY

POST   /api/extractions/:id/shares
       Body: { userId: number }
       Owner+Admin → 201 { userId, displayName, grantedAt }
       400 wenn userId === ownerId (self-share)
       404 wenn User nicht existent oder inactive
       409 wenn bereits geteilt

DELETE /api/extractions/:id/shares/:userId
       Owner+Admin → 204
       404 wenn kein Share existiert

GET    /api/users/share-candidates
       authMiddleware → 200 [{ userId, displayName, username }]
       (alle active=1, exklusive aktuellem User)
```

`/api/users/share-candidates` lebt in neuer Datei `backend/src/routes/users.ts` (Single-Responsibility — `auth.ts` ist für Auth-Flows).

### Bestehende Routes — Auth-Anpassung

| Endpoint | Middleware |
|---|---|
| `GET /api/history` | erweitert um Shared-Akten via UNION (siehe unten) |
| `GET /api/history/:id` | `requireExtractionAccess()` |
| `GET /api/history/:id/pdf` | `requireExtractionAccess()` |
| `POST /api/history/:id/export` | `requireExtractionAccess({ ownerOnly: true })` |
| `DELETE /api/history/:id` | `requireExtractionAccess({ ownerOnly: true })` + `DELETE FROM extraction_shares WHERE extraction_id = ?` |
| `GET/POST /api/extractions/:id/documents/...` | `requireExtractionAccess()` |
| `POST /api/field-update/:id/...` | `requireExtractionAccess()` |
| `POST /api/generate-letter/:id/:typ` | `requireExtractionAccess()` |
| `POST /api/generate-gutachten/:id/prepare` | `requireExtractionAccess()` |
| `POST /api/generate-gutachten/:id/generate` | `requireExtractionAccess()` |

Owner-only-Begründung:
- **Delete (Art. 17)** — DSGVO-Verantwortung sitzt beim Eigentümer.
- **Export `.iae`** — Daten verlassen das System; Owner entscheidet.
- **Share gewähren/entziehen** — Owner-Hoheit aus Brainstorming-Frage 2.

History-Listing-Response kriegt zwei neue Felder pro Item:

```ts
{
  ...,
  accessRole: 'owner' | 'collaborator',
  ownerName?: string  // nur bei accessRole === 'collaborator'
}
```

SQL:

```sql
SELECT e.*, 'owner' AS access_role, NULL AS owner_name
FROM extractions e
WHERE e.user_id = ?
UNION ALL
SELECT e.*, 'collaborator' AS access_role, u.display_name AS owner_name
FROM extractions e
JOIN extraction_shares s ON s.extraction_id = e.id
JOIN users u ON u.id = e.user_id
WHERE s.user_id = ?
ORDER BY created_at DESC LIMIT 100;
```

## UI/UX

- **"Teilen"-Button** im Akte-Header (Übersicht-Tab oben rechts), nur für Owner+Admin sichtbar.
- **Share-Modal:**
  - Aktuelle Empfänger als Liste mit Revoke-X
  - Searchable Dropdown gegen `/api/users/share-candidates`
  - "Teilen mit"-Button → POST → Liste aktualisiert sich, Toast "Geteilt mit X"
- **History-Page:** Pill `Geteilt von <OwnerName>` auf Collaborator-Zeilen, leichte Hintergrund-Tönung zur Abgrenzung.
- **Akte-Detail-Banner** (für Collaborator): unaufdringlicher Banner oben "Co-Bearbeitung — Eigentümer: <Owner>".
- **Zugriffsprotokoll-Tab** (Owner+Admin) auf der Akte-Seite: chronologische Liste aller `share_read`/`share_edit`/`share_granted`/`share_revoked` Events für diese Akte. Owner hat Transparenz wer wann was angefasst (BRAO-Sichtbarkeit).

Frontend-Files (neu/geändert):
- neu: `frontend/src/components/ShareModal.tsx`
- neu: `frontend/src/components/AccessLogTab.tsx`
- neu: `frontend/src/components/CollaboratorBanner.tsx`
- neu: `frontend/src/api/shares.ts` (axios-Wrapper)
- geändert: `HistoryPage.tsx` (Pill + accessRole), `Dashboard`/Detail (Button, Banner, Tab)

## Audit-Schema

Tabelle `audit_log` bleibt unverändert. Neue `action`-Werte:

| action | details (JSON) | Trigger |
|---|---|---|
| `share_granted` | `{extractionId, recipientUserId, recipientName}` | POST /shares |
| `share_revoked` | `{extractionId, recipientUserId, recipientName}` | DELETE /shares/:userId |
| `share_read` | `{extractionId, method, path, role}` | Middleware: 2xx GET, role!=='owner' |
| `share_edit` | `{extractionId, method, path, role}` | Middleware: 2xx POST/PUT/PATCH/DELETE, role!=='owner' (außer Share-Routes selbst) |

Owner-Reads bleiben ungeloggt (wie heute). Admin-Aktivität wird als `share_read`/`share_edit` mit `role:'admin'` aufgezeichnet (BRAO-Transparenz auch für privilegierte Zugriffe).

## Security & Edge Cases

- **404 statt 403** für "nicht existent" und "kein Zugriff" — Akten-ID-Enumeration verhindert. 403 nur bei `OWNER_ONLY`.
- **Self-Share** → 400 wenn `userId === ownerId`.
- **Doppel-Share** → 409 mit klarer Message.
- **Inactive User als Empfänger** → 404 (filter `active=1` im Lookup).
- **Inactive User mit existierendem Share** → Eintrag bleibt, Auth-Middleware verweigert via Login-Block. Kein Cleanup-Job nötig.
- **Owner Art-17-Delete** → parallel `DELETE FROM extraction_shares WHERE extraction_id = ?`, Mitbearbeiter verlieren Zugriff sofort.
- **Revocation-Race** → jeder Request prüft frisch; in-flight Reads dürfen durchlaufen.
- **Cross-Instance** bewusst nicht abgedeckt → `.iae`-Export bleibt der Weg.
- **§203 StGB / BRAO** → Empfänger sind ausschließlich aktive TBS-User (vereidigt); jeder Zugriff auditiert.
- **Audit-Volumen** → ~5K Einträge/Tag bei aktiver Nutzung trivial für SQLite WAL. Cleanup-Job nach BRAO-Aufbewahrung (typ. 5J nach Mandatsende) als spätere Option dokumentiert, nicht Bestandteil dieses Sprints.
- **Rate-Limit** → Share-Endpoints binden in den existierenden `express-rate-limit`-Block ein.

## Migration & Rollout

- Eine Migration `008_add_extraction_shares.sql`, läuft beim Server-Start (existing pattern in `backend/src/db/database.ts`).
- Backward-compatible: leere Tabelle = alles verhält sich wie heute.
- Kein Backfill nötig.
- Build: Backend + Frontend im selben `docker compose build`.
- Roll-out-Pfad: Feature-Branch → PR `dev` → Promote auf demo via GH Actions Workflow → manuelle Verifikation auf demo → PR `dev → main` (squash) → prod auto-deploy.

## Test-Plan

Backend (`vitest`):
- `extractionAccess.test.ts` — Owner / Collaborator / Admin / Outsider Permutationen
- `requireExtractionAccess.middleware.test.ts` — 404/403/200, ownerOnly-Flag, audit-write
- `shares.routes.test.ts` — Grant, Revoke, Self-Share-400, Duplicate-409, Inactive-User-404, Owner-only enforcement
- `history.routes.test.ts` — UNION-Listing zeigt owned + shared, accessRole/ownerName korrekt
- Regressionen: bestehende `history`/`field-update`/`generate-letter`/`generate-gutachten` Tests dürfen nicht brechen (Owner-Pfad bleibt identisch)

Manuell (auf demo):
- 2 Test-User (alice owner, bob collaborator)
- alice teilt mit bob → bob sieht Akte in Historie mit Pill
- bob editiert ein Feld → audit_log enthält `share_edit`
- bob versucht Delete → 403 OWNER_ONLY
- alice revoked → bob sieht Akte nicht mehr (next request)
- alice deletet (Art. 17) → bob sieht Akte nicht mehr, audit-Trail bleibt

## Out-of-Scope (für späteren Sprint)

- Team-Modell (D) — Architektur lässt es zu, aber kein Code in diesem Sprint.
- Audit-Cleanup-Job nach BRAO-Aufbewahrung.
- Read-only-Share-Variante.
- Notifications (Email/in-app) bei neuem Share.
