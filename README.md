# Baile da Madrid 2.0 — versão final para Render

Esta versão mantém o `index.html` do site e adiciona emissão de ingressos, QR Code individual, envio por e-mail, validação na portaria e armazenamento persistente em PostgreSQL.

## O fluxo

1. O cliente escolhe os ingressos e informa nome, CPF, e-mail e telefone.
2. `/api/create-pix` cria o PIX no Mercado Pago.
3. O Mercado Pago notifica `/api/mercadopago/webhook` quando o pagamento muda de estado.
4. Quando aprovado, o servidor cria um QR Code único para cada ingresso.
5. Os ingressos são salvos no PostgreSQL e enviados ao e-mail do comprador.
6. A equipe usa `/validar.html` para escanear o QR Code.
7. O servidor marca o ingresso como utilizado de forma atômica; o mesmo QR não pode liberar duas entradas.

## Render

Crie/edite o Web Service existente.

Build Command:
`npm install`

Start Command:
`npm start`

Crie um PostgreSQL no Render e copie a connection string para `DATABASE_URL` do Web Service.

No Environment do Web Service configure:

- `MP_ACCESS_TOKEN`
- `PUBLIC_BASE_URL=https://baile-da-madrid-2.onrender.com`
- `DATABASE_URL`
- `ADMIN_TOKEN`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_FROM`

Não coloque segredos no GitHub nem no HTML.

## Mercado Pago

O pagamento usa PIX pela API do Mercado Pago. A criação do pagamento inclui `notification_url` apontando para:
`https://baile-da-madrid-2.onrender.com/api/mercadopago/webhook`

O webhook confirma o pagamento consultando o próprio Mercado Pago antes de emitir ingressos.

## E-mail

Configure um SMTP real. O servidor envia um e-mail com cada QR Code embutido e também como imagem anexa.

## Portaria

Abra:
`https://baile-da-madrid-2.onrender.com/validar.html`

Digite o `ADMIN_TOKEN` e use a câmera do celular. O QR Code pode conter a URL completa do ingresso; a página extrai o token automaticamente.

## Saúde

`/health` verifica se o processo está online e se o PostgreSQL está acessível.

## Importante

Não use `orders.json` para produção. Esta versão usa PostgreSQL. O arquivo antigo pode ser mantido apenas como backup histórico, mas não participa mais do sistema.
