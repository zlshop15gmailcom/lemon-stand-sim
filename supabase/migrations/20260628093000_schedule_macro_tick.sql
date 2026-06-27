-- Schedules the macro-tick Edge Function via pg_cron + pg_net, on its own
-- slower 5-minute wall-clock interval (macro events are inherently slow-moving
-- compared to the per-minute price tick). Standard 5-field cron syntax is used
-- here rather than pg_cron's plain-interval shorthand ('30 seconds'), since
-- that shorthand only supports sub-minute granularity.
--
-- Reuses the existing 'edge_function_service_key' Vault secret from the
-- market-tick schedule. Needs one new secret, 'edge_function_url_macro',
-- holding this function's own URL -- set that after deploying macro-tick,
-- then apply this migration.

select cron.schedule(
  'macro-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_url_macro'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_service_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
