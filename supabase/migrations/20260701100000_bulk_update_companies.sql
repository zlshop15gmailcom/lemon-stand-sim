-- Fixes a real resource problem discovered while verifying Phase 4:
-- market-tick and company-events-tick were each issuing one HTTP update call
-- PER COMPANY at the end of every invocation (500+ parallel requests). At a
-- high time multiplier this pushed market-tick over its Edge Function
-- resource limit and silently stalled the simulated clock. This single
-- bulk-update function lets both functions write all their changes in one
-- round trip instead.
--
-- Only fields present in a given update object are changed -- coalesce falls
-- back to the existing value for anything omitted, so callers can send a
-- sparse payload (e.g. market-tick only ever sends current_price/last_return,
-- company-events-tick may additionally send is_listed/last_eps/last_revenue/
-- next_earnings_at).
create or replace function bulk_update_companies(updates jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update companies c
  set
    current_price = coalesce((elem->>'current_price')::numeric, c.current_price),
    last_return = coalesce((elem->>'last_return')::numeric, c.last_return),
    is_listed = coalesce((elem->>'is_listed')::boolean, c.is_listed),
    last_eps = coalesce((elem->>'last_eps')::numeric, c.last_eps),
    last_revenue = coalesce((elem->>'last_revenue')::numeric, c.last_revenue),
    next_earnings_at = coalesce((elem->>'next_earnings_at')::timestamptz, c.next_earnings_at)
  from jsonb_array_elements(updates) elem
  where c.id = (elem->>'id')::uuid;
end;
$$;

-- Intentionally not granted to anon/authenticated -- only the service-role
-- client used by Edge Functions calls this.
