const express=require("express");
const path=require("path");
const fs=require("fs");
const crypto=require("crypto");

const app=express();
app.use(express.json({limit:"100kb"}));
app.use(express.static(path.join(__dirname)));

const PORT=process.env.PORT||3000;
const ACCESS_TOKEN=process.env.MP_ACCESS_TOKEN;
const PUBLIC_BASE_URL=process.env.PUBLIC_BASE_URL||"";
const ORDERS_FILE=path.join(__dirname,"orders.json");

const batches={
  pre:{name:"Pré-Venda",price:10},
  lote1:{name:"1º Lote",price:20},
  lote2:{name:"2º Lote",price:25},
  lote3:{name:"3º Lote",price:30},
  vip:{name:"Área VIP",price:70}
};

function loadOrders(){
  try{return JSON.parse(fs.readFileSync(ORDERS_FILE,"utf8"));}catch{return {};}
}
function saveOrders(orders){
  fs.writeFileSync(ORDERS_FILE,JSON.stringify(orders,null,2));
}
function cleanCPF(v){return String(v||"").replace(/\D/g,"");}
function splitName(name){
  const p=String(name||"").trim().split(/\s+/).filter(Boolean);
  return {first_name:p.shift()||"Cliente",last_name:p.join(" ")||"Baile Madrid"};
}
function calculateItems(items){
  if(!Array.isArray(items)||!items.length)throw new Error("Nenhum ingresso selecionado.");
  let total=0; const normalized=[];
  for(const item of items){
    const batch=batches[item.id], quantity=Number(item.quantity);
    if(!batch||!Number.isInteger(quantity)||quantity<1||quantity>10)
      throw new Error("Ingresso ou quantidade inválida.");
    total+=batch.price*quantity;
    normalized.push({id:item.id,name:batch.name,quantity,unit_price:batch.price});
  }
  if(normalized.reduce((s,i)=>s+i.quantity,0)>10)
    throw new Error("Limite máximo de 10 ingressos por compra.");
  return {normalized,total};
}
async function mpRequest(url,options={}){
  if(!ACCESS_TOKEN)throw new Error("MP_ACCESS_TOKEN não configurado no servidor.");
  const r=await fetch(url,{...options,headers:{
    Authorization:`Bearer ${ACCESS_TOKEN}`,"Content-Type":"application/json",
    ...(options.headers||{})
  }});
  const text=await r.text(); let data;
  try{data=JSON.parse(text);}catch{data={message:text};}
  if(!r.ok){console.error("Mercado Pago:",r.status,data);throw new Error(data.message||"Erro no Mercado Pago.");}
  return data;
}

app.post("/api/create-pix",async(req,res)=>{
  try{
    const {buyer,items}=req.body||{};
    const name=String(buyer?.name||"").trim();
    const email=String(buyer?.email||"").trim();
    const cpf=cleanCPF(buyer?.cpf);
    if(!name||!email||cpf.length!==11)
      return res.status(400).json({error:"Informe nome, e-mail e CPF válidos."});

    const {normalized,total}=calculateItems(items);
    const orderId=crypto.randomUUID();
    const {first_name,last_name}=splitName(name);

    const body={
      transaction_amount:Number(total.toFixed(2)),
      description:`Baile Madrid 2.0 - ${normalized.map(i=>`${i.quantity}x ${i.name}`).join(", ")}`,
      payment_method_id:"pix",
      external_reference:orderId,
      payer:{email,first_name,last_name,identification:{type:"CPF",number:cpf}}
    };
    if(PUBLIC_BASE_URL)
      body.notification_url=`${PUBLIC_BASE_URL.replace(/\/$/,"")}/api/mercadopago/webhook`;

    const payment=await mpRequest("https://api.mercadopago.com/v1/payments",{
      method:"POST",
      headers:{"X-Idempotency-Key":crypto.randomUUID()},
      body:JSON.stringify(body)
    });

    const tx=payment.point_of_interaction?.transaction_data;
    if(!tx?.qr_code||!tx?.qr_code_base64)
      throw new Error("Mercado Pago não retornou o QR Code PIX.");

    const orders=loadOrders();
    orders[orderId]={
      orderId,paymentId:String(payment.id),status:payment.status||"pending",
      total,items:normalized,buyer:{name,email,cpf},
      createdAt:new Date().toISOString()
    };
    saveOrders(orders);

    res.json({
      orderId,paymentId:String(payment.id),status:payment.status,
      qrCode:tx.qr_code,qrCodeBase64:tx.qr_code_base64
    });
  }catch(e){res.status(400).json({error:e.message||"Não foi possível gerar o PIX."});}
});

app.get("/api/payment-status/:orderId",async(req,res)=>{
  try{
    const orders=loadOrders(),order=orders[req.params.orderId];
    if(!order)return res.status(404).json({error:"Compra não encontrada."});
    const payment=await mpRequest(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(order.paymentId)}`);
    order.status=payment.status||order.status;
    order.updatedAt=new Date().toISOString();
    saveOrders(orders);
    res.json({status:order.status,paymentId:order.paymentId});
  }catch(e){res.status(500).json({error:e.message||"Não foi possível consultar o pagamento."});}
});

app.post("/api/mercadopago/webhook",async(req,res)=>{
  res.sendStatus(200);
  try{
    const paymentId=req.body?.data?.id||req.query?.id||req.body?.id;
    if(!paymentId)return;
    const payment=await mpRequest(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`);
    const orders=loadOrders(),orderId=payment.external_reference;
    if(orderId&&orders[orderId]){
      orders[orderId].status=payment.status;
      orders[orderId].updatedAt=new Date().toISOString();
      saveOrders(orders);
    }
  }catch(e){console.error("Webhook Mercado Pago:",e);}
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,()=>console.log(`Baile Madrid em http://localhost:${PORT}`));
