-- +goose Up
-- The daily quota counts minutes of dub a user actually listened to, not videos opened.
-- A sentence counts once per user per day, however often it is replayed.
DROP TABLE dub_usage;
CREATE TABLE dub_listens (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dub_id  bigint NOT NULL REFERENCES dubs(id) ON DELETE CASCADE,
    idx     int NOT NULL,
    day     date NOT NULL,
    ms      int NOT NULL,
    PRIMARY KEY (user_id, day, dub_id, idx)
);

-- +goose Down
DROP TABLE dub_listens;
CREATE TABLE dub_usage (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dub_id  bigint NOT NULL REFERENCES dubs(id) ON DELETE CASCADE,
    day     date NOT NULL,
    PRIMARY KEY (user_id, day, dub_id)
);
