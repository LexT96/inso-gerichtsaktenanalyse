---
name: require-type-sync-reverse
enabled: true
event: file
conditions:
  - field: file_path
    operator: regex_match
    pattern: backend/src/types/extraction\.ts$
---

**TYPES SYNC CHECK!**

You edited `backend/src/types/extraction.ts`. Verify that `shared/types/extraction.ts` has the same changes.

The canonical types live in `shared/types/extraction.ts`. If you're adding types here, they should also be in shared. If you're syncing FROM shared, this is fine.
