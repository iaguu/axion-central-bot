import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { Database } from "./database.js";
import { requireEnv, fetchWithRetry, escapeHtml } from "./utils.js";

const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const DEFAULT_FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 3);

// ETIMEOUT observability (local per store bot)
const ETIMEOUT_LOCAL = { count: 0, windowStart: Date.now(), alerted: false };
const ETIMEOUT_WINDOW_MS = 60 * 60 * 1000; // 1h
const ETIMEOUT_THRESHOLD = 5;

const onFetchTimeout = async (url) => {
    const now = Date.now();
    if (now - ETIMEOUT_LOCAL.windowStart > ETIMEOUT_WINDOW_MS) {
        ETIMEOUT_LOCAL.count = 0; ETIMEOUT_LOCAL.windowStart = now; ETIMEOUT_LOCAL.alerted = false;
    }
    ETIMEOUT_LOCAL.count += 1;
    if (!ETIMEOUT_LOCAL.alerted && ETIMEOUT_LOCAL.count >= ETIMEOUT_THRESHOLD && ADMIN_ID) {
        ETIMEOUT_LOCAL.alerted = true;
        try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ Muitos timeouts nas requisições externas (store): ${ETIMEOUT_LOCAL.count} em 1h.`); } catch (_) {}
    }
};

const bot = new Telegraf(process.env.TOKEN_STORE);
const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER || 'fluxopay').toLowerCase(); // 'fluxopay' or 'axionpay'
const AXION_PAY_URL = process.env.AXION_PAY_URL || 'http://localhost:3060';
const AXION_PAY_KEY = process.env.AXION_PAY_KEY || process.env.FLUXO_TOKEN || process.env.API_KEY || '';
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const APP_VERSION = process.env.npm_package_version || "dev";

requireEnv(["TOKEN_STORE", "CALLBACK_URL"]);
if (!AXION_PAY_KEY) console.warn("⚠️ Payment API Key missing (AXION_PAY_KEY/FLUXO_TOKEN). Payments may fail.");
console.log(`payment provider: ${PAYMENT_PROVIDER} (axion: ${AXION_PAY_URL})`);

const COUPONS = {
    AXION10: { type: 'percent', value: 10, label: '10% OFF' },
    AXION20: { type: 'percent', value: 20, label: '20% OFF' },
    VIP5: { type: 'amount', value: 5, label: 'R$ 5 OFF' }
};

const sendMyOrders = (ctx, userId) => {
    const orders = Database.getOrdersByUser(userId)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .slice(0, 5);

    if (!orders.length) return ctx.replyWithHTML('\u{1F4E6} Nenhum pedido encontrado.');

    const lines = orders.map(o => `- <b>${o.id}</b> - ${o.status} - R$ ${o.amount}`);
    ctx.replyWithHTML(`\u{1F4E6} <b>SEUS \u00daLTIMOS PEDIDOS</b>\n\n${lines.join('\n')}`);
};

const sendStoreStatus = (ctx) => {
    const products = Database.getProducts();
    const orders = Database.getOrders();
    const pending = orders.filter(o => !['delivered', 'refunded'].includes(o.status)).length;

    const lines = products.map(p => `- ${p.name} (${p.category}) - estoque: ${p.stock?.length || 0}`);
    ctx.replyWithHTML(
        `\u{1F3EA} <b>STATUS DA LOJA</b>\n\n` +
        `Pedidos pendentes: <b>${pending}</b>\n\n` +
        (lines.length ? lines.join('\n') : 'Sem produtos cadastrados.')
    );
};

const sendSupport = async (ctx, note) => {
    const user = ctx.from;
    const text = note || 'Solicitou suporte pelo bot.';
    Database.addLog(`Suporte: ${user.id} - ${text}`);
    if (ADMIN_ID) {
        await bot.telegram.sendMessage(ADMIN_ID, `\u{1F198} Suporte: ${user.id} (${user.first_name})\n${text}`);
    }
    ctx.replyWithHTML('\u{1F198} Seu pedido de suporte foi enviado.');
};


// --- INTERFACE DA LOJA ---

const sendMainMenu = (ctx) => {
    const buttons = [
        [Markup.button.callback("\u{1F4B3} Comprar Cart\u00f5es (CC)", "cat_cards")],
        [Markup.button.callback("\u{1F48E} Comprar VIP (R$ 29,90)", "buy_vip")],
        [Markup.button.callback("\u{1F4E6} Meus Pedidos", "my_orders")],
        [Markup.button.callback("\u{1F3F7} Cupom", "cupom")],
        [Markup.button.callback("\u{1F198} Suporte", "suporte")],
    ];
    if (ADMIN_ID && ctx.from.id === ADMIN_ID) {
        buttons.push([Markup.button.callback("\u{1F3EA} Status da Loja", "status_loja")]);
    }
    const text = `\u{1F3EA} <b>AXION STORE v1.0</b>\n\n` +
                 `Bem-vindo \u00e0 loja oficial do ecossistema Axion.\n` +
                 `Selecione uma op\u00e7\u00e3o abaixo:`;
    
    if (ctx.updateType === 'callback_query') {
        ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons)));
    } else {
        ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons));
    }
};

bot.start(sendMainMenu);
bot.action('main_menu', sendMainMenu);

// Botão Comprar VIP (R$ 29,90)
bot.action('buy_vip', async (ctx) => {
    await ctx.answerCbQuery();
    const vipProduct = { id: 'vip', name: 'VIP', price: 29.90, category: 'vip' };
    const text = 
        `\u{1F48E} <b>VIP ILIMITADO</b>\n\n` +
        `Acesso irrestrito ao bot de consultas por 30 dias.\n` +
        `Valor: <b>R$ 29,90/mês</b>\n\nClique abaixo para pagar:`;
    
    const kb = Markup.inlineKeyboard([
        [Markup.button.callback("\u{1F4B8} Comprar VIP", `buy_vip_${Date.now()}`)],
        [Markup.button.callback("🔙 Voltar", "main_menu")]
    ]);

    ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => ctx.replyWithHTML(text, kb));
});

// Função unificada de compra
const handlePurchase = async (ctx, product, orderIdPrefix = 'o') => {
    const orderId = `${orderIdPrefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    
    const coupon = Database.getUserCoupon(ctx.from.id);
    let discount = 0;
    if (coupon && product.id !== 'vip') { // VIP geralmente não tem cupom, ou ajustar conforme regra
        if (coupon.type === 'percent') discount = (product.price * coupon.value) / 100;
        if (coupon.type === 'amount') discount = coupon.value;
    }
    discount = Number(Math.max(discount, 0).toFixed(2));
    const finalAmount = Number(Math.max(product.price - discount, 1).toFixed(2));
    if (coupon) Database.clearUserCoupon(ctx.from.id);

    Database.addOrder({
        id: orderId,
        userId: ctx.from.id,
        productId: product.id,
        amount: finalAmount,
        amountOriginal: product.price,
        discount,
        couponCode: coupon?.code || null,
        status: 'created'
    });

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (AXION_PAY_KEY) headers['Authorization'] = `Bearer ${AXION_PAY_KEY}`;
        headers['Idempotency-Key'] = orderId;

        const response = await fetchWithRetry(`${AXION_PAY_URL.replace(/\/$/, '')}/payments/pix`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                amount: finalAmount,
                external_id: `order_${orderId}`,
                description: `Axion Store - ${product.name}`,
                callback_url: process.env.CALLBACK_URL
            })
        }, { retries: DEFAULT_FETCH_RETRIES, timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, onTimeout: onFetchTimeout });

        const j = await response.json();
        const tx = j.transaction || j;
        const pid = tx?.id || j.id || j.transaction?.providerReference || j.providerReference;
        const pixPayload = tx?.pix_payload || j.pix_payload || tx?.metadata?.pix?.copia_colar || j.metadata?.pix?.copia_colar || j.pix_code || tx?.pix_code;
        const payUrl = j.payment_url || tx?.payment_url || null;

        Database.updateOrder(orderId, {
            status: 'pending_payment',
            paymentId: pid,
            pix_code: pixPayload,
            payment_url: payUrl
        });

        const pix = pixPayload || '';
        const msg =
            `\u{1F4A0} <b>FATURA GERADA</b>\n\n` +
            `\u{1F4E6} <b>Produto:</b> ${product.name}\n` +
            `\u{1F4B5} <b>Valor:</b> R$ ${finalAmount}\n` +
            (discount > 0 ? `\u{1F3F7} <b>Desconto:</b> R$ ${discount}\n` : '') +
            `\u{1F4CC} <b>COPIAR AQUI:</b>\n<pre>${escapeHtml(pix) || 'N/A'}</pre>`;

        // Notify Admin on Sale Creation
        if (ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `💰 <b>Nova Venda Criada</b>\nUser: ${ctx.from.id}\nProd: ${product.name}\nVal: R$ ${finalAmount}`, {parse_mode:'HTML'}).catch(()=>{});

        await ctx.replyWithHTML(msg,
            Markup.inlineKeyboard([
                payUrl ? [Markup.button.url("\u{1F517} Pagar no App", payUrl)] : [],
                [Markup.button.callback("\u2705 Já paguei", `check_${pid || orderId}`)],
                [Markup.button.callback("🏠 Menu Principal", "main_menu")]
            ].filter(Boolean))
        );

    } catch (e) {
        Database.updateOrder(orderId, { status: 'payment_failed' });
        console.error('payment creation error:', e);
        try { Database.addLog(`payment creation error: ${e && e.message ? e.message : String(e)}`); } catch (_) {}
        
        if (ADMIN_ID) {
            let msg = `⚠️ <b>Erro no Pagamento</b>\nUser: ${ctx.from.id}\nErro: ${e.message}`;
            if (e.message.includes('ECONNREFUSED') && AXION_PAY_URL.includes('localhost')) msg += `\n\n💡 <i>Gateway offline em ${AXION_PAY_URL}?</i>`;
            bot.telegram.sendMessage(ADMIN_ID, msg, {parse_mode:'HTML'}).catch(()=>{});
        }
        ctx.reply("\u274C Erro ao gerar pagamento. Tente novamente mais tarde.");
    }
};

