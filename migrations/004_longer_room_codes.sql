-- Room codes grow from 6 to 8 characters so active rooms cannot be found by
-- guessing. Existing 6-character codes remain valid. Widening a VARCHAR is a
-- metadata-only change in PostgreSQL; no table rewrite is needed.
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_code_format;
ALTER TABLE rooms ALTER COLUMN code TYPE VARCHAR(8);
ALTER TABLE rooms ADD CONSTRAINT rooms_code_format CHECK (code ~ '^[A-Z0-9]{4,8}$');
