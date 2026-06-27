-- Phase 3: RPC functions for the frontend's time-control bar.
--
-- market_state's RLS policy only allows public SELECT (see Phase 1 migration)
-- -- there is deliberately no public UPDATE policy on the table itself. These
-- two functions are the only sanctioned way for an anonymous client to affect
-- the simulated clock: each is SECURITY DEFINER (runs with the privileges of
-- the function owner, not the calling anon role) and does exactly one narrow
-- update, with its own validation. This keeps the access pattern stable even
-- after real auth/accounts are introduced later -- the frontend keeps calling
-- the same RPCs regardless of who's allowed to call them.

create or replace function set_time_multiplier(new_multiplier numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if new_multiplier < 0 or new_multiplier > 10000 then
    raise exception 'time multiplier must be between 0 and 10000';
  end if;

  update market_state
  set time_multiplier = new_multiplier,
      updated_at = now()
  where id = 1;
end;
$$;

create or replace function set_market_running(running boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update market_state
  set is_running = running,
      updated_at = now()
  where id = 1;
end;
$$;

grant execute on function set_time_multiplier(numeric) to anon, authenticated;
grant execute on function set_market_running(boolean) to anon, authenticated;
