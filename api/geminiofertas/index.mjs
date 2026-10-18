import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
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
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/ofertas")) {
        const store = text(url.searchParams.get("supermercado"), 200);
        const min = url.searchParams.has("min") ? priceValue(url.searchParams.get("min")) : null;
        const max = url.searchParams.has("max") ? priceValue(url.searchParams.get("max")) : null;
        const after = url.searchParams.get("atualizadoDepois") || null;
        const order = url.searchParams.get("ordenar") === "supermercado"
          ? "o.supermercado ASC NULLS LAST, o.registrado_em DESC"
          : url.searchParams.get("ordenar") === "preco"
            ? "o.preco ASC NULLS LAST, o.registrado_em DESC"
            : "o.registrado_em DESC";
        const result = await pool.query(
          "SELECT o.id, o.supermercado, o.descricao, o.peso_quantidade, o.preco, o.dados_originais, o.registrado_em, " +
          "(SELECT h.preco FROM public.historico_precos_gemini h WHERE h.oferta_id=o.id AND h.preco<>o.preco ORDER BY h.registrado_em DESC LIMIT 1) AS preco_anterior " +
          "FROM public.ofertas_gemini o WHERE ($1::text IS NULL OR o.supermercado ILIKE '%' || $1 || '%') " +
          "AND ($2::numeric IS NULL OR o.preco >= $2) AND ($3::numeric IS NULL OR o.preco <= $3) " +
          "AND ($4::timestamptz IS NULL OR o.registrado_em >= $4) ORDER BY " + order + " LIMIT 5000",
          [store || null, min, max, after]
        );
        return reply({ offers: result.rows, count: result.rowCount });
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
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          let saved;
          if (signature) {
            saved = await client.query(
              "INSERT INTO public.ofertas_gemini (supermercado,descricao,peso_quantidade,preco,dados_originais,assinatura) VALUES ($1,$2,$3,$4,$5::jsonb,$6) " +
              "ON CONFLICT (assinatura) DO UPDATE SET supermercado=EXCLUDED.supermercado,descricao=EXCLUDED.descricao,peso_quantidade=EXCLUDED.peso_quantidade,preco=EXCLUDED.preco,dados_originais=EXCLUDED.dados_originais,registrado_em=now() RETURNING *",
              [store, product, pack, price, original, signature]
            );
          } else {
            saved = await client.query(
              "INSERT INTO public.ofertas_gemini (supermercado,descricao,peso_quantidade,preco,dados_originais) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *",
              [store, product, pack, price, original]
            );
          }
          await client.query("INSERT INTO public.historico_precos_gemini (oferta_id,preco,origem) VALUES ($1,$2,'api')", [saved.rows[0].id, price]);
          await client.query("COMMIT");
          return reply({ offer: saved.rows[0] }, 201);
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally { client.release(); }
      }

      if (request.method === "PUT") {
        if (!authorized(request)) return reply({ error: "Autenticação necessária para alterar preços." }, 401);
        const body = await request.json();
        const id = Number(body.id);
        if (!Number.isSafeInteger(id) || id < 1) return reply({ error: "ID inválido." }, 400);
        const price = priceValue(body.price ?? body.preco);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const current = await client.query("SELECT id,preco FROM public.ofertas_gemini WHERE id=$1 FOR UPDATE", [id]);
          if (!current.rowCount) {
            await client.query("ROLLBACK");
            return reply({ error: "Oferta não encontrada." }, 404);
          }
          if (Number(current.rows[0].preco) !== price) {
            await client.query("UPDATE public.ofertas_gemini SET preco=$1,registrado_em=now() WHERE id=$2", [price, id]);
            await client.query("INSERT INTO public.historico_precos_gemini (oferta_id,preco,origem,observacao) VALUES ($1,$2,$3,$4)",
              [id, price, body.confirmed ? "confirmacao" : "edicao", text(body.observacao, 500) || null]);
          }
          const updated = await client.query("SELECT * FROM public.ofertas_gemini WHERE id=$1", [id]);
          await client.query("COMMIT");
          return reply({ offer: updated.rows[0] });
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally { client.release(); }
      }

      return reply({ error: "Método ou rota não suportados." }, 405);
    } catch (e) {
      console.error("geminiofertas:", e);
      return reply({ error: "Não foi possível concluir a operação no banco de dados." }, 500);
    }
  }
};