// Fluxo de compra do VIP
bot.action(/buy_vip_(.+)/, async (ctx) => {
    const product = { id: 'vip', name: 'VIP', price: 29.90, category: 'vip' };
    await handlePurchase(ctx, product, `vip_${ctx.from.id}`);
});

bot.command('meus_pedidos', (ctx) => {
    sendMyOrders(ctx, ctx.from.id);
});

bot.command('status_loja', (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Acesso negado.");
    sendStoreStatus(ctx);
});

bot.command('promocoes', (ctx) => {
    const list = Object.entries(COUPONS).map(([k, v]) => `- ${k} (${v.label})`).join("\n");
    ctx.replyWithHTML(`\u{1F3F7} <b>PROMO\u00C7\u00D5ES ATIVAS</b>\n\n${list || "Sem promo\u00E7\u00F5es."}`);
});

bot.command('produto', (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply("Use: /produto ID");
    const product = Database.getProductById(id);
    if (!product) return ctx.reply("\u274C Produto n\u00E3o encontrado.");
    const stock = product.stock?.length || 0;
    ctx.replyWithHTML(
        `\u{1F4E6} <b>PRODUTO</b>\n\n` +
        `Nome: <b>${product.name}</b>\n` +
        `Pre\u00E7o: <b>R$ ${product.price}</b>\n` +
        `Categoria: <b>${product.category}</b>\n` +
        `Estoque: <b>${stock}</b>`
    );
});

