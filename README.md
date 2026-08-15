# Baile Madrid 2.0 — Mercado Pago

Esta versão troca o QR Code fictício por um QR Code PIX gerado pelo Mercado Pago.

## Incluído
- PIX real pelo Mercado Pago
- QR Code real + Copia e Cola
- preço calculado no servidor
- consulta automática do status
- webhook do Mercado Pago
- Access Token somente no backend

## Configuração
1. Use Node.js 18+.
2. Copie `.env.example` para `.env`.
3. Informe `MP_ACCESS_TOKEN`.
4. Informe `PUBLIC_BASE_URL` com o endereço HTTPS público.
5. Execute `npm install` e `npm start`.

## Importante
Nunca coloque o Access Token no HTML ou JavaScript do navegador.
O armazenamento em `orders.json` é adequado para teste inicial; para produção, use banco de dados e implemente a emissão/entrega dos ingressos após a aprovação.

Os campos de cartão/débito do HTML original eram apenas demonstrativos. A integração feita aqui é PIX real.
