SELECT
  migration_name,
  finished_at,
  rolled_back_at,
  logs
FROM "_prisma_migrations"
WHERE migration_name = '20261019104910_add_promotions_v1';