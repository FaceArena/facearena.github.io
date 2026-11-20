alter table public.arena_battle_participants
  alter column owner_id drop not null;
alter table public.arena_battle_participants
  drop constraint if exists arena_battle_participants_owner_id_fkey;
alter table public.arena_battle_participants
  add constraint arena_battle_participants_owner_id_fkey
  foreign key (owner_id) references auth.users(id) on delete set null;

alter table public.arena_photos
  alter column owner_id drop not null,
  alter column object_path drop not null;
alter table public.arena_photos
  drop constraint if exists arena_photos_owner_id_fkey;
alter table public.arena_photos
  add constraint arena_photos_owner_id_fkey
  foreign key (owner_id) references auth.users(id) on delete set null;

create or replace function public.prepare_arena_account_deletion(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $function$
declare
  v_photo_ids uuid[];
  v_active_battle_ids uuid[];
  v_active_battle_count integer := 0;
  v_photo_count integer := 0;
begin
  if p_user_id is null then
    raise exception 'Account id is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  select coalesce(array_agg(id), array[]::uuid[]) into v_photo_ids
  from public.arena_photos where owner_id = p_user_id;
  select coalesce(array_agg(distinct bp.battle_id), array[]::uuid[]) into v_active_battle_ids
  from public.arena_battle_participants bp
  join public.arena_battles b on b.id = bp.battle_id
  where bp.owner_id = p_user_id and b.stage in ('waiting', 'voting');

  update public.arena_photos p
  set status = case when b.opening then 'queued' when bp.side = 'left' then 'champion' else 'queued' end,
      updated_at = now()
  from public.arena_battle_participants bp
  join public.arena_battles b on b.id = bp.battle_id
  where p.id = bp.photo_id
    and bp.owner_id is distinct from p_user_id
    and bp.battle_id = any(v_active_battle_ids);

  update public.arena_lanes l
  set challenger_photo_id = null,
      champion_photo_id = case when l.champion_photo_id = any(v_photo_ids) then null else l.champion_photo_id end,
      updated_at = now()
  where l.lane_id in (select b.lane_id from public.arena_battles b where b.id = any(v_active_battle_ids))
     or l.challenger_photo_id = any(v_photo_ids)
     or l.champion_photo_id = any(v_photo_ids);

  update public.arena_battles
  set stage = 'cancelled', finished_at = now()
  where id = any(v_active_battle_ids) and stage in ('waiting', 'voting');
  get diagnostics v_active_battle_count = row_count;

  update public.arena_battle_participants set owner_id = null where owner_id = p_user_id;
  update public.arena_photos
  set owner_id = null, object_path = null, status = 'removed', updated_at = now()
  where owner_id = p_user_id;
  get diagnostics v_photo_count = row_count;

  return jsonb_build_object('ok', true, 'cancelled_active_battles', v_active_battle_count, 'anonymized_photos', v_photo_count);
end;
$function$;

revoke all on function public.prepare_arena_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.prepare_arena_account_deletion(uuid) to service_role;
