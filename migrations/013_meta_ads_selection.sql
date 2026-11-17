-- Meta Ads: a empresa e a conta de anúncios passam a ser ESCOLHIDAS (antes a API gravava o primeiro item que a Meta devolvia).
-- selection_confirmed_at: preenchido quando alguém confirma a escolha (ou a informa manualmente); vazio = ainda não confirmada.
-- Idempotente. Conexões já existentes ficam com a coluna vazia: a tela pede uma confirmação, sem alterar nada sozinha.
alter table public.meta_ads_connections add column if not exists selection_confirmed_at timestamptz null;