bot.command('comprar', (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply("Use: /comprar ID");
    const product = Database.getProductById(id);
    if (!product) return ctx.reply("\u274C Produto n\u00E3o encontrado.");
    ctx.replyWithHTML(
        `\u{1F4B3} <b>COMPRAR</b>\n\n` +
        `Produto: <b>${product.name}</b>\n` +
        `Pre\u00E7o: <b>R$ ${product.price}</b>\n\n` +
        `Clique abaixo para pagar:`,
        Markup.inlineKeyboard([[Markup.button.callback("\u{1F4B8} Comprar agora", `buy_${product.id}`)]])
    );
});

bot.command('version', (ctx) => {
    ctx.replyWithHTML(`\u{1F4E6} <b>VERS\u00C3O</b>\n\n${APP_VERSION}`);
});


bot.command('pedido', (ctx) => {
    const orderId = ctx.message.text.split(' ')[1];
    if (!orderId) return ctx.reply('Use: /pedido ID_PEDIDO');
    const order = Database.getOrder(orderId);
    if (!order) return ctx.reply('\u274C Pedido n\u00e3o encontrado.');
    if (order.userId != ctx.from.id && (!ADMIN_ID || ctx.from.id !== ADMIN_ID)) return ctx.reply('\u274C Acesso negado.');
    const product = Database.getProductById(order.productId);
    const lines = [
        `\u{1F9FE} <b>Pedido:</b> ${order.id}`,
        `\u{1F4E6} <b>Produto:</b> ${product?.name || 'N/A'}`,
        `\u{1F4B0} <b>Valor:</b> R$ ${order.amount}`,
        `\u{1F4CC} <b>Status:</b> ${order.status}`
    ];
    if (order.discount) lines.push(`\u{1F3F7} <b>Desconto:</b> R$ ${order.discount}`);
    if (order.couponCode) lines.push(`\u{1F3F7} <b>Cupom:</b> ${order.couponCode}`);
    ctx.replyWithHTML(lines.join('\n'));
});

