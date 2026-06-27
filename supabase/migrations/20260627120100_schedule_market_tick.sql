-- Schedules the market-tick Edge Function via pg_cron + pg_net.
--
-- This needs the project's own URL and a service-role key, which only exist
-- once the project is created, so the actual values are stored as Vault
-- secrets (`edge_function_url`, `edge_function_service_key`) rather than
-- hardcoded here. Set those secrets after running `supabase functions deploy
-- market-tick`, then apply this migration.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'market-tick',
  '30 seconds',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_service_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
