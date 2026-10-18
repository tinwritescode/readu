-- +goose Up
-- A dub is one caption track of a YouTube video, translated to Vietnamese.
-- source_hash identifies the exact sentences the extension sent, so a
-- different caption track of the same video gets its own dub.
CREATE TABLE dubs (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    video_id      text NOT NULL,
    source_hash   bytea NOT NULL,
    segment_count int NOT NULL,
    created_at    timestamptz NOT NULL,
    UNIQUE (video_id, source_hash)
);

-- One sentence of a dub. vi_text is null until it is translated.
CREATE TABLE dub_segments (
    dub_id      bigint NOT NULL REFERENCES dubs(id) ON DELETE CASCADE,
    idx         int NOT NULL,
    start_ms    int NOT NULL,
    end_ms      int NOT NULL,
    source_text text NOT NULL,
    vi_text     text,
    PRIMARY KEY (dub_id, idx)
);

-- Spoken audio of one translated sentence in one voice.
CREATE TABLE dub_audio (
    dub_id     bigint NOT NULL REFERENCES dubs(id) ON DELETE CASCADE,
    idx        int NOT NULL,
    voice      text NOT NULL,
    audio      bytea NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (dub_id, idx, voice)
);

-- Which videos a user dubbed on which day, for the daily quota.
CREATE TABLE dub_usage (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dub_id  bigint NOT NULL REFERENCES dubs(id) ON DELETE CASCADE,
    day     date NOT NULL,
    PRIMARY KEY (user_id, day, dub_id)
);

-- +goose Down
DROP TABLE dub_usage;
DROP TABLE dub_audio;
DROP TABLE dub_segments;
DROP TABLE dubs;