bot.command('suporte', async (ctx) => {
    const note = ctx.message.text.split(' ').slice(1).join(' ');
    await sendSupport(ctx, note);
});

bot.command('cupom', (ctx) => {
    const code = (ctx.message.text.split(' ')[1] || '').toUpperCase();
    if (!code) {
        const list = Object.entries(COUPONS).map(([k, v]) => `🏷️ ${k} (${v.label})`).join('\n');
        return ctx.replyWithHTML(`\u{1F3F7} <b>CUPONS DISPONÍVEIS</b>\n\n${list}\n\nUse: /cupom CODIGO`);
    }
    const coupon = COUPONS[code];
    if (!coupon) return ctx.reply('\u274C Cupom inválido.');
    Database.setUserCoupon(ctx.from.id, { code, ...coupon });
    ctx.replyWithHTML(`\u{1F3F7} Cupom <b>${code}</b> aplicado: ${coupon.label}`);
});

bot.action('cupom', async (ctx) => {
    await ctx.answerCbQuery();
    const list = Object.entries(COUPONS).map(([k, v]) => `🏷️ ${k} (${v.label})`).join('\n');
    ctx.replyWithHTML(`\u{1F3F7} <b>CUPONS DISPONÍVEIS</b>\n\n${list}\n\nUse: /cupom CODIGO`);
});

bot.command(['help', 'ajuda'], (ctx) => {
    ctx.replyWithHTML(`ℹ️ <b>AJUDA DA LOJA</b>\n\nUse /start para abrir o menu principal.`);
});

// --- NOVOS COMANDOS ÚTEIS (10) ---

// 1. Carteira/Saldo
bot.command(['carteira', 'saldo'], (ctx) => {
    const user = Database.getUser(ctx.from.id);
    ctx.replyWithHTML(`💰 <b>SUA CARTEIRA</b>\n\nSaldo REP: <b>${user.rep || 0}</b>\nStatus VIP: <b>${user.isVip ? 'ATIVO' : 'INATIVO'}</b>`);
});

// 2. Transferir REP
bot.command('transferir', (ctx) => {
    const parts = ctx.message.text.split(' ');
    const targetId = Number(parts[1]);
    const amount = Number(parts[2]);
    if (!targetId || !amount || amount <= 0) return ctx.reply('Use: /transferir ID QUANTIDADE');
    if (targetId === ctx.from.id || isNaN(targetId)) return ctx.reply('❌ ID inválido ou transferência para si mesmo.');
    
    const sender = Database.getUser(ctx.from.id);
    if ((sender.rep || 0) < amount) return ctx.reply('❌ Saldo insuficiente.');
    
    Database.addRep(ctx.from.id, -amount);
    Database.addRep(targetId, amount);
    Database.addLog(`Transfer: ${amount} REP from ${ctx.from.id} to ${targetId}`);
    
    ctx.reply(`✅ Transferido ${amount} REP para ${targetId}.`);
    bot.telegram.sendMessage(targetId, `💰 Você recebeu ${amount} REP de ${ctx.from.first_name}.`).catch(()=>{});
});

