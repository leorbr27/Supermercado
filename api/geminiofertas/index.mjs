import { neon } from "@neondatabase/serverless";

const ALLOWED_ORIGIN = "https://leorbr27.github.io";
const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});
const text = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const priceValue = v => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) throw new Error("Preço inválido.");
  return n;
};
const authorized = req => Boolean(process.env.APP_WRITE_TOKEN &&
  req.headers.get("Authorization") === "Bearer " + process.env.APP_WRITE_TOKEN);

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) return reply({ error: "Origem não permitida." }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!process.env.DATABASE_URL) return reply({ error: "DATABASE_URL não configurada na função Neon." }, 503);
    const sql = neon(process.env.DATABASE_URL);
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ofertas")) {
        const store = text(url.searchParams.get("supermercado"), 200) || null;
        const min = url.searchParams.has("min") ? priceValue(url.searchParams.get("min")) : null;
        const max = url.searchParams.has("max") ? priceValue(url.searchParams.get("max")) : null;
        const after = url.searchParams.get("atualizadoDepois") || null;
        const order = url.searchParams.get("ordenar") === "supermercado"
          ? "supermercado"
          : url.searchParams.get("ordenar") === "preco" ? "preco" : "recentes";
        const rows = await sql`
          SELECT o.id, o.supermercado, o.descricao, o.peso_quantidade, o.preco,
                 o.dados_originais, o.registrado_em,
                 (SELECT h.preco
                    FROM public.historico_precos_gemini h
                   WHERE h.oferta_id = o.id
                     AND h.registrado_em < o.registrado_em
                   ORDER BY h.registrado_em DESC LIMIT 1) AS preco_anterior
            FROM public.ofertas_gemini o
           WHERE (${store}::text IS NULL OR o.supermercado ILIKE '%' || ${store} || '%')
             AND (${min}::numeric IS NULL OR o.preco >= ${min})
             AND (${max}::numeric IS NULL OR o.preco <= ${max})
             AND (${after}::timestamptz IS NULL OR o.registrado_em >= ${after})
           ORDER BY
             CASE WHEN ${order} = 'supermercado' THEN o.supermercado END ASC NULLS LAST,
             CASE WHEN ${order} = 'preco' THEN o.preco END ASC NULLS LAST,
             o.registrado_em DESC
           LIMIT 5000
        `;
        return reply(rows);
      }

      if (request.method === "POST") {
        if (!authorized(request)) return reply({ error: "Autenticação necessária para gravar ofertas." }, 401);
        const body = await request.json();
        const store = text(body.store ?? body.supermercado, 200);
        const product = text(body.product ?? body.descricao, 500);
        const pack = text(body.package ?? body.peso_quantidade, 200);
        const price = priceValue(body.price ?? body.preco);
        if (!store || !product) return reply({ error: "Informe supermercado e produto." }, 400);
        const signature = text(body.signature ?? body.assinatura, 200) || null;
        const original = JSON.stringify(body.dados_originais ?? body);
        let saved;
        if (signature) {
          saved = await sql`
            WITH offer AS (
              INSERT INTO public.ofertas_gemini
                (supermercado, descricao, peso_quantidade, preco, dados_originais, assinatura)
              VALUES (${store}, ${product}, ${pack}, ${price}, ${original}::jsonb, ${signature})
              ON CONFLICT (assinatura) DO UPDATE SET
                supermercado = EXCLUDED.supermercado,
                descricao = EXCLUDED.descricao,
                peso_quantidade = EXCLUDED.peso_quantidade,
                preco = EXCLUDED.preco,
                dados_originais = EXCLUDED.dados_originais,
                registrado_em = now()
              RETURNING *
            ), history AS (
              INSERT INTO public.historico_precos_gemini (oferta_id, preco, origem)
              SELECT id, ${price}, 'api' FROM offer
              RETURNING id
            )
            SELECT offer.* FROM offer
          `;
        } else {
          saved = await sql`
            WITH offer AS (
              INSERT INTO public.ofertas_gemini
                (supermercado, descricao, peso_quantidade, preco, dados_originais)
              VALUES (${store}, ${product}, ${pack}, ${price}, ${original}::jsonb)
              RETURNING *
            ), history AS (
              INSERT INTO public.historico_precos_gemini (oferta_id, preco, origem)
              SELECT id, ${price}, 'api' FROM offer
              RETURNING id
            )
            SELECT offer.* FROM offer
          `;
        }
        return reply({ offer: saved[0] }, 201);
      }

      if (request.method === "PUT") {
        if (!authorized(request)) return reply({ error: "Autenticação necessária para alterar preços." }, 401);
        const body = await request.json();
        const id = Number(body.id);
        if (!Number.isSafeInteger(id) || id < 1) return reply({ error: "ID inválido." }, 400);
        const price = priceValue(body.price ?? body.preco);
        const observation = text(body.observacao, 500) || null;
        const source = body.confirmed ? "confirmacao" : "edicao";
        const updated = await sql`
          WITH changed AS (
            UPDATE public.ofertas_gemini
               SET preco = ${price}, registrado_em = now()
             WHERE id = ${id} AND preco IS DISTINCT FROM ${price}::numeric
             RETURNING *
          ), history AS (
            INSERT INTO public.historico_precos_gemini (oferta_id, preco, origem, observacao)
            SELECT id, ${price}, ${source}, ${observation} FROM changed
            RETURNING id
          ), result AS (
            SELECT * FROM changed
            UNION ALL
            SELECT o.* FROM public.ofertas_gemini o
             WHERE o.id = ${id} AND NOT EXISTS (SELECT 1 FROM changed)
          )
          SELECT * FROM result LIMIT 1
        `;
        if (!updated.length) return reply({ error: "Oferta não encontrada." }, 404);
        return reply({ offer: updated[0] });
      }

      return reply({ error: "Método ou rota não suportados." }, 405);
    } catch (e) {
      console.error("geminiofertas:", e);
      return reply({ error: "Não foi possível concluir a operação no banco de dados." }, 500);
    }
  }
};
