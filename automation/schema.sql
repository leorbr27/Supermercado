-- Supermercado: automação de coleta de ofertas (migração aditiva)
CREATE TABLE IF NOT EXISTS public.fontes_monitoramento (
  id text PRIMARY KEY,
  nome text NOT NULL,
  url_principal text,
  urls_secundarias jsonb NOT NULL DEFAULT '[]'::jsonb,
  modo_coleta text NOT NULL DEFAULT 'needs_official_source',
  ativo boolean NOT NULL DEFAULT false,
  observacoes text,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.coletas_execucoes (
  id bigserial PRIMARY KEY,
  iniciada_em timestamptz NOT NULL DEFAULT now(),
  finalizada_em timestamptz,
  status text NOT NULL DEFAULT 'running',
  fontes_total integer NOT NULL DEFAULT 0,
  fontes_consultadas integer NOT NULL DEFAULT 0,
  publicacoes_encontradas integer NOT NULL DEFAULT 0,
  ofertas_extraidas integer NOT NULL DEFAULT 0,
  aprovadas_automaticamente integer NOT NULL DEFAULT 0,
  pendentes_revisao integer NOT NULL DEFAULT 0,
  rejeitadas integer NOT NULL DEFAULT 0,
  erros integer NOT NULL DEFAULT 0,
  resumo jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS public.coletas_publicacoes (
  id bigserial PRIMARY KEY,
  fonte_id text NOT NULL REFERENCES public.fontes_monitoramento(id),
  url text NOT NULL,
  hash_conteudo text NOT NULL,
  tipo_conteudo text,
  coletada_em timestamptz NOT NULL DEFAULT now(),
  texto_extraido text,
  status text NOT NULL DEFAULT 'capturada',
  metadados jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (fonte_id, hash_conteudo)
);
CREATE TABLE IF NOT EXISTS public.ofertas_pendentes (
  id bigserial PRIMARY KEY,
  publicacao_id bigint REFERENCES public.coletas_publicacoes(id),
  supermercado text NOT NULL,
  produto text NOT NULL,
  marca text,
  embalagem text,
  preco numeric(12,2) NOT NULL CHECK (preco >= 0),
  validade_inicio date,
  validade_fim date,
  condicoes text,
  confianca numeric(5,2) NOT NULL CHECK (confianca >= 0 AND confianca <= 100),
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','archived')),
  evidencias text,
  url_fonte text NOT NULL,
  chave_oferta text,
  assinatura text NOT NULL UNIQUE,
  motivo_decisao text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  revisado_em timestamptz
);
CREATE INDEX IF NOT EXISTS coletas_publicacoes_fonte_data_idx ON public.coletas_publicacoes(fonte_id, coletada_em DESC);
CREATE INDEX IF NOT EXISTS ofertas_pendentes_status_data_idx ON public.ofertas_pendentes(status, criado_em DESC);
CREATE INDEX IF NOT EXISTS coletas_execucoes_data_idx ON public.coletas_execucoes(iniciada_em DESC);