// 3. Termos de Serviço
bot.command('termos', (ctx) => {
    ctx.replyWithHTML(`📜 <b>TERMOS DE SERVIÇO</b>\n\n1. Todas as vendas são finais.\n2. O uso indevido dos dados é responsabilidade do usuário.\n3. Reembolsos apenas em caso de falha técnica comprovada.`);
});

// 4. FAQ
bot.command('faq', (ctx) => {
    ctx.replyWithHTML(`❓ <b>PERGUNTAS FREQUENTES</b>\n\n<b>Q: O VIP é automático?</b>\nR: Sim, ativa logo após o pagamento.\n\n<b>Q: Aceitam quais pagamentos?</b>\nR: Apenas PIX no momento.`);
});

// 5. Avaliar Pedido
bot.command('avaliar', (ctx) => {
    const parts = ctx.message.text.split(' ');
    const orderId = parts[1];
    const stars = Number(parts[2]);
    if (!orderId || !stars || stars < 1 || stars > 5) return ctx.reply('Use: /avaliar ID_PEDIDO [1-5]');
    Database.addLog(`Review: Order ${orderId} - ${stars} estrelas - User ${ctx.from.id}`);
    ctx.reply('⭐ Obrigado pela sua avaliação!');
});

// 6. Top Compradores (Ranking de gastos fictício baseado em pedidos)
bot.command('top_compradores', (ctx) => {
    const orders = Database.getOrders();
    const spending = {};
    orders.forEach(o => {
        if (o.status === 'paid' || o.status === 'delivered') {
            spending[o.userId] = (spending[o.userId] || 0) + o.amount;
        }
    });
    const sorted = Object.entries(spending).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const lines = sorted.map((s, i) => `${i+1}. ${s[0]} - R$ ${s[1].toFixed(2)}`);
    ctx.replyWithHTML(`🏆 <b>TOP COMPRADORES</b>\n\n${lines.join('\n') || 'Sem dados.'}`);
});

// 7. Sistema de Afiliado (Simulado)
bot.command('afiliado', (ctx) => {
    ctx.replyWithHTML(`🤝 <b>SEU LINK DE AFILIADO</b>\n\n<code>https://t.me/${ctx.botInfo.username}?start=ref_${ctx.from.id}</code>\n\nGanhe 5% de comissão em REP a cada venda.`);
});

// 8. Solicitar Reembolso
bot.command('reembolsar', async (ctx) => {
    const orderId = ctx.message.text.split(' ')[1];
    if (!orderId) return ctx.reply('Use: /reembolsar ID_PEDIDO');
    const order = Database.getOrder(orderId);
    if (!order || order.userId !== ctx.from.id) return ctx.reply('❌ Pedido inválido.');
    
    await sendSupport(ctx, `Solicitação de reembolso para pedido ${orderId}`);
    ctx.reply('📩 Solicitação enviada para a administração.');
});

// 9. Calcular Frete (Simulado)
bot.command('frete', (ctx) => {
    const cep = ctx.message.text.split(' ')[1];
    if (!cep) return ctx.reply('Use: /frete CEP');
    // Simulação
    const valor = (Math.random() * 30 + 15).toFixed(2);
    const dias = Math.floor(Math.random() * 10) + 2;
    ctx.replyWithHTML(`🚚 <b>FRETE ESTIMADO</b>\n\nCEP: ${cep}\nValor: R$ ${valor}\nPrazo: ${dias} dias úteis`);
});

// 10. Gift Card (Simulado)
bot.command('gift', (ctx) => {
    const valor = Number(ctx.message.text.split(' ')[1]);
    if (!valor || isNaN(valor) || valor <= 0) return ctx.reply('Use: /gift VALOR (ex: /gift 50)');
    const code = `GIFT-${Date.now().toString(36).toUpperCase()}`;
    // Em um sistema real, salvaria no banco. Aqui apenas simula a geração.
    ctx.replyWithHTML(`🎁 <b>GIFT CARD GERADO</b>\n\nValor: R$ ${valor}\nCódigo: <code>${code}</code>\n\n(Envie este código para um amigo)`);
});

