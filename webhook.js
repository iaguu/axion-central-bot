import express from 'express';
import bodyParser from 'body-parser';
import { Telegraf } from 'telegraf';
import { Database } from './database.js';
import 'dotenv/config';

const requireEnv = (keys) => {
    const missing = keys.filter(k => !process.env[k]);
    if (missing.length) {
        console.error(`Missing env: ${missing.join(", ")}`);
        process.exit(1);
    }
};

const app = express();
const bot = new Telegraf(process.env.TOKEN_STORE);
app.use(bodyParser.json());

const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID || 0);

requireEnv(["TOKEN_STORE"]);

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection (webhook):', reason);
    try { Database.addLog(`Webhook UncaughtPromise: ${reason && reason.message ? reason.message : JSON.stringify(reason)}`); } catch (_) {}
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception (webhook):', err);
    try { Database.addLog(`Webhook UncaughtException: ${err && err.message ? err.message : String(err)}`); } catch (_) {}
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/metrics', (_req, res) => {
    const orders = Database.getOrders();
    const pending = orders.filter(o => !['delivered', 'refunded'].includes(o.status)).length;
    const vipCount = Database.getVipUsers().length;
    const recentLogs = Database.getLogs(200);
    const timeoutCount = recentLogs.filter(l => l.a && l.a.toLowerCase().includes('fetch timeout')).length;
    res.json({
        orders: orders.length,
        pending,
        vipCount,
        recentLogCount: recentLogs.length,
        fetchTimeoutsLastBatch: timeoutCount
    });
});

// Rota que a FluxoPay vai chamar
app.post('/webhook/fluxopay', async (req, res) => {
    const { status, external_id, amount } = req.body || {};

    const expectedToken = process.env.FLUXO_WEBHOOK_TOKEN;
    if (expectedToken) {
        const token = req.headers['x-webhook-token'];
        if (token !== expectedToken) {
            return res.sendStatus(401);
        }
    }

    if (!status || !external_id) {
        return res.status(400).send("invalid payload");
    }


    // 1. Verificar se o pagamento foi aprovado
    if (status === 'approved' || status === 'paid') {
        // O external_id costuma ser o ID da ordem que criamos no bot
        console.log(`✅ Pagamento Confirmado: Ordem ${external_id}`);
        try {
            const orderId = external_id.replace('order_', '');
            const order = Database.getOrder(orderId);
            if (!order) {
                Database.addLog(`Webhook sem pedido: ${orderId}`);
                return res.sendStatus(200);
            }
            if (["paid", "paid_pending_stock", "delivered"].includes(order.status)) {
                return res.sendStatus(200);
            }
            Database.updateOrder(orderId, { status: "paid" });
            Database.addRep(order.userId, 50);
            try {
                await bot.telegram.sendMessage(order.userId, `🎉 <b>PAGAMENTO CONFIRMADO!</b>\nSeu pedido ${orderId} foi confirmado via FluxoPay.`, { parse_mode: 'HTML' });
            } catch (_) {}
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
            Database.addLog(`FluxoPay Webhook processed: ${orderId}`);
        } catch (error) {
            console.error("Erro ao processar entrega:", error);
            try { Database.addLog(`Webhook error: ${error && error.message ? error.message : String(error)}`); } catch (_) {}
            if (ADMIN_ID) try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ Erro no webhook ao processar pagamento: ${error && error.message ? error.message : String(error)}`); } catch (_) {}
        }
    }

    // Responder 200 para a FluxoPay não tentar reenviar o aviso
    res.sendStatus(200);
});

// Rota que o axion-pay (PIX) pode chamar
app.post('/webhooks/pix', async (req, res) => {
    const { status, external_id, amount } = req.body || {};

    const expectedToken = process.env.PIX_WEBHOOK_SECRET;
    if (expectedToken) {
        const token = req.headers['x-webhook-token'];
        if (token !== expectedToken) {
            return res.sendStatus(401);
        }
    }

    if (!status || !external_id) {
        return res.status(400).send("invalid payload");
    }

    if (status === 'paid' || status === 'approved') {
        console.log(`✅ PIX Webhook: Ordem ${external_id} status ${status}`);
        try {
            const orderId = external_id.replace('order_', '');
            const order = Database.getOrder(orderId);
            if (!order) {
                Database.addLog(`PIX webhook sem pedido: ${orderId}`);
                return res.sendStatus(200);
            }
            if (['paid', 'paid_pending_stock', 'delivered'].includes(order.status)) {
                return res.sendStatus(200);
            }
            Database.updateOrder(orderId, { status: 'paid' });
            Database.addRep(order.userId, 50);
            try { await bot.telegram.sendMessage(order.userId, `🎉 <b>PAGAMENTO CONFIRMADO!</b>\nSeu pedido ${orderId} foi confirmado via PIX.`); } catch (_) {}
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
            Database.addLog(`PIX Webhook processed: ${orderId}`);
        } catch (error) {
            console.error('Erro ao processar PIX webhook:', error);
            try { Database.addLog(`PIX webhook error: ${error && error.message ? error.message : String(error)}`); } catch (_) {}
        }
    }

    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => console.log(`🛰️ Webhook Axion ativo na porta ${PORT}`));
}

export { app, bot };



