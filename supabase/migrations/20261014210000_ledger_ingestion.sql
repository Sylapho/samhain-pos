-- Additive samhain-sync/1 ingestion. Existing financial records are never rewritten.
create function pos_private.sync_fail(code text, diagnostic jsonb default '{}') returns void
language plpgsql set search_path = '' as $$ begin
  raise exception using errcode = 'P0001', message = code, detail = diagnostic::text;
end $$;

create function pos_private.sync_assert(condition boolean, code text default 'BUSINESS_INCONSISTENCY') returns void
language plpgsql set search_path = '' as $$ begin
  if condition is not true then perform pos_private.sync_fail(code); end if;
end $$;

create function pos_private.sync_keys(v jsonb, required text[], optional text[] default '{}') returns void
language plpgsql set search_path = '' as $$ begin
  perform pos_private.sync_assert(jsonb_typeof(v) = 'object', 'INVALID_PAYLOAD');
  perform pos_private.sync_assert(v ?& required and not exists (
    select 1 from jsonb_object_keys(v) k where k <> all(required || optional)), 'INVALID_PAYLOAD');
end $$;

create function pos_private.sync_text(v jsonb, opaque boolean default false, blank_allowed boolean default false) returns text
language plpgsql set search_path = '' as $$ declare s text; begin
  perform pos_private.sync_assert(jsonb_typeof(v) = 'string', 'INVALID_PAYLOAD');
  s := v #>> '{}';
  perform pos_private.sync_assert((blank_allowed or btrim(s, E' \t\r\n') <> '') and
    (not opaque or octet_length(s) <= 512), 'INVALID_PAYLOAD');
  return s;
end $$;

