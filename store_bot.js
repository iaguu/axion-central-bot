
import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { Database } from "./database.js";
import fetch from "node-fetch";

const requireEnv = (keys) => {
    const missing = keys.filter(k => !process.env[k]);
    if (missing.length) {
        console.error(`Missing env: ${missing.join(", ")}`);
        process.exit(1);
    }
};

const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const DEFAULT_FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 3);

// ETIMEOUT observability (local per store bot)
const ETIMEOUT_LOCAL = { count: 0, windowStart: Date.now(), alerted: false };
const ETIMEOUT_WINDOW_MS = 60 * 60 * 1000; // 1h
const ETIMEOUT_THRESHOLD = 5;
const checkAndAlertEtLocal = async (url) => {
    const now = Date.now();
    if (now - ETIMEOUT_LOCAL.windowStart > ETIMEOUT_WINDOW_MS) {
        ETIMEOUT_LOCAL.count = 0; ETIMEOUT_LOCAL.windowStart = now; ETIMEOUT_LOCAL.alerted = false;
    }
    ETIMEOUT_LOCAL.count += 1;
    try { Database.addLog(`fetch timeout: ${url}`); } catch (_) {}
    if (!ETIMEOUT_LOCAL.alerted && ETIMEOUT_LOCAL.count >= ETIMEOUT_THRESHOLD && ADMIN_ID) {
        ETIMEOUT_LOCAL.alerted = true;
        try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ Muitos timeouts nas requisições externas (store): ${ETIMEOUT_LOCAL.count} em 1h.`); } catch (_) {}
    }
};

const fetchWithRetry = async (url, options = {}, { retries = DEFAULT_FETCH_RETRIES, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch (e) {
            if (attempt === retries) {
                if (e.name === 'AbortError' || e.type === 'aborted' || e.message === 'The operation was aborted.') {
                    await checkAndAlertEtLocal(url);
                    throw new Error('ETIMEOUT');
                }
                throw e;
            }
            await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        } finally {
            clearTimeout(timeout);
        }
    }
};

const bot = new Telegraf(process.env.TOKEN_STORE);
const FLUXOPAY_API = process.env.FLUXOPAY_API || "https://api.fluxopay.com/v1"; // Exemplo de endpoint
const FLUXO_TOKEN = process.env.FLUXO_TOKEN;
const PAYMENT_PROVIDER = (process.env.PAYMENT_PROVIDER || 'fluxopay').toLowerCase(); // 'fluxopay' or 'axionpay'
const AXION_PAY_URL = process.env.AXION_PAY_URL || 'http://localhost:3060';
const AXION_PAY_KEY = process.env.AXION_PAY_KEY || process.env.FLUXO_TOKEN || process.env.API_KEY || '';
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID || 0);
const APP_VERSION = process.env.npm_package_version || "dev";

requireEnv(["TOKEN_STORE", "CALLBACK_URL"]);
console.log(`payment provider: ${PAYMENT_PROVIDER} (fluxopay endpoint: ${FLUXOPAY_API}, axion: ${AXION_PAY_URL})`);

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

const sendCatalog = (ctx, category, maxPrice) => {
    let products = Database.getProducts();
    if (category) products = products.filter(p => p.category === category);
    if (maxPrice) products = products.filter(p => Number(p.price) <= maxPrice);

    if (!products.length) return ctx.replyWithHTML('\u{1F4DA} Nenhum produto encontrado.');

    const lines = products.map(p => `- ${p.name} - R$ ${p.price} (${p.category})`);
    ctx.replyWithHTML(`\u{1F4DA} <b>CAT\u00c1LOGO</b>\n\n${lines.join('\n')}`);
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


const sendMainMenu = (ctx) => {
    const buttons = [
        [Markup.button.callback("\u{1F4B3} Comprar Cart\u00f5es (CC)", "cat_cards")],
        [Markup.button.callback("\u{1F48E} Upgrade VIP", "cat_vip")],
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


bot.command('catalogo', (ctx) => {
    const parts = ctx.message.text.split(' ').slice(1);
    const category = parts[0];
    const maxPrice = parts[1] ? Number(parts[1].replace(',', '.')) : null;
    sendCatalog(ctx, category, maxPrice && !isNaN(maxPrice) ? maxPrice : null);
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
        const list = Object.entries(COUPONS).map(([k, v]) => `? ${k} (${v.label})`).join('\n');
        return ctx.replyWithHTML(`\u{1F3F7} <b>CUPONS DISPON?VEIS</b>\n\n${list}\n\nUse: /cupom CODIGO`);
    }
    const coupon = COUPONS[code];
    if (!coupon) return ctx.reply('\u274C Cupom inv?lido.');
    Database.setUserCoupon(ctx.from.id, { code, ...coupon });
    ctx.replyWithHTML(`\u{1F3F7} Cupom <b>${code}</b> aplicado: ${coupon.label}`);
});

bot.action('catalogo', async (ctx) => {
    await ctx.answerCbQuery();
    sendCatalog(ctx, null, null);
});

bot.action('cupom', async (ctx) => {
    await ctx.answerCbQuery();
    const list = Object.entries(COUPONS).map(([k, v]) => `? ${k} (${v.label})`).join('\n');
    ctx.replyWithHTML(`\u{1F3F7} <b>CUPONS DISPON?VEIS</b>\n\n${list}\n\nUse: /cupom CODIGO`);
});

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
    await ctx.answerCbQuery();
    const products = Database.getProducts().filter(p => p.category === 'cards');
    if (products.length === 0) return ctx.answerCbQuery("Estoque vazio!", { show_alert: true });

    const buttons = products.map(p => [Markup.button.callback(`${p.name} - R$ ${p.price}`, `buy_${p.id}`)]);
    ctx.editMessageText("🛒 <b>CARTÕES DISPONÍVEIS:</b>", { 
        parse_mode: 'HTML', 
        ...Markup.inlineKeyboard(buttons) 
    });
});

bot.action("cat_vip", (ctx) => {
    ctx.answerCbQuery();
    const product = Database.getProductById('vip');
    ctx.editMessageText(
        `💎 <b>VIP ACCESS</b>\n\n` +
        `Tenha acesso ilimitado a todas as ferramentas de busca e prioridade no suporte.\n` +
        `Preço: <b>R$ ${product.price.toFixed(2)}</b>`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback("💳 Comprar Agora", "buy_vip")],
                [Markup.button.callback("🔙 Voltar", "main_menu")]
            ])
        }
    );
});

// --- PROCESSO DE COMPRA (INTEGRAÇÃO FLUXOPAY) ---
bot.action(/buy_(.+)/, async (ctx) => {
    const productId = ctx.match[1];
    const product = Database.getProductById(productId);

    if (!product) return ctx.answerCbQuery("Produto não encontrado.");

    await ctx.answerCbQuery("Gerando PIX de pagamento...");

    const orderId = `o_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const coupon = Database.getUserCoupon(ctx.from.id);
    let discount = 0;
    if (coupon) {
        if (coupon.type === 'percent') discount = (product.price * coupon.value) / 100;
        if (coupon.type === 'amount') discount = coupon.value;
    }
    discount = Number(Math.max(discount, 0).toFixed(2));
    const finalAmount = Number(Math.max(product.price - discount, 1).toFixed(2));
    if (coupon) Database.clearUserCoupon(ctx.from.id);

    Database.addOrder({
        id: orderId,
        userId: ctx.from.id,
        productId,
        amount: finalAmount,
        amountOriginal: product.price,
        discount,
        couponCode: coupon?.code || null,
        status: 'created'
    });

    try {
        let data = null;
        if (PAYMENT_PROVIDER === 'fluxopay') {
            const response = await fetchWithRetry(`${FLUXOPAY_API}/checkout`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${FLUXO_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    amount: finalAmount,
                    external_id: `order_${orderId}`,
                    description: `Axion Store - ${product.name}`,
                    callback_url: process.env.CALLBACK_URL
                })
            });
            data = await response.json();
            Database.updateOrder(orderId, {
                status: 'pending_payment',
                paymentId: data.id,
                pix_code: data.pix_code,
                payment_url: data.payment_url
            });

            ctx.replyWithHTML(
                `\u{1F4A0} <b>FATURA GERADA</b>\n\n` +
                `\u{1F4E6} <b>Produto:</b> ${product.name}\n` +
                `\u{1F4B5} <b>Valor:</b> R$ ${finalAmount}\n` +
                (discount > 0 ? `\u{1F3F7} <b>Desconto:</b> R$ ${discount}\n` : '') +
                `\u{1F4CC} <b>PIX COPIA E COLA:</b>\n<code>${data.pix_code}</code>`,
                Markup.inlineKeyboard([
                    [Markup.button.url("\u{1F517} Pagar no App", data.payment_url)],
                    [Markup.button.callback("\u2705 Já paguei", `check_${data.id}`)]
                ])
            );
        } else if (PAYMENT_PROVIDER === 'axionpay') {
            const headers = { 'Content-Type': 'application/json', 'pay-tag': 'user-test' };
            if (AXION_PAY_KEY) headers['Authorization'] = `Bearer ${AXION_PAY_KEY}`;
            headers['Idempotency-Key'] = orderId;

            // Payload conforme especificação do usuário
            const payload = {
                amount: finalAmount,
                customer: {
                    name: ctx.from.first_name || 'Cliente',
                    email: ctx.from.username ? `${ctx.from.username}@axion.fake` : 'cliente@axion.fake'
                },
                metadata: {
                    orderId: orderId
                }
            };

            const response = await fetchWithRetry('http://localhost:3060/payments/pix', {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const j = await response.json();
            const tx = j.transaction || j;
            const pid = tx?.id || j.id || tx?.providerReference || j.providerReference;
            // Extrai o código PIX do novo campo
            const pixCode = tx?.metadata?.pix?.copia_colar || 'N/A';
            const payUrl = null; // Não fornecido no payload de exemplo

            Database.updateOrder(orderId, {
                status: 'pending_payment',
                paymentId: pid,
                pix_code: pixCode,
                payment_url: payUrl
            });

            ctx.replyWithHTML(
                `\u{1F4A0} <b>FATURA GERADA</b>\n\n` +
                `\u{1F4E6} <b>Produto:</b> ${product.name}\n` +
                `\u{1F4B5} <b>Valor:</b> R$ ${finalAmount}\n` +
                (discount > 0 ? `\u{1F3F7} <b>Desconto:</b> R$ ${discount}\n` : '') +
                `\u{1F4CC} <b>PIX COPIA E COLA:</b>\n<code>${pixCode}</code>`,
                Markup.inlineKeyboard([
                    [Markup.button.callback("\u2705 Já paguei", `check_${pid || orderId}`)]
                ])
            );
        } else {
            throw new Error(`Unknown PAYMENT_PROVIDER: ${PAYMENT_PROVIDER}`);
        }

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
});

bot.action(/check_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const paymentId = ctx.match[1];
    try {
        const orders = Database.getOrders();
        const order = orders.find(o => o.paymentId == paymentId);
        if (!order) return ctx.answerCbQuery("❌ Pedido não encontrado.", { show_alert: true });
        if (['paid', 'delivered'].includes(order.status)) return ctx.answerCbQuery("✅ Pagamento já confirmado.", { show_alert: true });

        // Consultar FluxoPay diretamente
        const res = await fetchWithRetry(`${FLUXOPAY_API}/checkout/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${FLUXO_TOKEN}`, 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        const status = data.status || data.state || data.payment_status;

        if (status === 'paid' || status === 'approved' || status === 'completed') {
            Database.updateOrder(order.id, { status: 'paid' });
            Database.addLog(`Pagamento confirmado (check): ${order.id}`);

            // Recompensa e entrega (mesma lógica do webhook)
            Database.addRep(order.userId, 50);
            const product = Database.getProductById(order.productId);
            if (product?.category === 'vip') {
                Database.toggleVip(order.userId);
                try { await bot.telegram.sendMessage(order.userId, "VIP ativado para a sua conta."); } catch (_) {}
            }
            const item = Database.popStock(order.productId);
            if (item) {
                try { await bot.telegram.sendMessage(order.userId, `Produto: ${item}`); } catch (_) {}
                Database.updateOrder(order.id, { status: 'delivered', deliveredAt: new Date().toISOString() });
            } else {
                try { await bot.telegram.sendMessage(order.userId, "Seu produto está em preparação. Em breve enviaremos aqui."); } catch (_) {}
                Database.updateOrder(order.id, { status: 'paid_pending_stock' });
            }

            return ctx.answerCbQuery("✅ Pagamento confirmado manualmente. Verifique suas mensagens.", { show_alert: true });
        }

        return ctx.answerCbQuery("Pagamento ainda não confirmado. Aguarde o webhook.", { show_alert: true });
    } catch (e) {
        console.error('check payment error:', e);
        try { Database.addLog(`check payment error: ${e && e.message ? e.message : String(e)}`); } catch (_) {}
        return ctx.answerCbQuery("Erro ao verificar pagamento. Tente novamente mais tarde.", { show_alert: true });
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
// ========== COMANDOS ADMINISTRATIVOS DE GESTÃO DE LOJA ==========
// Confirmação manual de pagamento
bot.command('confirmar_pagamento', async (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const orderId = ctx.message.text.split(' ')[1];
    if (!orderId) return ctx.reply('Use: /confirmar_pagamento ID_PEDIDO');
    const order = Database.getOrder(orderId);
    if (!order) return ctx.reply('Pedido não encontrado.');
    if (["paid", "paid_pending_stock", "delivered"].includes(order.status)) return ctx.reply('Pedido já está pago ou entregue.');
    Database.updateOrder(orderId, { status: "paid" });
    Database.addRep(order.userId, 50);
    try { await bot.telegram.sendMessage(order.userId, `🎉 <b>PAGAMENTO CONFIRMADO MANUALMENTE!</b>\nSeu pedido ${orderId} foi confirmado pelo administrador.`, { parse_mode: 'HTML' }); } catch (_) {}
    const product = Database.getProductById(order.productId);
    if (product?.category === 'vip') {
        Database.toggleVip(order.userId);
        try { await bot.telegram.sendMessage(order.userId, "VIP ativado para a sua conta."); } catch (_) {}
    }
    const item = Database.popStock(order.productId);
    if (item) {
        try { await bot.telegram.sendMessage(order.userId, `Produto: ${item}`); } catch (_) {}
        Database.updateOrder(orderId, { status: 'delivered', deliveredAt: new Date().toISOString() });
    } else {
        try { await bot.telegram.sendMessage(order.userId, "Seu produto está em preparação. Em breve enviaremos aqui."); } catch (_) {}
        Database.updateOrder(orderId, { status: 'paid_pending_stock' });
    }
    Database.addLog(`Pagamento confirmado manualmente: ${orderId}`);
    ctx.reply('Pagamento confirmado e entrega processada.');
});

// Adicionar novo produto
bot.command('addproduto', (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 3) return ctx.reply('Use: /addproduto NOME PRECO CATEGORIA');
    const [name, price, ...catArr] = args;
    const category = catArr.join(' ');
    const prod = Database.addProduct({ name, price: Number(price.replace(',', '.')), category });
    ctx.replyWithHTML(`✅ Produto adicionado: <b>${prod.name}</b> (ID: ${prod.id})`);
});

// Adicionar estoque a um produto
bot.command('addestoque', (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('Use: /addestoque ID_PRODUTO ITEM1,ITEM2,...');
    const [id, ...itemsArr] = args;
    const items = itemsArr.join(' ').split(',').map(s => s.trim()).filter(Boolean);
    if (!items.length) return ctx.reply('Nenhum item informado.');
    const prod = Database.addStock(id, items);
    if (!prod) return ctx.reply('Produto não encontrado.');
    ctx.replyWithHTML(`✅ Estoque adicionado ao produto <b>${prod.name}</b>. Total em estoque: ${prod.stock.length}`);
});

// Listar pedidos recentes
bot.command('pedidos', (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const orders = Database.getOrders().slice(-10).reverse();
    if (!orders.length) return ctx.reply('Nenhum pedido encontrado.');
    const lines = orders.map(o => `ID: <b>${o.id}</b> | Usuário: <b>${o.userId}</b> | Produto: <b>${o.productId}</b> | Status: <b>${o.status}</b>`);
    ctx.replyWithHTML('📝 <b>ÚLTIMOS PEDIDOS</b>\n\n' + lines.join('\n'));
});

// Entregar manualmente um item de pedido
bot.command('entregar', (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const orderId = ctx.message.text.split(' ')[1];
    if (!orderId) return ctx.reply('Use: /entregar ID_PEDIDO');
    const order = Database.getOrder(orderId);
    if (!order) return ctx.reply('Pedido não encontrado.');
    if (order.status !== 'paid' && order.status !== 'paid_pending_stock') return ctx.reply('Pedido não está pago ou já foi entregue.');
    const item = Database.popStock(order.productId);
    if (item) {
        try { bot.telegram.sendMessage(order.userId, `Produto: ${item}`); } catch (_) {}
        Database.updateOrder(orderId, { status: 'delivered', deliveredAt: new Date().toISOString() });
        ctx.reply('Produto entregue ao usuário.');
    } else {
        ctx.reply('Sem estoque disponível para este produto.');
    }
});

// Cancelar pedido
bot.command('cancelar_pedido', (ctx) => {
    if (!ADMIN_ID || ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const orderId = ctx.message.text.split(' ')[1];
    if (!orderId) return ctx.reply('Use: /cancelar_pedido ID_PEDIDO');
    const order = Database.getOrder(orderId);
    if (!order) return ctx.reply('Pedido não encontrado.');
    Database.updateOrder(orderId, { status: 'cancelled' });
    ctx.reply('Pedido cancelado.');
});

bot.launch().then(() => console.log("🏪 AXION STORE ONLINE"));
