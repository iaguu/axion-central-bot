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

requireEnv(["TOKEN_STORE"]);

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/metrics', (_req, res) => {
    const orders = Database.getOrders();
    const pending = orders.filter(o => !['delivered', 'refunded'].includes(o.status)).length;
    const vipCount = Database.getVipUsers().length;
    const logs = Database.getLogs(1).length;
    res.json({
        orders: orders.length,
        pending,
        vipCount,
        logs
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
            if (['paid', 'paid_pending_stock', 'delivered'].includes(order.status)) {
                return res.sendStatus(200);
            }
            Database.updateOrder(orderId, { status: 'paid' });
            const userId = order.userId;
            const productId = order.productId;

            // 3. Dar recompensa de Reputação (Gamificação)
            Database.addRep(userId, 50);

            // 4. Notificar o utilizador no Telegram
            await bot.telegram.sendMessage(userId, 
                `🎉 <b>PAGAMENTO CONFIRMADO!</b>\n\n` +
                `Obrigado pela sua compra na <b>Axion Store</b>.\n` +
                `💰 Valor: R$ ${amount}\n` +
                `💎 Bónus: +50 REP adicionados ao seu perfil.\n\n` +
                `📦 <b>O seu produto será enviado abaixo:</b>`, 
                { parse_mode: 'HTML' }
            );

            // 5. Entrega do Produto
            const product = Database.getProductById(productId);
            if (product?.category === 'vip') {
                Database.toggleVip(userId);
                await bot.telegram.sendMessage(userId, "VIP ativado para a sua conta.");
            }

            const item = Database.popStock(productId);
            if (item) {
                await bot.telegram.sendMessage(userId, `Produto: ${item}`);
                Database.updateOrder(orderId, { status: 'delivered', deliveredAt: new Date().toISOString() });
            } else {
                await bot.telegram.sendMessage(userId, "Seu produto esta em preparacao. Em breve enviaremos aqui.");
                Database.updateOrder(orderId, { status: 'paid_pending_stock' });
            }

            // 6. Log de Auditoria
            Database.addLog(`Venda Finalizada: User ${userId} - R$ ${amount}`);

        } catch (error) {
            console.error("Erro ao processar entrega:", error);
        }
    }

    // Responder 200 para a FluxoPay não tentar reenviar o aviso
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🛰️ Webhook Axion ativo na porta ${PORT}`));


