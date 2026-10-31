# Coleta automática de ofertas — 22 redes

A rotina está programada para 06:00 (America/Sao_Paulo), diariamente. A lista contém as 22 redes da relação inicial. Fontes sem canal oficial confirmado permanecem cadastradas como `needs_official_source` e não são raspadas até validação; isso evita coleta de perfis falsos ou fontes sem permissão.

## Confiança
- 95–100: aprovação automática, desde que produto, preço, fonte e validade explícita estejam comprovados.
- 60–94,99: revisão humana.
- Abaixo de 60: rejeitar/arquivar.
- Cerveja é sempre excluída.

## Secrets necessários no GitHub Actions
- `GEMINI_API_KEY`: chave da Gemini Developer API (usada apenas no runner, nunca no frontend).
- `APP_WRITE_TOKEN`: mesmo token de escrita já configurado no ambiente da função Neon.

A rotina chama a API pública `geminiofertas` com autenticação Bearer e não recebe nem grava credenciais no navegador. A chave estável supermercado+produto+embalagem atualiza a oferta existente; o fingerprint da publicação impede reprocessamento e mantém o histórico sem duplicar produtos. A chave `NEON_API_KEY` continua restrita ao workflow de implantação da função.

## Observação de operação
As 22 redes entram no cadastro inicial. Treze fontes têm páginas oficiais identificadas e entram na coleta automática inicial. RB e Falqueto ficam em revisão manual porque os canais identificados são sociais; Instagram não é raspado por HTML. Sete fontes aguardam confirmação de canal oficial. Canguru foi marcada como marca legada: unidades da Serra passaram à bandeira BH em 2025. A Rede Mais local de Viana não foi associada ao site homônimo com lojas na Bahia. Instagram não é raspado por HTML: só poderá ser integrado por API oficial/autorizada.
