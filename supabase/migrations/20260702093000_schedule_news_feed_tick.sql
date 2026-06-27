-- Schedules news-feed-tick via pg_cron + pg_net, every 2 real minutes.
-- Reuses 'edge_function_service_key'; creates its own URL secret inline,
-- same pattern as company-events-tick's schedule migration.

select vault.create_secret(
  'https://yesnnugnuxqwyjykmljk.functions.supabase.co/news-feed-tick',
  'edge_function_url_news_feed'
);

select cron.schedule(
  'news-feed-tick',
  '*/2 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_url_news_feed'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_function_service_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
