#!/usr/bin/env python3
"""Daily offer collector. Credentials remain in the GitHub Actions runner."""
import os,re,json,hashlib,base64,sys,unicodedata
from datetime import datetime,timezone
from urllib.parse import urljoin,urlparse
import requests
from bs4 import BeautifulSoup
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API=os.environ.get("NEON_OFFERS_API","https://br-wandering-resonance-b4w2m30c-geminiofertas.compute.c-6.us-east-2.aws.neon.tech")
TOKEN=os.environ["APP_WRITE_TOKEN"]; GEMINI_KEY=os.environ["GEMINI_API_KEY"]
MODEL=os.environ.get("GEMINI_MODEL","gemini-3.8-flash")
HEADERS={"User-Agent":"SupermercadoPriceMonitor/1.0 (+official-public-offer-monitor)"}
EXCLUDED=re.compile(r"\b(cerveja|cervejas|beer)\b",re.I)
OFFER_LINK=re.compile(r"(oferta|ofertas|encarte|folheto|promoc|campanha|tabloide)",re.I)
SCHEMA={"type":"ARRAY","items":{"type":"OBJECT","properties":{
"store":{"type":"STRING"},"product":{"type":"STRING"},"brand":{"type":"STRING"},
"package":{"type":"STRING"},"price":{"type":"NUMBER"},"valid_from":{"type":"STRING"},
"valid_until":{"type":"STRING"},"conditions":{"type":"STRING"},"evidence_quote":{"type":"STRING"}},
"required":["store","product","price","evidence_quote"]}}
session=requests.Session(); session.headers.update(HEADERS)
def api(method,path,payload=None):
 r=session.request(method,API.rstrip("/")+path,json=payload,headers={"Authorization":"Bearer "+TOKEN,"Content-Type":"application/json"},timeout=45); r.raise_for_status(); return r.json() if r.content else {}
def digest(data): return hashlib.sha256(data).hexdigest()
def page_candidates(source):
 urls=[source["url"]]+source.get("secondary_urls",[]); found=[]
 for url in urls:
  if not url: continue
  try:
   r=session.get(url,timeout=35); r.raise_for_status(); mime=r.headers.get("Content-Type","").split(";")[0].lower(); raw=r.content
   if "pdf" in mime or url.lower().endswith(".pdf"): found.append((url,"application/pdf",raw,"")); continue
   if mime.startswith("image/"): found.append((url,mime,raw,"")); continue
   if "html" not in mime and not raw.lstrip().startswith(b"<"): continue
   soup=BeautifulSoup(raw,"html.parser")
   for tag in soup(["script","style","noscript","svg"]): tag.decompose()
   text=" ".join(soup.get_text(" ",strip=True).split())
   if text: found.append((url,"text/html",raw,text[:90000]))
   origin=urlparse(url)
   for a in soup.find_all("a",href=True):
    href=urljoin(url,a["href"]); parsed=urlparse(href)
    if parsed.scheme not in ("http","https") or not OFFER_LINK.search(a.get_text(" ",strip=True)+" "+href): continue
    if parsed.netloc!=origin.netloc: continue
    if href.lower().split("?")[0].endswith(".pdf"):
     try:
      pr=session.get(href,timeout=30); pr.raise_for_status(); found.append((href,"application/pdf",pr.content,""))
     except Exception: pass
   for img in soup.find_all("img",src=True):
    href=urljoin(url,img["src"])
    if OFFER_LINK.search(img.get("alt","")+" "+href):
     try:
      ir=session.get(href,timeout=25); ir.raise_for_status(); typ=ir.headers.get("Content-Type","").split(";")[0].lower()
      if typ.startswith("image/"): found.append((href,typ,ir.content,""))
     except Exception: pass
  except Exception as e: print(f"[WARN] {source['name']} {url}: {e}",flush=True)
 unique={}
 for item in found: unique[item[0]]=item
 return list(unique.values())[:12]
