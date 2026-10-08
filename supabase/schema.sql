-- Controle de Estoque (versão web) — rode UMA vez no Supabase: menu "SQL Editor" → "New query" →
-- cole tudo → "Run". Pode rodar de novo sem problema (não apaga nada).

-- O estado do app inteiro fica numa única linha, JÁ CRIPTOGRAFADO pelo servidor (o Supabase só
-- vê texto cifrado). `versao` evita que duas gravações ao mesmo tempo se sobrescrevam.
create table if not exists public.estado (
  id smallint primary key check (id = 1),
  versao bigint not null,
  dados text not null,
  atualizado_em timestamptz not null default now()
);

-- Ninguém de fora acessa a tabela: só o servidor, com a chave secreta (que ignora o RLS).
alter table public.estado enable row level security;
revoke all on table public.estado from anon, authenticated;
grant select, insert, update on table public.estado to service_role;

-- Fotos e vídeos (também criptografados pelo servidor) num bucket PRIVADO do Storage.
insert into storage.buckets (id, name, public)
values ('midias', 'midias', false)
on conflict (id) do nothing;