// 11. Extrato
bot.command('extrato', (ctx) => {
    const orders = Database.getOrdersByUser(ctx.from.id).filter(o => o.status === 'paid' || o.status === 'delivered');
    if (!orders.length) return ctx.reply('Sem movimentações.');
    const lines = orders.slice(0, 10).map(o => `🔻 R$ ${o.amount} - ${o.productId}`).join('\n');
    ctx.replyWithHTML(`📜 <b>EXTRATO RECENTE</b>\n\n${lines}`);
});

// 12. Cancelar Pedido
bot.command('cancelar', (ctx) => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Use: /cancelar ID_PEDIDO');
    const order = Database.getOrder(id);
    if (!order || order.userId !== ctx.from.id) return ctx.reply('❌ Pedido não encontrado.');
    if (order.status !== 'created' && order.status !== 'pending_payment') return ctx.reply('❌ Não é possível cancelar este pedido.');
    
    Database.updateOrder(id, { status: 'cancelled' });
    ctx.reply(`✅ Pedido ${id} cancelado.`);
});

// 13. Add Produto (Admin)
bot.command('add_produto', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const parts = ctx.message.text.split(' '); // /add_produto id nome preco cat
    if (parts.length < 5) return ctx.reply('Use: /add_produto ID NOME PRECO CATEGORIA');
    const [_, id, name, price, cat] = parts;
    Database.addProduct({ id, name: name.replace(/_/g, ' '), price: Number(price), category: cat });
    ctx.reply(`✅ Produto ${name} adicionado.`);
});

// 14. Set Price (Admin)
bot.command('set_price', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const [_, id, price] = ctx.message.text.split(' ');
    if (!id || !price) return ctx.reply('Use: /set_price ID NOVO_PRECO');
    const ok = Database.updateProduct(id, { price: Number(price) });
    ctx.reply(ok ? `✅ Preço atualizado.` : `❌ Produto não encontrado.`);
});

// 15. Lucro (Admin)
bot.command('lucro', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const orders = Database.getOrders();
    const total = orders.filter(o => o.status === 'paid' || o.status === 'delivered').reduce((acc, o) => acc + o.amount, 0);
    ctx.replyWithHTML(`💰 <b>LUCRO TOTAL:</b> R$ ${total.toFixed(2)}`);
});

// 16. Best Sellers
bot.command('best_sellers', (ctx) => {
    const orders = Database.getOrders().filter(o => o.status === 'paid' || o.status === 'delivered');
    const counts = {};
    orders.forEach(o => counts[o.productId] = (counts[o.productId] || 0) + 1);
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const lines = sorted.map(([id, qtd], i) => `${i+1}. ${id} - ${qtd} vendas`).join('\n');
    ctx.replyWithHTML(`🏆 <b>MAIS VENDIDOS</b>\n\n${lines}`);
});

// 17. Stock Alert (Admin)
bot.command('stock_alert', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const low = Database.getProducts().filter(p => (p.stock?.length || 0) < 5);
    if (!low.length) return ctx.reply('✅ Estoque saudável.');
    const lines = low.map(p => `⚠️ ${p.name}: ${p.stock.length}`).join('\n');
    ctx.replyWithHTML(`📉 <b>ESTOQUE BAIXO</b>\n\n${lines}`);
});

// 18. Del Produto (Admin)
bot.command('del_produto', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const id = ctx.message.text.split(' ')[1];
    if (Database.deleteProduct(id)) ctx.reply(`🗑️ Produto ${id} removido.`);
    else ctx.reply('❌ Erro ao remover.');
});

// Check Low Stock Helper
const checkLowStock = (productId) => {
    const p = Database.getProductById(productId);
    if (p && (p.stock?.length || 0) < 5 && ADMIN_ID) {
        bot.telegram.sendMessage(ADMIN_ID, `⚠️ <b>ALERTA DE ESTOQUE</b>\nProduto: ${p.name}\nRestam: ${p.stock.length}`, {parse_mode:'HTML'}).catch(()=>{});
    }
};

bot.action('suporte', async (ctx) => {
    await ctx.answerCbQuery();
    await sendSupport(ctx, null);
});



bot.action("my_orders", async (ctx) => {
    await ctx.answerCbQuery();
    sendMyOrders(ctx, ctx.from.id);
});

