# Hardening round 2: manual steps for the owner

Agents never apply anything to the hosted Supabase project or Railway (roadmap,
owner decision 2). Every step that needs the owner is listed here, by phase.

## Apply migrations

Apply in this order (Supabase SQL editor, or `psql "$SUPABASE_DB_URL" -f <file>`).
Each file is idempotent.

- Phase 1: no migrations.

## Environment variables

| Name | Default | Service | Phase |
|---|---|---|---|
| `CHAT_MODEL` | `gpt-4o` | backend | 1 |
| `TRANSCRIBE_MODEL` | `whisper-1` | backend | 1 |
| `REALTIME_MODEL` | `gpt-realtime` | backend | 1 |
| `EMBEDDING_MODEL` | `text-embedding-3-large` | backend | 1 |

## Device checks

Numbered steps with the expected result. Run them on a physical iPhone after a
native rebuild (`npx expo prebuild --platform ios && npx expo run:ios --device`).

- Phase 1: none (backend only).

## Owner actions outside code

1. Request OpenAI zero data retention and, if records are real client data, a BAA.
2. Confirm the keys leaked in git history (2025: an OpenAI key and Supabase
   service-role keys) are revoked.
3. Run `eas init` for the mobile project (Phase 8 adds `mobile/eas.json`).
4. Choose the App Store bundle id (Phase 8 leaves a placeholder).
