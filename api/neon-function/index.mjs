import pg from "pg";
import { timingSafeEqual } from "node:crypto";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
pool.on("error", e => console.error("[db]", e?.message || "pool error"));
const ORIGINS = new Set(["https://leorbr27.github.io", "http://localhost:8000", "http://127.0.0.1:8000"]);
function reply(body, status=200, origin="") {
  const headers={"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Vary":"Origin"};
  if(origin && ORIGINS.has(origin)){headers["Access-Control-Allow-Origin"]=origin;headers["Access-Control-Allow-Methods"]="GET, POST, PUT, OPTIONS";headers["Access-Control-Allow-Headers"]="Content-Type, Authorization";}
  return new Response(JSON.stringify(body),{status,headers});
}
const txt=(v,fallback="")=>String(v??"").replace(/\s+/g," ").trim()||fallback;
function money(v){
  if(typeof v==="number")return Number.isFinite(v)?v:NaN;
  let s=String(v??"").trim().replace(/\s/g,"").replace(/^R\$/i,""); if(!s)return NaN;
  if(s.includes(",")&&s.includes(".")){if(s.lastIndexOf(",")>s.lastIndexOf("."))s=s.replace(/\./g,"").replace(",",".");else s=s.replace(/,/g,"");}
  else if(s.includes(","))s=s.replace(",",".");
  const n=Number(s);return Number.isFinite(n)?n:NaN;
}
function signature(store,product,pack,supplied){
  if(txt(supplied))return txt(supplied).slice(0,200);
  return [store,product,pack].map(v=>String(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim()).join("|").slice(0,200);
}
function sanitize(v){
  const x=v&&typeof v==="object"&&!Array.isArray(v)?v:{};
  const store=txt(x.store??x.supermercado??x.market), product=txt(x.product??x.descricao??x.produto??x.name);
  const pack=txt(x.package??x.peso_quantidade??x.embalagem??x.presentation,"Não informada");
  const price=money(x.price??x.preco??x.valor);
  if(!store)throw Error("Supermercado ausente."); if(!product)throw Error("Nome do produto ausente.");
  if(!Number.isFinite(price)||price<0)throw Error("Preço inválido.");
  const original=x.dados_originais&&typeof x.dados_originais==="object"&&!Array.isArray(x.dados_originais)?{...x.dados_originais}:{...x};
  if(!txt(original.marca??original.brand))original.marca="Não informada";
  if(!txt(original.peso_quantidade??original.package??original.embalagem))original.peso_quantidade=pack;
  return {store,product,pack,price,signature:signature(store,product,pack,x.signature??x.assinatura),original};
}
function authorized(req,origin){
  const auth=req.headers.get("authorization")||"";
  if(auth){
    const supplied=auth.replace(/^Bearer\s+/i,"").trim(), expected=process.env.APP_WRITE_TOKEN||"";
    if(!supplied||!expected)return false;
    const a=Buffer.from(supplied),b=Buffer.from(expected);
    return a.length===b.length&&timingSafeEqual(a,b);
  }
  // Modo público para o site estático: o segredo nunca é enviado ao navegador.
  // Origin/CORS restringe navegadores comuns, mas não autentica clientes não-browser.
  return Boolean(origin&&ORIGINS.has(origin));
}
async function save(client,o){
  let found=await client.query("SELECT id,preco FROM public.ofertas_gemini WHERE assinatura=$1 FOR UPDATE",[o.signature]);
  let id,old=null;
  if(found.rowCount){
    id=found.rows[0].id;old=found.rows[0].preco==null?null:Number(found.rows[0].preco);
    await client.query("UPDATE public.ofertas_gemini SET supermercado=$2,descricao=$3,peso_quantidade=$4,preco=$5,dados_originais=$6::jsonb,registrado_em=NOW() WHERE id=$1",[id,o.store,o.product,o.pack,o.price,JSON.stringify(o.original)]);
  }else{
    let ins=await client.query("INSERT INTO public.ofertas_gemini(supermercado,descricao,peso_quantidade,preco,dados_originais,assinatura) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(assinatura) DO NOTHING RETURNING id",[o.store,o.product,o.pack,o.price,JSON.stringify(o.original),o.signature]);
    if(ins.rowCount)id=ins.rows[0].id;
    else{
      found=await client.query("SELECT id,preco FROM public.ofertas_gemini WHERE assinatura=$1 FOR UPDATE",[o.signature]);
      if(!found.rowCount)throw Error("Não foi possível resolver uma oferta duplicada; tente novamente.");
      id=found.rows[0].id;old=found.rows[0].preco==null?null:Number(found.rows[0].preco);
      await client.query("UPDATE public.ofertas_gemini SET supermercado=$2,descricao=$3,peso_quantidade=$4,preco=$5,dados_originais=$6::jsonb,registrado_em=NOW() WHERE id=$1",[id,o.store,o.product,o.pack,o.price,JSON.stringify(o.original)]);
    }
  }
  if(old===null||old!==o.price)await client.query("INSERT INTO public.historico_precos_gemini(oferta_id,preco,origem,observacao) VALUES($1,$2,'api',$3)",[id,o.price,old===null?"Preço registrado/importado":"Preço alterado via API"]);
  return {id,store:o.store,product:o.product,package:o.pack,price:o.price};
}
async function edit(idValue,priceValue){
  const id=Number(idValue),price=money(priceValue);if(!Number.isSafeInteger(id)||id<=0)throw Error("Identificador de oferta inválido.");if(!Number.isFinite(price)||price<0)throw Error("Preço inválido.");
  const c=await pool.connect();try{await c.query("BEGIN");const q=await c.query("SELECT id,preco FROM public.ofertas_gemini WHERE id=$1 FOR UPDATE",[id]);if(!q.rowCount){await c.query("ROLLBACK");return null;}
  const old=q.rows[0].preco==null?null:Number(q.rows[0].preco);await c.query("UPDATE public.ofertas_gemini SET preco=$2,registrado_em=NOW() WHERE id=$1",[id,price]);
  if(old===null||old!==price)await c.query("INSERT INTO public.historico_precos_gemini(oferta_id,preco,origem,observacao) VALUES($1,$2,'api','Preço editado pela interface')",[id,price]);
  await c.query("COMMIT");return {id,price,previousPrice:old};}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
}
export default { async fetch(req){
  const origin=req.headers.get("origin")||"";
  if(req.method==="OPTIONS"){if(!ORIGINS.has(origin))return reply({error:"Origem não permitida."},403,origin);return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET, POST, PUT, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Access-Control-Max-Age":"86400","Vary":"Origin"}});}
  try{
    if(req.method==="GET"){
      const q=await pool.query("SELECT o.id,o.supermercado,o.descricao,o.peso_quantidade,o.preco,o.dados_originais,o.assinatura,o.registrado_em,(SELECT h.preco FROM public.historico_precos_gemini h WHERE h.oferta_id=o.id ORDER BY h.registrado_em DESC,h.id DESC OFFSET 1 LIMIT 1) AS preco_anterior FROM public.ofertas_gemini o ORDER BY o.registrado_em DESC,o.id DESC");
      return reply(q.rows,200,origin);
    }
    if(req.method==="POST"){
      if(!authorized(req,origin))return reply({error:"Gravação não autorizada."},401,origin);
      const body=await req.json(),items=Array.isArray(body)?body:(Array.isArray(body?.offers)?body.offers:[body]);
      if(!items.length||items.length>200)return reply({error:"Envie de 1 a 200 ofertas."},400,origin);
      const offers=items.map((x,i)=>{try{return sanitize(x);}catch(e){throw Error("Oferta "+(i+1)+": "+e.message);}});
      const c=await pool.connect();try{await c.query("BEGIN");const saved=[];for(const o of offers)saved.push(await save(c,o));await c.query("COMMIT");return reply({success:true,saved:saved.length,offers:saved},201,origin);}catch(e){await c.query("ROLLBACK").catch(()=>{});throw e;}finally{c.release();}
    }
    if(req.method==="PUT"){
      if(!authorized(req,origin))return reply({error:"Atualização não autorizada."},401,origin);
      const body=await req.json();if(body?.confirmed!==true)return reply({error:"Confirme a atualização do preço."},400,origin);
      const result=await edit(body.id,body.price??body.preco);if(!result)return reply({error:"Oferta não encontrada."},404,origin);
      return reply({success:true,...result},200,origin);
    }
    return reply({error:"Método não permitido."},405,origin);
  }catch(e){const m=String(e?.message||"Erro interno.");const bad=/Supermercado ausente|Nome do produto ausente|Preço inválido|Oferta \d+:/i.test(m);console.error("[api]",m);return reply({error:bad?m:"Erro interno ao processar a operação."},bad?400:500,origin);}
}};
