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


async function persistApproved(sql, offer) {
  const store=text(offer.supermercado), product=text(offer.produto), pack=text(offer.embalagem,"Não informada");
  const price=priceValue(offer.preco), signature=text(offer.assinatura,200);
  const original=JSON.stringify({origem:"coleta_automatica",evidencia:offer.evidencias,url_fonte:offer.url_fonte,marca:offer.marca,validade_inicio:offer.validade_inicio,validade_fim:offer.validade_fim,condicoes:offer.condicoes,confianca:offer.confianca});
  const existing=await sql`SELECT id,preco FROM public.ofertas_gemini WHERE assinatura=${signature} LIMIT 1`;
  let id, oldPrice=null;
  if(existing.length){
    id=existing[0].id; oldPrice=existing[0].preco===null?null:Number(existing[0].preco);
    await sql`UPDATE public.ofertas_gemini SET supermercado=${store},descricao=${product},peso_quantidade=${pack},preco=${price},dados_originais=${original}::jsonb,registrado_em=now() WHERE id=${id}`;
  } else {
    const inserted=await sql`INSERT INTO public.ofertas_gemini(supermercado,descricao,peso_quantidade,preco,dados_originais,assinatura) VALUES(${store},${product},${pack},${price},${original}::jsonb,${signature}) ON CONFLICT(assinatura) DO NOTHING RETURNING id`;
    if(inserted.length) id=inserted[0].id;
    else {
      const raced=await sql`SELECT id,preco FROM public.ofertas_gemini WHERE assinatura=${signature} LIMIT 1`;
      if(!raced.length) throw new Error("Não foi possível resolver assinatura duplicada.");
      id=raced[0].id; oldPrice=raced[0].preco===null?null:Number(raced[0].preco);
      await sql`UPDATE public.ofertas_gemini SET supermercado=${store},descricao=${product},peso_quantidade=${pack},preco=${price},dados_originais=${original}::jsonb,registrado_em=now() WHERE id=${id}`;
    }
  }
  if(oldPrice===null || oldPrice!==price) await sql`INSERT INTO public.historico_precos_gemini(oferta_id,preco,origem,observacao) VALUES(${id},${price},'coleta_automatica','Aprovada automaticamente ou por revisão humana')`;
  return id;
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) return reply({ error: "Origem não permitida." }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!process.env.DATABASE_URL) return reply({ error: "DATABASE_URL não configurada na função Neon." }, 503);
    const sql = neon(process.env.DATABASE_URL);
    const url = new URL(request.url);

    try {

      if (url.pathname === "/automacao/pendentes" && request.method === "GET") {
        if (!authorized(request)) return reply({ error: "Não autorizado." }, 401);
        const rows=await sql`SELECT id,supermercado,produto,marca,embalagem,preco,validade_inicio,validade_fim,condicoes,confianca,evidencias,url_fonte,criado_em FROM public.ofertas_pendentes WHERE status='pending' ORDER BY criado_em DESC LIMIT 100`;
        return reply({ pending: rows });
      }
      if (url.pathname === "/automacao/seen" && request.method === "GET") {
        if (!authorized(request)) return reply({ error: "Não autorizado." }, 401);
        const source=text(url.searchParams.get("fonte"),100), hash=text(url.searchParams.get("hash"),100);
        if (!source || !hash) return reply({ error: "Fonte e hash são obrigatórios." }, 400);
        const rows=await sql`SELECT 1 FROM public.coletas_publicacoes WHERE fonte_id=${source} AND hash_conteudo=${hash} LIMIT 1`;
        return reply({ seen: rows.length>0 });
      }
      if (url.pathname === "/automacao/ingest" && request.method === "POST") {
        if (!authorized(request)) return reply({ error: "Não autorizado." }, 401);
        const body=await request.json(), publications=Array.isArray(body.publications)?body.publications:[];
        if(publications.length>200) return reply({error:"Limite de 200 publicações por execução."},400);
        const run=body.run||{};
        const created=await sql`INSERT INTO public.coletas_execucoes(fontes_total,fontes_consultadas,publicacoes_encontradas,erros,resumo) VALUES(${Number(run.sources_total)||0},${Number(run.sources_checked)||0},${publications.length},${Number(run.errors)||0},${JSON.stringify(run)}::jsonb) RETURNING id`;
        const runId=created[0].id; let insertedPublications=0, extracted=0, approved=0, pending=0, rejected=0;
        for(const publication of publications){
          const sourceId=text(publication.source_id,100), pubUrl=text(publication.url,2000), hash=text(publication.hash,128);
          if(!sourceId||!pubUrl||!hash) continue;
          const pub=await sql`INSERT INTO public.coletas_publicacoes(fonte_id,url,hash_conteudo,tipo_conteudo,texto_extraido,metadados) VALUES(${sourceId},${pubUrl},${hash},${text(publication.content_type,100)},${text(publication.text,50000)},${JSON.stringify({run_id:runId})}::jsonb) ON CONFLICT(fonte_id,hash_conteudo) DO NOTHING RETURNING id`;
          if(!pub.length) continue;
          insertedPublications++; const pubId=pub[0].id, offers=Array.isArray(publication.offers)?publication.offers:[];
          for(const offer of offers){
            const product=text(offer.product,500), store=text(offer.store,200), price=priceValue(offer.price);
            if(!product||!store||/\b(cerveja|cervejas|beer)\b/i.test(product)) continue;
            const confidence=Math.max(0,Math.min(100,Number(offer.confidence)||0));
            const status=confidence>=95?"approved":confidence>=60?"pending":"archived";
            const signature=text(offer.signature,200), fingerprint=text(offer.fingerprint,200); if(!signature||!fingerprint) continue;
            const inserted=await sql`INSERT INTO public.ofertas_pendentes(publicacao_id,supermercado,produto,marca,embalagem,preco,validade_inicio,validade_fim,condicoes,confianca,status,evidencias,url_fonte,chave_oferta,assinatura,motivo_decisao)
              VALUES(${pubId},${store},${product},${text(offer.brand,200)},${text(offer.package,200)},${price},${offer.valid_from||null},${offer.valid_until||null},${text(offer.conditions,1000)},${confidence},${status},${text(offer.evidence_quote,2000)},${text(offer.source_url,2000)},${signature},${fingerprint},${status==="approved"?"Aprovação automática: confiança >= 95%":status==="pending"?"Aguardando revisão humana":"Confiança inferior a 60%; arquivada"})
              ON CONFLICT(assinatura) DO NOTHING RETURNING id`;
            if(!inserted.length) continue;
            extracted++;
            if(status==="approved"){await persistApproved(sql,{supermercado:store,produto:product,embalagem:offer.package,preco:price,assinatura:signature,evidencias:offer.evidence_quote,url_fonte:offer.source_url,marca:offer.brand,validade_inicio:offer.valid_from,validade_fim:offer.valid_until,condicoes:offer.conditions,confianca:confidence});approved++;}
            else if(status==="pending") pending++; else rejected++;
          }
        }
        await sql`UPDATE public.coletas_execucoes SET finalizada_em=now(),status='completed',publicacoes_encontradas=${insertedPublications},ofertas_extraidas=${extracted},aprovadas_automaticamente=${approved},pendentes_revisao=${pending},rejeitadas=${rejected} WHERE id=${runId}`;
        return reply({success:true,run_id:runId,publications:insertedPublications,offers:extracted,approved,pending,archived:rejected});
      }
      if (url.pathname === "/automacao/revisar" && request.method === "POST") {
        if (!authorized(request)) return reply({ error: "Não autorizado." }, 401);
        const body=await request.json(), id=Number(body.id), decision=text(body.decision,20);
        if(!Number.isSafeInteger(id)||id<1||!["approve","reject","archive"].includes(decision)) return reply({error:"ID ou decisão inválidos."},400);
        const rows=await sql`SELECT * FROM public.ofertas_pendentes WHERE id=${id} LIMIT 1`;
        if(!rows.length) return reply({error:"Oferta pendente não encontrada."},404);
        const offer=rows[0]; if(offer.status!=="pending") return reply({error:"A oferta não está aguardando revisão."},409);
        if(decision==="approve") await persistApproved(sql,{supermercado:offer.supermercado,produto:offer.produto,embalagem:offer.embalagem,preco:offer.preco,assinatura:offer.chave_oferta,evidencias:offer.evidencias,url_fonte:offer.url_fonte,marca:offer.marca,validade_inicio:offer.validade_inicio,validade_fim:offer.validade_fim,condicoes:offer.condicoes,confianca:offer.confianca});
        const newStatus=decision==="approve"?"approved":decision==="reject"?"rejected":"archived";
        await sql`UPDATE public.ofertas_pendentes SET status=${newStatus},motivo_decisao=${"Revisão humana: "+decision},revisado_em=now() WHERE id=${id}`;
        return reply({success:true,id,status:newStatus});
      }

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