bot.action("status_loja", async (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("❌ Acesso negado.", { show_alert: true });
    await ctx.answerCbQuery();
    sendStoreStatus(ctx);
});

// --- LISTAGEM DE PRODUTOS ---
bot.action("cat_cards", async (ctx) => {
    // IDs fixos definidos no database.js
    const levels = [
        { id: 'cc_gold', label: '💳 Gold', price: 25 },
        { id: 'cc_platinum', label: '💳 Platinum', price: 45 },
        { id: 'cc_infinity', label: '💳 Infinity', price: 75 }
    ];

    const buttons = levels.map(l => [
        Markup.button.callback(`${l.label} - R$ ${l.price}`, `buy_${l.id}`)
    ]);
    buttons.push([Markup.button.callback("🔙 Voltar", "main_menu")]);
    ctx.editMessageText("🛒 <b>ESCOLHA O NÍVEL DO MATERIAL:</b>", { 
        parse_mode: 'HTML', 
        ...Markup.inlineKeyboard(buttons) 
    });
});

// --- PROCESSO DE COMPRA (INTEGRAÇÃO FLUXOPAY) ---
bot.action(/buy_(.+)/, async (ctx) => {
    const productId = ctx.match[1];
    const products = Database.getProducts();
    const product = products.find(p => p.id == productId);

    if (!product) { try { await ctx.answerCbQuery("Produto não encontrado."); } catch (_) {} return; }

    try { await ctx.answerCbQuery("Gerando PIX de pagamento..."); } catch (_) {}
    await handlePurchase(ctx, product);
});

bot.action(/check_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const paymentId = ctx.match[1];
    try {
        const orders = Database.getOrders();
        // Busca pelo paymentId (provedor) OU pelo ID do pedido (interno)
        const order = orders.find(o => o.paymentId == paymentId || o.id == paymentId);
        if (!order) { try { await ctx.answerCbQuery("❌ Pedido não encontrado.", { show_alert: true }); } catch (_) {} return; }
        if (['paid', 'delivered'].includes(order.status)) { try { await ctx.answerCbQuery("✅ Pagamento já confirmado.", { show_alert: true }); } catch (_) {} return; }

        // Usa o ID do provedor se disponível, senão tenta com o ID que veio no botão
        const pidToCheck = order.paymentId || paymentId;

        // Consultar usando a mesma base do Axion Pay (que deve fazer proxy ou ser o gateway)
        const res = await fetchWithRetry(`${AXION_PAY_URL.replace(/\/$/, '')}/payments/${pidToCheck}`, {
            headers: { 'Authorization': `Bearer ${AXION_PAY_KEY}`, 'Content-Type': 'application/json' }
        }, { retries: DEFAULT_FETCH_RETRIES, timeoutMs: DEFAULT_FETCH_TIMEOUT_MS, onTimeout: onFetchTimeout });
        const data = await res.json();
        const status = data.status || data.state || data.payment_status;

        if (status === 'paid' || status === 'approved' || status === 'completed') {
            Database.updateOrder(order.id, { status: 'paid' });
            Database.addLog(`Pagamento confirmado (check): ${order.id}`);

            // Recompensa e entrega (mesma lógica do webhook)
            Database.addRep(order.userId, 50);
            const product = Database.getProductById(order.productId);
            if (product?.category === 'vip') {
                Database.setVip(order.userId, true);
                try { await bot.telegram.sendMessage(order.userId, "VIP ativado para a sua conta."); } catch (_) {}
            }
            const item = Database.popStock(order.productId);
            if (item) {
                try { await bot.telegram.sendMessage(order.userId, `Produto: ${item}`); } catch (_) {}
                Database.updateOrder(order.id, { status: 'delivered', deliveredAt: new Date().toISOString() });
                checkLowStock(order.productId);
            } else {
                try { await bot.telegram.sendMessage(order.userId, "Seu produto está em preparação. Em breve enviaremos aqui."); } catch (_) {}
                Database.updateOrder(order.id, { status: 'paid_pending_stock' });
            }

            try { await ctx.answerCbQuery("✅ Pagamento confirmado manualmente. Verifique suas mensagens.", { show_alert: true }); } catch (_) {} return;
        }

        try { await ctx.answerCbQuery("Pagamento ainda não confirmado. Aguarde o webhook.", { show_alert: true }); } catch (_) {} return;
    } catch (e) {
        console.error('check payment error:', e);
        try { Database.addLog(`check payment error: ${e && e.message ? e.message : String(e)}`); } catch (_) {}
        try { await ctx.answerCbQuery("Erro ao verificar pagamento. Tente novamente mais tarde.", { show_alert: true }); } catch (_) {} return;
    }
});
// --- AXION CASSINO COMPLEXO ---

