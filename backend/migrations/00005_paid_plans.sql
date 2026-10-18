-- +goose Up
-- Paid plans. How many dub minutes a day each allows is set in the backend's environment, not here.
INSERT INTO plans (id, name) VALUES ('premium', 'Premium'), ('max', 'Max') ON CONFLICT (id) DO NOTHING;

-- +goose Down
DELETE FROM plans WHERE id IN ('premium', 'max');