create function pos_private.sync_int(v jsonb, minimum numeric default -9007199254740991) returns numeric
language plpgsql set search_path = '' as $$ declare n numeric; begin
  perform pos_private.sync_assert(jsonb_typeof(v) = 'number', 'INVALID_PAYLOAD');
  n := (v #>> '{}')::numeric;
  perform pos_private.sync_assert(n = trunc(n) and n between minimum and 9007199254740991, 'INVALID_PAYLOAD');
  return n;
end $$;

create function pos_private.sync_date(v jsonb) returns text
language plpgsql set search_path = '' as $$ declare s text; begin
  s := pos_private.sync_text(v);
  perform pos_private.sync_assert(s ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$', 'INVALID_PAYLOAD');
  perform s::timestamptz;
  return s;
end $$;

-- Compare keys by UTF-16 units, not database collation or UTF-8 byte order.
create function pos_private.utf16_key(s text) returns bytea
language plpgsql immutable set search_path = '' as $$
declare result bytea := ''::bytea; c integer; begin
  for i in 1..length(s) loop
    c := ascii(substr(s,i,1));
    if c > 65535 then
      c := c - 65536;
      result := result || decode(lpad(to_hex(55296 + (c / 1024)),4,'0'),'hex') ||
        decode(lpad(to_hex(56320 + (c % 1024)),4,'0'),'hex');
    else result := result || decode(lpad(to_hex(c),4,'0'),'hex'); end if;
  end loop;
  return result;
end $$;

create function pos_private.sync_quote(s text, profile text) returns text
language plpgsql immutable set search_path = '' as $$
declare result text := '"'; c text; n integer; begin
  for i in 1..length(s) loop
    c := substr(s,i,1); n := ascii(c);
    result := result || case
      when c = '"' then E'\\"' when c = E'\\' then E'\\\\'
      when c = '/' and profile = 'android-ledger-v1' then E'\\/'
      when n = 8 then E'\\b' when n = 9 then E'\\t' when n = 10 then E'\\n'
      when n = 12 then E'\\f' when n = 13 then E'\\r'
      when n < 32 then E'\\u00' || lpad(to_hex(n),2,'0') else c end;
  end loop;
  return result || '"';
end $$;

-- JSON (not JSONB) preserves duplicate keys for rejection before projection.
create function pos_private.sync_canonical(v json, profile text default 'ts-ledger-v1', depth integer default 0) returns text
language plpgsql set search_path = '' as $$
declare result text; n numeric; begin
  perform pos_private.sync_assert(depth <= 64, 'INVALID_PAYLOAD');
  perform pos_private.sync_assert(profile in ('ts-ledger-v1','android-ledger-v1'), 'CANONICALIZATION_UNSUPPORTED');
  case json_typeof(v)
    when 'object' then
      perform pos_private.sync_assert((select count(*) = count(distinct key) from json_each(v)), 'INVALID_PAYLOAD');
      select '{' || coalesce(string_agg(pos_private.sync_quote(key,profile) || ':' ||
        pos_private.sync_canonical(value,profile,depth+1), ',' order by pos_private.utf16_key(key)), '') || '}'
        into result from json_each(v);
    when 'array' then
      select '[' || coalesce(string_agg(pos_private.sync_canonical(value,profile,depth+1), ',' order by ord),'') || ']'
        into result from json_array_elements(v) with ordinality a(value,ord);
    when 'string' then result := pos_private.sync_quote(v #>> '{}',profile);
    when 'number' then
      n := v::text::numeric;
      perform pos_private.sync_assert(n = trunc(n) and abs(n) <= 9007199254740991, 'INVALID_PAYLOAD');
      result := trunc(n)::text;
    else result := v::text;
  end case;
  return result;
end $$;

create function pos_private.sync_sha(s text) returns text
language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(s,'UTF8')),'hex') $$;

create function pos_private.sync_terminal(v jsonb) returns void
language plpgsql set search_path = '' as $$ begin
  perform pos_private.sync_keys(v,array['terminalId','terminalCode','displayName']);
  perform pos_private.sync_text(v->'terminalId',true);
  perform pos_private.sync_text(v->'displayName');
  perform pos_private.sync_assert(v->>'terminalCode' in ('A','B','C','D'));
end $$;

create function pos_private.sync_order(v jsonb, source_terminal text, legacy boolean) returns void
language plpgsql set search_path = '' as $$
declare line jsonb; opt jsonb; ingredient jsonb; removed jsonb; total numeric := 0; count_items numeric := 0;
  seen text[] := '{}'::text[]; option_keys text[]; ingredient_keys text[]; removed_keys text[]; k text;
begin
  perform pos_private.sync_keys(v,array['id','orderNumber','receiptNumber','paymentMethod','paymentStatus','paidAt',
    'items','itemCount','totalCents','createdAt','status'],array['terminal','registerName']);
  perform pos_private.sync_text(v->'id',true);
  perform pos_private.sync_text(v->'orderNumber',true); perform pos_private.sync_text(v->'receiptNumber',true);
  perform pos_private.sync_assert(v->>'paymentMethod' in ('cash','card') and v->>'paymentStatus' = 'paid' and v->>'status' = 'confirmed');
  perform pos_private.sync_date(v->'paidAt'); perform pos_private.sync_date(v->'createdAt');
  if v ? 'terminal' then
    perform pos_private.sync_terminal(v->'terminal');
    perform pos_private.sync_assert(v#>>'{terminal,terminalId}' = source_terminal);
  else
    perform pos_private.sync_assert(legacy);
    perform pos_private.sync_text(v->'registerName');
  end if;
  if v ? 'registerName' then perform pos_private.sync_text(v->'registerName'); end if;
  perform pos_private.sync_assert(jsonb_typeof(v->'items') = 'array' and jsonb_array_length(v->'items') > 0);
  for line in select value from jsonb_array_elements(v->'items') loop
    perform pos_private.sync_keys(line,array['lineId','productId','name','unitPriceCents','quantity','options','ingredients',
      'removedIngredientIds','dataConfidence','vatRate'],array['requiresPreparation','variant','note']);
    k := pos_private.sync_text(line->'lineId',true);
    perform pos_private.sync_assert(k <> all(seen)); seen := array_append(seen,k);
    perform pos_private.sync_text(line->'productId',true); perform pos_private.sync_text(line->'name');
    perform pos_private.sync_assert(line->>'dataConfidence' in ('temporary','confirmed') and line->'vatRate' in ('10'::jsonb,'20'::jsonb));
    if line ? 'requiresPreparation' then perform pos_private.sync_assert(jsonb_typeof(line->'requiresPreparation') = 'boolean'); end if;
    if line ? 'note' then perform pos_private.sync_text(line->'note',false,true); end if;
    if line ? 'variant' then
      perform pos_private.sync_keys(line->'variant',array['id','name'],array['volume']);
      perform pos_private.sync_text(line#>'{variant,id}',true); perform pos_private.sync_text(line#>'{variant,name}');
      if line->'variant' ? 'volume' then perform pos_private.sync_text(line#>'{variant,volume}'); end if;
    end if;
    total := total + pos_private.sync_int(line->'quantity',1) * pos_private.sync_int(line->'unitPriceCents',0);
    count_items := count_items + pos_private.sync_int(line->'quantity',1);
    perform pos_private.sync_assert(total <= 9007199254740991 and count_items <= 9007199254740991);
    perform pos_private.sync_assert(jsonb_typeof(line->'options') = 'array' and jsonb_typeof(line->'ingredients') = 'array'
      and jsonb_typeof(line->'removedIngredientIds') = 'array');
    option_keys := '{}'; ingredient_keys := '{}'; removed_keys := '{}';
    for opt in select value from jsonb_array_elements(line->'options') loop
      perform pos_private.sync_keys(opt,array['groupId','groupName','optionId','optionName','priceDeltaCents']);
      perform pos_private.sync_text(opt->'groupId',true); perform pos_private.sync_text(opt->'optionId',true);
      perform pos_private.sync_text(opt->'groupName'); perform pos_private.sync_text(opt->'optionName');
      perform pos_private.sync_int(opt->'priceDeltaCents');
      k := (opt->'groupId')::text || ':' || (opt->'optionId')::text;
      perform pos_private.sync_assert(k <> all(option_keys)); option_keys := array_append(option_keys,k);
    end loop;
    for ingredient in select value from jsonb_array_elements(line->'ingredients') loop
      perform pos_private.sync_keys(ingredient,array['id','name']); k := pos_private.sync_text(ingredient->'id',true);
      perform pos_private.sync_text(ingredient->'name');
      perform pos_private.sync_assert(k <> all(ingredient_keys)); ingredient_keys := array_append(ingredient_keys,k);
    end loop;
    for removed in select value from jsonb_array_elements(line->'removedIngredientIds') loop
      k := pos_private.sync_text(removed,true);
      perform pos_private.sync_assert(k = any(ingredient_keys) and k <> all(removed_keys)); removed_keys := array_append(removed_keys,k);
    end loop;
  end loop;
  perform pos_private.sync_assert(pos_private.sync_int(v->'totalCents',0) = total and pos_private.sync_int(v->'itemCount',1) = count_items);
end $$;

-- Stateful rules read only the durable prefix (and earlier inserts in this transaction).
create function pos_private.sync_business(chain uuid, p jsonb) returns void
language plpgsql set search_path = '' as $$
declare event_kind text := p->>'kind'; v jsonb; original jsonb; original_hash text;
  previous_end text; active_session jsonb; active_terminal text; opening numeric; prior jsonb; line jsonb;
  sold_line jsonb; refunded numeric; gross numeric; delta numeric; total numeric := 0; already numeric;
  seen text[] := '{}'::text[]; line_id text; expected_line jsonb; expected_totals jsonb;
  sales_count numeric; sales_gross numeric; correction_count numeric; corrections numeric; cash numeric; card numeric; cumulative numeric;
begin
  perform pos_private.sync_keys(p,array['schemaVersion','id','sequence','kind','recordedAt','previousHash','source','hash'] ||
    case event_kind when 'sale' then array['orderId','order'] when 'correction' then array['correction']
      when 'closure' then array['closure'] when 'cash_session_opened' then array['session']
      when 'cash_float_updated' then array['cashFloatUpdate'] else array['unsupported'] end);
  perform pos_private.sync_date(p->'recordedAt');
  perform pos_private.sync_keys(p->'source',array['softwareVersion','buildMode','terminal','organization']);
  perform pos_private.sync_text(p#>'{source,softwareVersion}'); perform pos_private.sync_text(p#>'{source,buildMode}');
  perform pos_private.sync_terminal(p#>'{source,terminal}');
  perform pos_private.sync_keys(p#>'{source,organization}',array['organizationName','eventName','city','address','siret','vatNumber','usesDemoPlaceholders']);
  for line_id in select jsonb_object_keys(p#>'{source,organization}') loop
    if line_id = 'usesDemoPlaceholders' then
      perform pos_private.sync_assert(jsonb_typeof(p#>'{source,organization,usesDemoPlaceholders}') = 'boolean','INVALID_PAYLOAD');
    else perform pos_private.sync_text(p#>'{source,organization}'->line_id,false,true); end if;
  end loop;
  select payload#>>'{closure,periodEnd}' into previous_end from pos_private.ledger_events
    where chain_id = chain and kind = 'closure' order by sequence desc limit 1;
  select e.payload->'session',e.source_terminal_id into active_session,active_terminal from pos_private.ledger_events e
    where e.chain_id = chain and e.kind = 'cash_session_opened' and not exists (
      select 1 from pos_private.ledger_events closed where closed.chain_id = chain and closed.kind = 'closure'
        and closed.payload#>>'{closure,cashSessionId}' = e.session_id) order by e.sequence desc limit 1;
  if active_session is not null then
    select coalesce((select payload#>'{cashFloatUpdate,newOpeningFloatCents}' from pos_private.ledger_events
      where chain_id = chain and kind = 'cash_float_updated' and referenced_session_id = active_session->>'sessionId'
      order by sequence desc limit 1),active_session->'openingFloatCents') into line;
    opening := pos_private.sync_int(line,0);
  end if;
  if event_kind = 'sale' then
    v := p->'order';
    perform pos_private.sync_order(v,p#>>'{source,terminal,terminalId}',true);
    perform pos_private.sync_assert(p->'orderId' = v->'id');
    perform pos_private.sync_assert(previous_end is null or v->>'paidAt' >= previous_end);
  elsif event_kind = 'correction' then
    v := p->'correction';
    perform pos_private.sync_keys(v,array['operationId','originalOrderId','originalOrderNumber','originalReceiptNumber',
      'type','reason','amountDeltaCents','paymentMethod','originalSaleHash'],array['refundLines']);
    perform pos_private.sync_text(v->'operationId',true); perform pos_private.sync_text(v->'originalOrderId',true);
    perform pos_private.sync_text(v->'reason');
    select coalesce(e.payload->'order',s.legacy_payload),s.sale_hash into original,original_hash
      from pos_private.sales s left join pos_private.ledger_events e on e.chain_id = s.chain_id and e.event_id = s.ledger_event_id
      where s.chain_id = chain and s.order_id = v->>'originalOrderId';
    if not found then perform pos_private.sync_fail('DEPENDENCY_MISSING'); end if;
    perform pos_private.sync_assert(v->'originalOrderNumber' = original->'orderNumber' and
      v->'originalReceiptNumber' = original->'receiptNumber' and v->'paymentMethod' = original->'paymentMethod' and
      (v->>'originalSaleHash') is not distinct from original_hash);
    perform pos_private.sync_assert(previous_end is null or p->>'recordedAt' >= previous_end);
    perform pos_private.sync_assert(v->>'type' in ('cancellation','refund','adjustment'));
    delta := pos_private.sync_int(v->'amountDeltaCents');
    perform pos_private.sync_assert(delta <> 0 and (v->>'type' = 'adjustment' or delta < 0));
    select coalesce(jsonb_agg(payload->'correction'),'[]') into prior from pos_private.ledger_events
      where chain_id = chain and kind = 'correction' and original_order_id = v->>'originalOrderId';
    perform pos_private.sync_assert(not exists (select 1 from jsonb_array_elements(prior) x where x->>'type' = 'cancellation'));
    if v->>'type' = 'cancellation' then
      perform pos_private.sync_assert(delta = -pos_private.sync_int(original->'totalCents',0) and jsonb_array_length(prior) = 0 and not (v ? 'refundLines'));
    elsif v->>'type' = 'refund' then
      select coalesce(sum(-(x->>'amountDeltaCents')::numeric),0) into already from jsonb_array_elements(prior) x where x->>'type' = 'refund';
      perform pos_private.sync_assert(already - delta <= pos_private.sync_int(original->'totalCents',0));
      -- Historical amount-only refunds remain valid; never invent their quantities or VAT.
      if v ? 'refundLines' then
        perform pos_private.sync_assert(jsonb_typeof(v->'refundLines') = 'array' and jsonb_array_length(v->'refundLines') > 0);
        perform pos_private.sync_assert(not exists (select 1 from jsonb_array_elements(prior) x where x->>'type' = 'refund' and not (x ? 'refundLines')));
        for line in select value from jsonb_array_elements(v->'refundLines') loop
          perform pos_private.sync_keys(line,array['originalLineId','productId','productName','quantity','unitPriceCents','vatRate','grossCents','vatCents']);
          line_id := pos_private.sync_text(line->'originalLineId',true);
          perform pos_private.sync_assert(line_id <> all(seen)); seen := array_append(seen,line_id);
          select x into sold_line from jsonb_array_elements(original->'items') x where x->>'lineId' = line_id;
          perform pos_private.sync_assert(sold_line is not null);
          select coalesce(sum((l->>'quantity')::numeric),0) into refunded from jsonb_array_elements(prior) x,
            lateral jsonb_array_elements(coalesce(x->'refundLines','[]')) l where x->>'type' = 'refund' and l->>'originalLineId' = line_id;
          perform pos_private.sync_assert(pos_private.sync_int(line->'quantity',1) + refunded <= pos_private.sync_int(sold_line->'quantity',1));
          gross := pos_private.sync_int(sold_line->'unitPriceCents',0) * pos_private.sync_int(line->'quantity',1);
          -- Match JS Math.round / Kotlin Math.round on the cumulative historical gross.
          expected_line := jsonb_build_object('originalLineId',line_id,'productId',sold_line->'productId','productName',sold_line->'name',
            'quantity',line->'quantity','unitPriceCents',sold_line->'unitPriceCents','vatRate',sold_line->'vatRate','grossCents',gross,
            'vatCents',floor(((gross + (sold_line->>'unitPriceCents')::numeric * refunded)::double precision *
              (sold_line->>'vatRate')::double precision / (100 + (sold_line->>'vatRate')::double precision)) + 0.5) -
              floor((((sold_line->>'unitPriceCents')::numeric * refunded)::double precision *
              (sold_line->>'vatRate')::double precision / (100 + (sold_line->>'vatRate')::double precision)) + 0.5));
          perform pos_private.sync_assert(line = expected_line); total := total + gross;
        end loop;
        perform pos_private.sync_assert(delta = -total);
      end if;
    else perform pos_private.sync_assert(not (v ? 'refundLines'));
    end if;
  elsif event_kind = 'cash_session_opened' then
    v := p->'session';
    perform pos_private.sync_keys(v,array['sessionId','periodStart','openingFloatCents','createdAt']);
    perform pos_private.sync_text(v->'sessionId',true); perform pos_private.sync_int(v->'openingFloatCents',0);
    perform pos_private.sync_date(v->'periodStart'); perform pos_private.sync_date(v->'createdAt');
    perform pos_private.sync_assert(active_session is null and v->'createdAt' = p->'recordedAt' and v->>'periodStart' <= v->>'createdAt'
      and (previous_end is null or v->>'periodStart' = previous_end));
  elsif event_kind = 'cash_float_updated' then
    v := p->'cashFloatUpdate';
    perform pos_private.sync_keys(v,array['operationId','sessionId','previousOpeningFloatCents','newOpeningFloatCents','updatedAt']);
    perform pos_private.sync_text(v->'operationId',true); perform pos_private.sync_text(v->'sessionId',true);
    if active_session is null then perform pos_private.sync_fail('DEPENDENCY_MISSING'); end if;
    perform pos_private.sync_date(v->'updatedAt');
    perform pos_private.sync_assert(v->>'sessionId' = active_session->>'sessionId' and active_terminal = p#>>'{source,terminal,terminalId}'
      and pos_private.sync_int(v->'previousOpeningFloatCents',0) = opening and v->'updatedAt' = p->'recordedAt');
    perform pos_private.sync_int(v->'newOpeningFloatCents',0);
  elsif event_kind = 'closure' then
    v := p->'closure';
    perform pos_private.sync_keys(v,array['operationId','periodStart','periodEnd','totals'],array['cashSessionId','openingFloatCents','theoreticalCashCents']);
    perform pos_private.sync_text(v->'operationId',true); perform pos_private.sync_date(v->'periodStart'); perform pos_private.sync_date(v->'periodEnd');
    perform pos_private.sync_assert(v->>'periodStart' < v->>'periodEnd' and v->>'periodEnd' <= p->>'recordedAt' and
      (previous_end is null or v->>'periodStart' = previous_end));
    select count(*) filter (where kind = 'sale' and d >= v->>'periodStart'),
      coalesce(sum(amount) filter (where kind = 'sale' and d >= v->>'periodStart'),0),
      count(*) filter (where kind = 'correction' and d >= v->>'periodStart'),
      coalesce(sum(amount) filter (where kind = 'correction' and d >= v->>'periodStart'),0),
      coalesce(sum(amount) filter (where method = 'cash' and d >= v->>'periodStart'),0),
      coalesce(sum(amount) filter (where method = 'card' and d >= v->>'periodStart'),0),coalesce(sum(amount),0)
      into sales_count,sales_gross,correction_count,corrections,cash,card,cumulative from (
        select e.kind,case e.kind when 'sale' then e.payload#>>'{order,paidAt}' else e.recorded_at end d,
          case e.kind when 'sale' then (e.payload#>>'{order,totalCents}')::numeric else (e.payload#>>'{correction,amountDeltaCents}')::numeric end amount,
          case e.kind when 'sale' then e.payload#>>'{order,paymentMethod}' else e.payload#>>'{correction,paymentMethod}' end method
          from pos_private.ledger_events e where e.chain_id = chain and e.kind in ('sale','correction')) a where d < v->>'periodEnd';
    expected_totals := jsonb_build_object('saleCount',sales_count,'grossSalesCents',sales_gross,'correctionCount',correction_count,
      'correctionTotalCents',corrections,'netTotalCents',sales_gross+corrections,'cumulativeNetTotalCents',cumulative,
      'paymentTotalsCents',jsonb_build_object('cash',cash,'card',card));
    perform pos_private.sync_assert(v->'totals' = expected_totals);
    if v ? 'cashSessionId' then
      perform pos_private.sync_text(v->'cashSessionId',true);
      if active_session is null then perform pos_private.sync_fail('DEPENDENCY_MISSING'); end if;
      perform pos_private.sync_assert(v->>'cashSessionId' = active_session->>'sessionId' and
        active_terminal = p#>>'{source,terminal,terminalId}' and v->'periodStart' = active_session->'periodStart' and
        pos_private.sync_int(v->'openingFloatCents',0) = opening and pos_private.sync_int(v->'theoreticalCashCents') = opening + cash);
    else perform pos_private.sync_assert(not (v ?| array['openingFloatCents','theoreticalCashCents'])); end if;
  else perform pos_private.sync_fail('INVALID_PAYLOAD'); end if;
end $$;

-- Auth tables are owned by Supabase Auth; expose only a closed live-session check,
-- not grants on credentials to the financial executor. Lock against logout/revocation.
create function pos_private.require_sync_session(subject uuid, session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform 1 from auth.users u where u.id = subject and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= clock_timestamp()) for share;
  if not found then perform pos_private.sync_fail('AUTH_REQUIRED'); end if;
  perform 1 from auth.sessions s where s.id = session_id and s.user_id = subject
    and (s.not_after is null or s.not_after > clock_timestamp()) for share;
  if not found then perform pos_private.sync_fail('AUTH_REQUIRED'); end if;
end $$;

create function pos_private.sync_authorize(subject uuid, context jsonb, diagnostic boolean default false) returns void
language plpgsql set search_path = '' as $$
declare c pos_private.chains%rowtype; i pos_private.installations%rowtype; begin
  select * into c from pos_private.chains where chain_id = (context->>'chainId')::uuid for update;
  if not found then perform pos_private.sync_fail('SCOPE_DENIED'); end if;
  select * into i from pos_private.installations where installation_id = (context->>'installationId')::uuid for share;
  if not found or i.auth_subject is distinct from subject then perform pos_private.sync_fail('ACCESS_REVOKED'); end if;
  if not i.active or i.enrollment_generation <> c.enrollment_generation or
    i.enrollment_generation <> (context->>'enrollmentGeneration')::bigint then perform pos_private.sync_fail('INSTALLATION_RETIRED'); end if;
  perform pos_private.sync_assert(i.chain_id = c.chain_id and i.organization_id = (context->>'organizationId')::uuid
    and i.festival_id = (context->>'festivalId')::uuid,'SCOPE_DENIED');
  perform 1 from pos_private.organizations where organization_id = i.organization_id and active for share;
  if not found then perform pos_private.sync_fail('ACCESS_REVOKED'); end if;
  perform 1 from pos_private.festivals where organization_id = i.organization_id and festival_id = i.festival_id and active for share;
  if not found then perform pos_private.sync_fail('ACCESS_REVOKED'); end if;
  perform 1 from pos_private.installation_keys where installation_id = i.installation_id and (diagnostic or continuity_state = 'ready') for share;
  if not found then perform pos_private.sync_fail('ACCESS_REVOKED'); end if;
end $$;

-- Closed overload permits prefix comparison while needs_recovery, never financial upload.
create function pos_private.consume_installation_proof(subject uuid, context jsonb, nonce uuid, diagnostic boolean) returns void
language plpgsql set search_path = '' as $$ begin
  perform pos_private.sync_authorize(subject,context,diagnostic);
  if not diagnostic then
    perform pos_private.consume_installation_proof(subject,context,nonce);
  else
    update pos_private.auth_challenges ch set expires_at = '-infinity'
      where ch.auth_subject = subject and ch.nonce = consume_installation_proof.nonce and ch.installation_id = (context->>'installationId')::uuid
        and ch.expires_at > clock_timestamp();
    if not found then perform pos_private.sync_fail('ACCESS_REVOKED'); end if;
  end if;
end $$;

create function pos_private.sync_request(raw_body text, endpoint text) returns jsonb
language plpgsql set search_path = '' as $$
declare b jsonb; h jsonb; field text; item jsonb; last_seq numeric := 0; ids text[] := '{}'::text[]; seq numeric;
begin
  perform pos_private.sync_assert(octet_length(raw_body) <= 1048576,'BATCH_TOO_LARGE');
  -- Walk raw JSON before casting to JSONB, rejecting duplicate keys at every depth.
  perform pos_private.sync_canonical(raw_body::json);
  b := raw_body::jsonb;
  perform pos_private.sync_assert(b->'protocolVersion' = '1'::jsonb,'PROTOCOL_UNSUPPORTED');
  perform pos_private.sync_keys(b,array['protocolVersion','requestId','organizationId','festivalId','chainId','installationId',
    'enrollmentGeneration','events'] || case when endpoint = 'ledger' then array['expectedHead'] else '{}'::text[] end);
  foreach field in array array['requestId','organizationId','festivalId','chainId','installationId'] loop
    perform pos_private.sync_assert(pos_private.sync_text(b->field) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','INVALID_ENVELOPE');
  end loop;
  perform pos_private.sync_int(b->'enrollmentGeneration',1);
  if endpoint = 'ledger' then
    h := b->'expectedHead'; perform pos_private.sync_keys(h,array['sequence','hash']);
    perform pos_private.sync_int(h->'sequence',0);
    perform pos_private.sync_assert((h->'sequence' = '0'::jsonb and h->'hash' = 'null'::jsonb) or
      (h->'sequence' <> '0'::jsonb and jsonb_typeof(h->'hash') = 'string' and h->>'hash' ~ '^[0-9a-f]{64}$'),'INVALID_ENVELOPE');
  end if;
  perform pos_private.sync_assert(jsonb_typeof(b->'events') = 'array' and (endpoint = 'prefix' or jsonb_array_length(b->'events') > 0),'INVALID_ENVELOPE');
  perform pos_private.sync_assert(jsonb_array_length(b->'events') <= 100,'BATCH_TOO_LARGE');
  for item in select value from jsonb_array_elements(b->'events') loop
    perform pos_private.sync_text(item->'eventId',true);
    perform pos_private.sync_assert(item->>'eventId' <> all(ids),'INVALID_ENVELOPE'); ids := array_append(ids,item->>'eventId');
    if endpoint = 'prefix' then
      perform pos_private.sync_keys(item,array['eventId','sequence','hash','transportFingerprint']);
      perform pos_private.sync_assert(jsonb_typeof(item->'hash') = 'string' and item->>'hash' ~ '^[0-9a-f]{64}$','INVALID_ENVELOPE');
      perform pos_private.sync_assert(jsonb_typeof(item->'transportFingerprint') = 'string' and item->>'transportFingerprint' ~ '^[0-9a-f]{64}$','INVALID_ENVELOPE');
    else
      perform pos_private.sync_keys(item,array['eventId','eventType','ledgerSchemaVersion','sourceTerminalId','sequence','hash','previousHash',
        'ledgerCanonicalization','payloadCanonical','transportFingerprint']);
    end if;
    if endpoint <> 'legacy' then
      seq := pos_private.sync_int(item->'sequence',1);
      perform pos_private.sync_assert(seq > last_seq,'INVALID_ENVELOPE'); last_seq := seq;
    end if;
  end loop;
  return b;
end $$;

create function pos_private.sync_event(context jsonb, event jsonb, legacy boolean) returns jsonb
language plpgsql set search_path = '' as $$
declare p jsonb; raw text; profile text; envelope jsonb; computed text; begin
  raw := pos_private.sync_text(event->'payloadCanonical');
  perform pos_private.sync_assert(octet_length(raw) <= 262144,'EVENT_TOO_LARGE');
  profile := case when legacy then 'ts-ledger-v1' else pos_private.sync_text(event->'ledgerCanonicalization') end;
  perform pos_private.sync_assert(pos_private.sync_canonical(raw::json,profile) = raw,'INVALID_PAYLOAD');
  p := raw::jsonb;
  perform pos_private.sync_text(event->'sourceTerminalId',true);
  if legacy then
    perform pos_private.sync_assert(event->>'eventType' = 'legacy_order' and event->'ledgerSchemaVersion' = 'null'::jsonb and
      event->'sequence' = 'null'::jsonb and event->'hash' = 'null'::jsonb and event->'previousHash' = 'null'::jsonb and
      event->'ledgerCanonicalization' = 'null'::jsonb,'INVALID_ENVELOPE');
    perform pos_private.sync_assert(event->'eventId' = p->'id','INVALID_PAYLOAD');
  else
    perform pos_private.sync_assert(event->'ledgerSchemaVersion' = '1'::jsonb,'LEDGER_SCHEMA_UNSUPPORTED');
    perform pos_private.sync_assert(event->>'eventType' = 'ledger' and jsonb_typeof(event->'hash') = 'string' and
      event->>'hash' ~ '^[0-9a-f]{64}$' and (event->'previousHash' = 'null'::jsonb or
      (jsonb_typeof(event->'previousHash') = 'string' and event->>'previousHash' ~ '^[0-9a-f]{64}$')),'INVALID_ENVELOPE');
    perform pos_private.sync_assert(p @> jsonb_build_object('id',event->'eventId','schemaVersion',1,'sequence',event->'sequence',
      'hash',event->'hash','previousHash',event->'previousHash') and p#>'{source,terminal,terminalId}' = event->'sourceTerminalId','INVALID_PAYLOAD');
    computed := pos_private.sync_sha(pos_private.sync_canonical((p-'hash')::json,profile));
    perform pos_private.sync_assert(computed = event->>'hash','INVALID_HASH');
  end if;
  envelope := jsonb_build_object('protocolVersion',1,'organizationId',context->'organizationId','festivalId',context->'festivalId',
    'chainId',context->'chainId') || (event-'transportFingerprint');
  computed := pos_private.sync_sha(pos_private.sync_canonical(envelope::json));
  perform pos_private.sync_assert(computed = event->>'transportFingerprint','INVALID_FINGERPRINT');
  return p;
end $$;

create function pos_private.sync_result(context jsonb, acknowledgements jsonb, diagnostic boolean default false) returns jsonb
language sql set search_path = '' as $$
  select jsonb_build_object('protocolVersion',1,'requestId',context->'requestId','organizationId',context->'organizationId',
    'festivalId',context->'festivalId','chainId',context->'chainId','serverHead',jsonb_build_object('sequence',head_sequence,'hash',head_hash)) ||
    case when diagnostic then jsonb_build_object('results',acknowledgements)
      else jsonb_build_object('committed',true,'acknowledgements',acknowledgements) end
  from pos_private.chains where chain_id = (context->>'chainId')::uuid
$$;

create function pos_private.sync_ingest(subject uuid, session_id uuid, raw_body text, proof_nonce uuid, legacy boolean) returns jsonb
language plpgsql set search_path = '' as $$
declare b jsonb; event jsonb; p jsonb; existing pos_private.ledger_events%rowtype; sale pos_private.sales%rowtype;
  receipt pos_private.sync_receipts%rowtype; c pos_private.chains%rowtype; initial_head jsonb; diagnostic jsonb;
  result jsonb := '[]'::jsonb; status text; is_new boolean := false; checked_head boolean := false; identifier text;
  last_sequence bigint := 0; failure_code text;
begin
  b := pos_private.sync_request(raw_body,case when legacy then 'legacy' else 'ledger' end);
  perform pos_private.require_sync_session(subject,session_id);
  perform pos_private.consume_installation_proof(subject,b,proof_nonce,false);
  select * into c from pos_private.chains where chain_id = (b->>'chainId')::uuid;
  initial_head := jsonb_build_object('sequence',c.head_sequence,'hash',c.head_hash);
  -- Validate all immutable identities before continuity checks, with deterministic conflict priority.
  for event in select value from jsonb_array_elements(b->'events') loop
    diagnostic := jsonb_build_object('eventId',event->'eventId','expectedHead',initial_head);
    p := pos_private.sync_event(b,event,legacy);
    if legacy then
      select * into sale from pos_private.sales where organization_id = c.organization_id and festival_id = c.festival_id and order_id = event->>'eventId';
      if found then
        if sale.chain_id <> c.chain_id then perform pos_private.sync_fail('DUPLICATE_ORDER_OTHER_CHAIN',diagnostic); end if;
        if sale.legacy_payload_canonical is distinct from event->>'payloadCanonical' or
          sale.legacy_transport_fingerprint is distinct from event->>'transportFingerprint' then perform pos_private.sync_fail('EVENT_CONTENT_CONFLICT',diagnostic); end if;
      end if;
    else
      select * into existing from pos_private.ledger_events where chain_id = c.chain_id and event_id = event->>'eventId';
      if found and (existing.payload_canonical is distinct from event->>'payloadCanonical' or existing.hash is distinct from event->>'hash' or
        existing.sequence is distinct from (event->>'sequence')::bigint or existing.ledger_canonicalization is distinct from event->>'ledgerCanonicalization' or
        existing.transport_fingerprint is distinct from event->>'transportFingerprint') then perform pos_private.sync_fail('EVENT_CONTENT_CONFLICT',diagnostic); end if;
      if exists (select 1 from pos_private.ledger_events e where e.chain_id = c.chain_id and e.sequence = (event->>'sequence')::bigint and e.event_id <> event->>'eventId') then
        perform pos_private.sync_fail('SEQUENCE_FORK',diagnostic);
      end if;
      identifier := case p->>'kind' when 'correction' then p#>>'{correction,operationId}' when 'closure' then p#>>'{closure,operationId}'
        when 'cash_float_updated' then p#>>'{cashFloatUpdate,operationId}' end;
      if exists (select 1 from pos_private.ledger_events e where e.chain_id = c.chain_id and e.event_id <> event->>'eventId' and
        ((e.kind = p->>'kind' and e.operation_id = identifier) or (e.session_id = p#>>'{session,sessionId}'))) then
        perform pos_private.sync_fail('EVENT_CONTENT_CONFLICT',diagnostic);
      end if;
      if p->>'kind' = 'sale' then
        select * into sale from pos_private.sales where organization_id = c.organization_id and festival_id = c.festival_id and order_id = p->>'orderId';
        if found then
          if sale.chain_id <> c.chain_id then perform pos_private.sync_fail('DUPLICATE_ORDER_OTHER_CHAIN',diagnostic); end if;
          if sale.ledger_event_id is distinct from event->>'eventId' then perform pos_private.sync_fail('EVENT_CONTENT_CONFLICT',diagnostic); end if;
        end if;
      end if;
    end if;
  end loop;
  for event in select value from jsonb_array_elements(b->'events') loop
    p := (event->>'payloadCanonical')::jsonb;
    diagnostic := jsonb_build_object('eventId',event->'eventId','expectedHead',initial_head);
    if not legacy then
      if last_sequence > 0 and (event->>'sequence')::bigint <> last_sequence+1 then
        perform pos_private.sync_fail('MISSING_PREDECESSOR',diagnostic);
      end if;
      last_sequence := (event->>'sequence')::bigint;
    end if;
    select * into receipt from pos_private.sync_receipts where chain_id = c.chain_id and event_type =
      case when legacy then 'legacy_order' else 'ledger' end and event_id = event->>'eventId';
    if found then
      perform pos_private.sync_assert(not is_new,'INVALID_ENVELOPE'); status := 'already_present';
    else
      is_new := true; status := 'accepted';
      if legacy then
        perform pos_private.sync_assert(exists(select 1 from pos_private.terminal_ranges r where r.chain_id = c.chain_id and r.terminal_id = event->>'sourceTerminalId'),'SCOPE_DENIED');
        -- Historical terminal-less snapshots use the approved dossier identity, never a made-up terminal field.
        perform pos_private.sync_order(p,event->>'sourceTerminalId',true);
        insert into pos_private.sales(organization_id,festival_id,chain_id,order_id,legacy_payload_canonical,legacy_transport_fingerprint,legacy_protocol_version)
          values(c.organization_id,c.festival_id,c.chain_id,event->>'eventId',event->>'payloadCanonical',event->>'transportFingerprint',1);
      else
        select * into c from pos_private.chains where chain_id = c.chain_id;
        if (event->>'sequence')::bigint > c.head_sequence+1 then perform pos_private.sync_fail('MISSING_PREDECESSOR',diagnostic); end if;
        if not checked_head and b->'expectedHead' <> initial_head then perform pos_private.sync_fail('HEAD_MOVED',diagnostic); end if;
        checked_head := true;
        if (event->>'sequence')::bigint <> c.head_sequence+1 or (event->>'previousHash') is distinct from c.head_hash then
          perform pos_private.sync_fail('SEQUENCE_FORK',diagnostic);
        end if;
        perform pos_private.sync_assert(exists(select 1 from pos_private.terminal_ranges r where r.chain_id = c.chain_id and
          r.terminal_id = event->>'sourceTerminalId' and (event->>'sequence')::bigint >= r.first_sequence and
          (r.last_sequence is null or (event->>'sequence')::bigint <= r.last_sequence)),'SCOPE_DENIED');
        perform pos_private.sync_business(c.chain_id,p);
        insert into pos_private.ledger_events(organization_id,festival_id,chain_id,event_id,sequence,schema_version,kind,recorded_at,
          previous_hash,hash,source_terminal_id,protocol_version,ledger_canonicalization,payload_canonical,transport_fingerprint)
          values(c.organization_id,c.festival_id,c.chain_id,event->>'eventId',(event->>'sequence')::bigint,1,p->>'kind',p->>'recordedAt',
            event->>'previousHash',event->>'hash',event->>'sourceTerminalId',1,event->>'ledgerCanonicalization',event->>'payloadCanonical',event->>'transportFingerprint');
      end if;
      insert into pos_private.sync_receipts(organization_id,festival_id,chain_id,event_type,event_id,ledger_event_id,legacy_order_id,
        installation_id,enrollment_generation,auth_subject,first_request_id) values(c.organization_id,c.festival_id,c.chain_id,
          case when legacy then 'legacy_order' else 'ledger' end,event->>'eventId',case when not legacy then event->>'eventId' end,
          case when legacy then event->>'eventId' end,(b->>'installationId')::uuid,(b->>'enrollmentGeneration')::bigint,subject,(b->>'requestId')::uuid)
        returning * into receipt;
    end if;
    result := result || jsonb_build_array(jsonb_build_object('eventId',event->'eventId','sequence',event->'sequence','hash',event->'hash',
      'transportFingerprint',event->'transportFingerprint','receiptId',receipt.receipt_id,
      'serverReceivedAt',to_char(receipt.server_received_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'status',status));
  end loop;
  -- Deferred invoker triggers must run while the bounded definer is still active.
  -- At PostgREST commit the caller is service_role, which intentionally cannot read POS tables.
  set constraints pos_private.ledger_receipt_required, pos_private.legacy_receipt_required, pos_private.chain_head_fk immediate;
  set constraints pos_private.ledger_receipt_required, pos_private.legacy_receipt_required, pos_private.chain_head_fk deferred;
  return pos_private.sync_result(b,result);
exception
  when raise_exception then
    get stacked diagnostics failure_code = message_text;
    perform pos_private.sync_fail(failure_code,coalesce(diagnostic,'{}'::jsonb));
    raise;
  when unique_violation then
    -- Another chain may race on the same globally scoped sale identity. Roll back everything.
    if exists(select 1 from pos_private.sales s where s.organization_id = c.organization_id and s.festival_id = c.festival_id and
      s.order_id = coalesce(p->>'orderId',p->>'id') and s.chain_id <> c.chain_id) then
      perform pos_private.sync_fail('DUPLICATE_ORDER_OTHER_CHAIN',diagnostic);
    end if;
    perform pos_private.sync_fail('EVENT_CONTENT_CONFLICT',diagnostic);
    raise;
  when serialization_failure or deadlock_detected or lock_not_available or query_canceled then
    perform pos_private.sync_fail('TRANSACTION_RETRY');
    raise;
  when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format or untranslatable_character then
    perform pos_private.sync_fail('INVALID_PAYLOAD');
    raise;
end $$;

create function public.ledger_ingest_v1(subject uuid, session_id uuid, raw_body text, proof_nonce uuid) returns jsonb
language sql security definer set search_path = '' set lock_timeout = '5s' set statement_timeout = '25s' as $$
  select pos_private.sync_ingest(subject,session_id,raw_body,proof_nonce,false)
$$;
create function public.legacy_import_v1(subject uuid, session_id uuid, raw_body text, proof_nonce uuid) returns jsonb
language sql security definer set search_path = '' set lock_timeout = '5s' set statement_timeout = '25s' as $$
  select pos_private.sync_ingest(subject,session_id,raw_body,proof_nonce,true)
$$;

create function public.ledger_prefix_v1(subject uuid, session_id uuid, raw_body text, proof_nonce uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' set statement_timeout = '25s' as $$
declare b jsonb; item jsonb; e pos_private.ledger_events%rowtype; result jsonb := '[]'::jsonb; server_tuple jsonb; status text; begin
  b := pos_private.sync_request(raw_body,'prefix');
  perform pos_private.require_sync_session(subject,session_id);
  perform pos_private.consume_installation_proof(subject,b,proof_nonce,true);
  for item in select value from jsonb_array_elements(b->'events') loop
    select * into e from pos_private.ledger_events where chain_id = (b->>'chainId')::uuid and sequence = (item->>'sequence')::bigint;
    if not found then status := 'absent'; server_tuple := null;
    else
      server_tuple := jsonb_build_object('sequence',e.sequence,'eventId',e.event_id,'hash',e.hash,'transportFingerprint',e.transport_fingerprint);
      status := case when item = server_tuple then 'match' else 'conflict' end;
    end if;
    result := result || jsonb_build_array(item || jsonb_build_object('status',status) ||
      case when status = 'conflict' then jsonb_build_object('server',server_tuple) else '{}'::jsonb end);
  end loop;
  return pos_private.sync_result(b,result,true);
exception when serialization_failure or deadlock_detected or lock_not_available or query_canceled then
  perform pos_private.sync_fail('TRANSACTION_RETRY');
when invalid_text_representation or numeric_value_out_of_range or untranslatable_character then
  perform pos_private.sync_fail('INVALID_PAYLOAD');
end $$;

-- A separate NOLOGIN owner may append only via the complete server RPCs.
do $$ begin
  if not exists(select 1 from pg_roles where rolname = 'pos_ledger_executor') then
    create role pos_ledger_executor nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if exists(select 1 from pg_roles where rolname = 'pos_ledger_executor' and
    (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)) or
    pg_has_role('anon','pos_ledger_executor','MEMBER') or pg_has_role('authenticated','pos_ledger_executor','MEMBER') or
    pg_has_role('service_role','pos_ledger_executor','MEMBER') then raise exception 'Unsafe pos_ledger_executor'; end if;
end $$;
grant pos_ledger_executor to postgres;
grant usage on schema pos_private to pos_ledger_executor;
grant select on pos_private.chains,pos_private.installations,pos_private.organizations,pos_private.festivals,pos_private.installation_keys,
  pos_private.terminal_ranges,pos_private.ledger_events,pos_private.sales,pos_private.sync_receipts,pos_private.auth_challenges to pos_ledger_executor;
grant insert on pos_private.ledger_events,pos_private.sales,pos_private.sync_receipts to pos_ledger_executor;
grant update(head_sequence,head_hash) on pos_private.chains to pos_ledger_executor;
grant update(expires_at) on pos_private.auth_challenges to pos_ledger_executor;
-- PostgreSQL row-locks require an UPDATE privilege; no callable mutation path is exposed.
grant update(organization_id) on pos_private.organizations,pos_private.festivals to pos_ledger_executor;
grant update(installation_id) on pos_private.installations,pos_private.installation_keys to pos_ledger_executor;
do $$ declare t text; begin
  foreach t in array array['chains','installations','organizations','festivals','installation_keys','terminal_ranges','ledger_events','sales','sync_receipts','auth_challenges'] loop
    execute format('create policy ledger_executor on pos_private.%I to pos_ledger_executor using(true) with check(true)',t);
  end loop;
end $$;

-- Private helpers and triggers are never client RPCs, including the recovery overload.
revoke all on all functions in schema pos_private from public,anon,service_role;
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace = 'pos_private'::regnamespace and
    (proname like 'sync_%' or proname in ('utf16_key','require_sync_session') or proname = 'consume_installation_proof') loop
    execute format('revoke all on function %s from authenticated',f.signature);
    execute format('grant execute on function %s to pos_ledger_executor',f.signature);
  end loop;
end $$;
grant execute on function pos_private.require_installation(uuid,jsonb),pos_private.guard_append(),pos_private.advance_head(),
  pos_private.guard_chain(),pos_private.require_receipt(),pos_private.guard_receipt() to pos_ledger_executor;
revoke all on function public.ledger_ingest_v1(uuid,uuid,text,uuid),public.legacy_import_v1(uuid,uuid,text,uuid),
  public.ledger_prefix_v1(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.ledger_ingest_v1(uuid,uuid,text,uuid),public.legacy_import_v1(uuid,uuid,text,uuid),
  public.ledger_prefix_v1(uuid,uuid,text,uuid) to service_role;
grant create on schema public to pos_ledger_executor;
alter function public.ledger_ingest_v1(uuid,uuid,text,uuid) owner to pos_ledger_executor;
alter function public.legacy_import_v1(uuid,uuid,text,uuid) owner to pos_ledger_executor;
alter function public.ledger_prefix_v1(uuid,uuid,text,uuid) owner to pos_ledger_executor;
revoke create on schema public from pos_ledger_executor;