def gemini_extract(store,url,mime,raw,text):
 prompt=("Extraia somente ofertas comprovadas no material. Supermercado de origem: "+store+
 ". Não invente preço, marca, embalagem ou datas. Retorne array JSON com store, product, brand, package, price (número em reais), valid_from e valid_until (YYYY-MM-DD ou vazio), conditions e evidence_quote (trecho literal que comprove produto e preço). Sem validade explícita, deixe vazia. Ignore cerveja e bebidas alcoólicas. Ignore preços riscados/de. Se não houver ofertas inequívocas, retorne []. Fonte: "+url+". MATERIAL:\n"+text[:80000])
 parts=[{"text":prompt}]
 if mime in ("application/pdf","image/jpeg","image/png","image/webp") and raw:
  parts.append({"inline_data":{"mime_type":mime,"data":base64.b64encode(raw).decode("ascii")}})
 body={"contents":[{"role":"user","parts":parts}],"generationConfig":{"response_mime_type":"application/json","response_schema":SCHEMA,"temperature":0}}
 endpoint=f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={GEMINI_KEY}"
 r=session.post(endpoint,json=body,timeout=120); r.raise_for_status()
 output="".join(p.get("text","") for p in r.json()["candidates"][0]["content"]["parts"])
 parsed=json.loads(output); return parsed if isinstance(parsed,list) else []
def iso_date(value):
 try:
  value=str(value or "").strip()
  if not re.fullmatch(r"\d{4}-\d{2}-\d{2}",value): return None
  datetime.strptime(value,"%Y-%m-%d")
  return value
 except Exception: return None
def confidence(o,text):
 score=10
 if str(o.get("product","")).strip(): score+=25
 try:
  if 0<float(o.get("price"))<=100000: score+=25
 except Exception: pass
 if str(o.get("package","")).strip(): score+=10
 valid=iso_date(o.get("valid_until"))
 if valid: score+=20
 quote=str(o.get("evidence_quote","")).strip()
 if quote and (quote.casefold() in text.casefold() if text else True): score+=10
 return min(100,score)
def main():
 with open(os.path.join(ROOT,"automation","fontes.json"),encoding="utf-8") as f: registry=json.load(f)
 sources=registry["sources"]; publications=[]; errors=0; queried=0
 for source in sources:
  if not source.get("enabled") or source.get("mode") != "official_web" or not source.get("url"):
   print(f"[SKIP] {source['name']}: canal oficial ainda não confirmado",flush=True); continue
  queried+=1
  for url,mime,raw,text in page_candidates(source):
   if len(raw)>18*1024*1024: continue
   content_hash=digest(raw if raw else text.encode())
   if api("GET",f"/automacao/seen?fonte={source['id']}&hash={content_hash}").get("seen"): continue
   try:
    extracted=gemini_extract(source["name"],url,mime,raw,text); normalized=[]
    for item in extracted:
     if EXCLUDED.search(str(item.get("product",""))): continue
     try: price=float(item.get("price"))
     except Exception: continue
     if not item.get("product") or not (0<price<=100000): continue
     score=confidence(item,text); status="approved" if score>=95 else ("pending" if score>=60 else "archived")
     normalize_key=lambda value: re.sub(r"[^a-z0-9]+"," ",unicodedata.normalize("NFD",str(value or "")).encode("ascii","ignore").decode("ascii").lower()).strip()
     signature="|".join(normalize_key(value) for value in [source["name"],item["product"],item.get("package","")])[:200]
     fingerprint=hashlib.sha256("|".join([source["id"],signature,str(iso_date(item.get("valid_until")) or ""),str(round(price,2))]).encode()).hexdigest()
     normalized.append({"store":source["name"],"product":str(item["product"]).strip(),"brand":str(item.get("brand","")).strip(),
      "package":str(item.get("package","")).strip(),"price":round(price,2),"valid_from":iso_date(item.get("valid_from")),
      "valid_until":iso_date(item.get("valid_until")),"conditions":item.get("conditions",""),"evidence_quote":item.get("evidence_quote",""),
      "confidence":score,"status":status,"source_url":url,"signature":signature,"fingerprint":fingerprint})
    original_base64=base64.b64encode(raw).decode("ascii") if mime in ("application/pdf","image/jpeg","image/png","image/webp") and raw and len(raw)<=4*1024*1024 else None
    publications.append({"source_id":source["id"],"url":url,"hash":content_hash,"content_type":mime,"text":text[:50000],"original_base64":original_base64,"offers":normalized})
    print(f"[OK] {source['name']}: {len(normalized)} ofertas",flush=True)
   except Exception as e: errors+=1; print(f"[ERROR] {source['name']} {url}: {e}",flush=True)
 payload={"run":{"sources_total":len(sources),"sources_checked":queried,"publications_found":len(publications),"errors":errors},"publications":publications}
 result=api("POST","/automacao/ingest",payload)
 print(json.dumps({"ingested":result,"sources_checked":queried,"errors":errors},ensure_ascii=False))
 if errors and not publications: sys.exit(1)
if __name__=="__main__": main()
