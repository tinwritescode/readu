-- +goose Up
CREATE TABLE users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL
);

-- One row per way a user can sign in. Email codes use provider 'email' with the
-- email as subject; Sign in with Apple will add provider 'apple'.
CREATE TABLE user_identities (
    user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   text NOT NULL,
    subject    text NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (provider, subject)
);
CREATE INDEX user_identities_user_id ON user_identities(user_id);

CREATE TABLE login_codes (
    email     text PRIMARY KEY,
    code_hash bytea NOT NULL,
    sent_at   timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    attempts  int NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
    token_hash   bytea PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL,
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);

CREATE TABLE plans (
    id   text PRIMARY KEY,
    name text NOT NULL
);
INSERT INTO plans (id, name) VALUES ('free', 'Free');

-- A user has at most one active subscription. provider/provider_ref will hold
-- the App Store or RevenueCat reference once payments exist.
CREATE TABLE subscriptions (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id      text NOT NULL REFERENCES plans(id),
    status       text NOT NULL CHECK (status IN ('active', 'canceled', 'expired')),
    started_at   timestamptz NOT NULL,
    ends_at      timestamptz,
    provider     text,
    provider_ref text
);
CREATE UNIQUE INDEX subscriptions_one_active ON subscriptions(user_id) WHERE status = 'active';

-- +goose Down
DROP TABLE subscriptions;
DROP TABLE plans;
DROP TABLE sessions;
DROP TABLE login_codes;
DROP TABLE user_identities;
DROP TABLE users;
