-- Schedules the company-events-tick Edge Function via pg_cron + pg_net, every
-- 2 real minutes. Reuses the existing 'edge_function_service_key' Vault
-- secret. Creates its own URL secret inline (the function's URL is not
-- sensitive -- it's derived deterministically from the project ref, same as
-- the other two function URLs already in Vault).

select vault.create_secret(
  'https://yesnnugnuxqwyjykmljk.functions.supabase.co/company-events-tick',
  'edge_function_url_company_events'
);

select cron.schedule(
  'company-events-tick',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_url_company_events'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_service_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
