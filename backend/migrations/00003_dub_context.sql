-- +goose Up
-- What the translator is told about the video, and the names and terms it has settled on so far.
ALTER TABLE dubs
    ADD COLUMN title       text  NOT NULL DEFAULT '',
    ADD COLUMN description text  NOT NULL DEFAULT '',
    ADD COLUMN glossary    jsonb NOT NULL DEFAULT '[]';

-- +goose Down
ALTER TABLE dubs DROP COLUMN glossary, DROP COLUMN description, DROP COLUMN title;
