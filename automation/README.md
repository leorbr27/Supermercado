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

A rotina chama a API pública `geminiofertas` com autenticação Bearer e não recebe nem grava credenciais no navegador. A chave `NEON_API_KEY` continua restrita ao workflow de implantação da função.

## Observação de operação
As 22 redes entram no cadastro inicial. Oito fontes têm URL oficial/canal identificado e ficam habilitadas para teste automatizado inicial; as demais ficam no cadastro, mas aguardam confirmação do endereço oficial e do formato de publicação. Instagram não é raspado por HTML: só poderá ser integrado por API oficial/autorizada.
