ALTER TABLE extractions ADD COLUMN verwalter_id INTEGER REFERENCES verwalter_profiles(id);
