---
name: require-type-sync
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: shared/types/extraction\.ts$
---

**TYPES SYNC REQUIRED!**

You just edited `shared/types/extraction.ts`. You MUST also update `backend/src/types/extraction.ts` to match.

These two files must stay in sync — the backend duplicates shared types to avoid `rootDir` issues with tsc. If they diverge, the backend will have different types than the frontend, causing silent data mismatches.

**Action required:**
1. Copy the same type changes to `backend/src/types/extraction.ts`
2. Also update `frontend/src/types/extraction.ts` re-exports if new types were added
3. Run `cd backend && npx tsc --noEmit` to verify