const games = {
    dice: { emoji: '🎲', min: 1, win: (v) => v >= 4, mult: 2 },
    slots: { emoji: '🎰', win: (v) => [1, 22, 43, 64].includes(v), mult: 10 }, // 777 ou combinações raras
    football: { emoji: '⚽', win: (v) => v >= 3, mult: 3 }
};

bot.command('cassino', async (ctx) => {
    const user = Database.getUser(ctx.from.id);
    const repAtual = user.rep || 0;

    if (repAtual < 5) return ctx.replyWithHTML("❌ <b>SALDO INSUFICIENTE:</b> Você precisa de pelo menos 5 REP para entrar no Cassino.");

    ctx.replyWithHTML(
        `🎰 <b>AXION CASINO v5.0</b>\n\n` +
        `Sua REP atual: <b>${repAtual}</b>\n` +
        `Escolha sua modalidade de aposta:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("🎲 Dados (x2)", "play_dice"), Markup.button.callback("⚽ Penalty (x3)", "play_football")],
            [Markup.button.callback("🎰 Slots Premium (x10)", "play_slots")],
            [Markup.button.callback("❌ Sair", "close_casino")]
        ])
    );
});

bot.action(/play_(.+)/, async (ctx) => {
    const gameType = ctx.match[1];
    const user = Database.getUser(ctx.from.id);
    const apostaBase = 5;

    if (user.rep < apostaBase) return ctx.answerCbQuery("REP insuficiente!", { show_alert: true });

    // Deduz a aposta antes do jogo (Prevenção de bugs)
    Database.addRep(ctx.from.id, -apostaBase);
    
    const game = games[gameType];
    await ctx.editMessageText(`🕹 <b>SISTEMA:</b> Iniciando ${game.emoji}...\nAposta: <b>${apostaBase} REP</b>`, { parse_mode: 'HTML' });

    const result = await ctx.replyWithDice({ emoji: game.emoji });
    const valor = result.dice.value;

    // Logica de Vitória
    setTimeout(async () => {
        let ganhou = false;
        let premio = 0;

        if (gameType === 'slots') {
            // No Telegram Slots: 1=Bar, 22=Uva, 43=Limão, 64=777 (Valores aproximados do win)
            if ([1, 22, 43, 64].includes(valor)) {
                ganhou = true;
                premio = apostaBase * game.mult;
            }
        } else if (valor >= (gameType === 'dice' ? 4 : 3)) {
            ganhou = true;
            premio = apostaBase * game.mult;
        }

        if (ganhou) {
            Database.addRep(ctx.from.id, premio);
            const total = Database.getUser(ctx.from.id).rep;
            await ctx.replyWithHTML(
                `🔥 <b>JACKPOT!</b>\n\n` +
                `Você venceu no ${game.emoji}!\n` +
                `Prêmio: <b>+${premio} REP</b>\n` +
                `Saldo Total: <b>${total} REP</b>`
            );
        } else {
            const total = Database.getUser(ctx.from.id).rep;
            await ctx.replyWithHTML(
                `💀 <b>CASA VENCEU!</b>\n\n` +
                `Resultado: ${valor}\n` +
                `Você perdeu <b>${apostaBase} REP</b>.\n` +
                `Saldo Atual: <b>${total} REP</b>`
            );
        }
        
        // Audit Log
        Database.addLog(`Cassino ${gameType}: ${ganhou ? 'WIN' : 'LOSS'} - User ${ctx.from.id}`);
        
    }, 4000);
});

bot.action('close_casino', (ctx) => ctx.deleteMessage());

if (process.env.NODE_ENV !== 'test') {
    bot.launch().then(() => console.log("🏪 AXION STORE ONLINE"));
}

export { bot };
