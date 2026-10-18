package main

import (
	"context"
	"embed"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

// openDB connects to Postgres and applies any pending migrations.
func openDB(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	// The service sleeps on Railway after a few minutes without outbound traffic, and an open
	// connection's health checks count as traffic. Idle connections are closed quickly so it can.
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	goose.SetBaseFS(migrations)
	if err := goose.SetDialect("postgres"); err != nil {
		pool.Close()
		return nil, err
	}
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return pool, nil
}
