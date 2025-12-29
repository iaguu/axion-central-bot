import nock from 'nock';
import { bot } from '../store_bot.js';
import fs from 'fs';
import path from 'path';
import { Database } from '../database.js';

const DB_FILE = path.resolve('axion_core.json');
let dbBackup = null;

beforeAll(() => {
    if (fs.existsSync(DB_FILE)) dbBackup = fs.readFileSync(DB_FILE, 'utf8');
    bot.telegram.getMe = async () => ({ id: 0, is_bot: true });
    bot.telegram.callApi = async () => ({ ok: true });
});

afterAll(async () => {
    if (dbBackup !== null) fs.writeFileSync(DB_FILE, dbBackup, 'utf8');
    try { await bot.stop(); } catch (_) {}
});

test('axionpay: copia_colar completo é salvo e enviado em <pre>', async () => {
    const product = Database.addProduct({ name: 'BUY PROD LONG', price: 63.5, category: 'misc' });

    const copia = "00020101021126330014br.gov.bcb.pix011138209847805520400005303986540563.505802BR5910LOJA AXION6009SAO PAULO62290525C2A4FC45D1254F88A475EE0476304B69F";

    nock(process.env.AXION_PAY_URL || 'http://localhost:3060')
        .post('/payments/pix')
        .reply(200, {
            ok: true,
            transaction: {
                id: 'c2a4fc45-d125-4f88-a475-ee04704c2fb4',
                amount: 63.5,
                metadata: { pix: { copia_colar: copia, qrcode: 'qrcode...' } }
            },
            pix_payload: copia
        });

    const sent = [];
    const origSend = bot.telegram.sendMessage;
    bot.telegram.sendMessage = async (...args) => { sent.push(args); };

    // Also capture replies via ctx.replyWithHTML which may be used in callback contexts
    const origReply = bot.context.replyWithHTML;
    bot.context.replyWithHTML = async function(...args) { sent.push(args); if (origReply) return origReply.apply(this, args); };

    const update = {
        update_id: Date.now() + 999,
        callback_query: {
            id: 'cbpix',
            from: { id: 7588553526, first_name: 'Buyer' },
            message: { message_id: 100, chat: { id: 7588553526, type: 'private' } },
            data: `buy_${product.id}`
        }
    };

    // stub very small network calls
    bot.telegram.callApi = async () => ({ ok: true });

    await bot.handleUpdate(update);

    const orders = Database.getOrdersByUser(7588553526);
    expect(orders.length).toBeGreaterThanOrEqual(1);
    const o = orders.find(x => x.productId == product.id);
    expect(o).toBeTruthy();
    expect(o.pix_code).toBe(copia);

    // Ensure we sent a <pre> message containing the full string and the new label
    const preMsg = sent.find(s => (s || []).some && (s || []).some(arg => String(arg || '').includes('<pre>')));
    expect(preMsg).toBeTruthy();
    const preText = (preMsg || []).find(arg => String(arg || '').includes('<pre>'));
    const txt = String(preText);
    expect(txt.includes('C2A4FC45')).toBeTruthy();
    // Should no longer contain inline <code> duplication
    expect(txt.includes('<code>')).toBeFalsy();
    // Should include the new label 'COPIAR AQUI'
    expect(txt.includes('COPIAR AQUI')).toBeTruthy();

});

// Ensure pix_payload takes precedence over metadata.copia_colar when both exist
test('axionpay: pix_payload tem prioridade sobre metadata.copia_colar', async () => {
    const product2 = Database.addProduct({ name: 'PRIORITY PROD', price: 12, category: 'misc' });
    const payload = 'REAL_PAYLOAD_1234567890';
    const copia2 = 'TRUNC_COPIA_999';

    nock(process.env.AXION_PAY_URL || 'http://localhost:3060')
        .post('/payments/pix')
        .reply(200, {
            ok: true,
            transaction: {
                id: 'ddd2c2a4fc45',
                amount: 12,
                metadata: { pix: { copia_colar: copia2 } }
            },
            pix_payload: payload
        });

    const sent2 = [];
    const origSend2 = bot.telegram.sendMessage;
    bot.telegram.sendMessage = async (...args) => { sent2.push(args); };

    // capture replyWithHTML as well
    const origReply2 = bot.context.replyWithHTML;
    bot.context.replyWithHTML = async function(...args) { sent2.push(args); if (origReply2) return origReply2.apply(this, args); };

    const update2 = {
        update_id: Date.now() + 1000,
        callback_query: {
            id: 'cbpix2',
            from: { id: 7588553526, first_name: 'Buyer' },
            message: { message_id: 101, chat: { id: 7588553526, type: 'private' } },
            data: `buy_${product2.id}`
        }
    };

    bot.telegram.callApi = async () => ({ ok: true });

    await bot.handleUpdate(update2);

    const orders2 = Database.getOrdersByUser(7588553526);
    const o2 = orders2.find(x => x.productId == product2.id);
    expect(o2).toBeTruthy();
    expect(o2.pix_code).toBe(payload);

    const preMsg2 = sent2.find(s => (s || []).some && (s || []).some(arg => String(arg || '').includes('<pre>')));
    expect(preMsg2).toBeTruthy();
    const preText2 = (preMsg2 || []).find(arg => String(arg || '').includes('<pre>'));
    const txt2 = String(preText2);
    expect(txt2.includes(payload)).toBeTruthy();

    // restore
    bot.telegram.sendMessage = origSend2;
    bot.context.replyWithHTML = origReply2;
});

// Replicando o payload real fornecido e verificando que usamos pix_payload
test('axionpay: usa pix_payload top-level quando presente (payload real)', async () => {
    const product3 = Database.addProduct({ name: 'REALPAY PROD', price: 63.5, category: 'misc' });
    const realPayload = "00020101021126330014br.gov.bcb.pix011138209847805520400005303986540563.505802BR5910LOJA AXION6009SAO PAULO62290525C2A4FC45D1254F88A475EE0476304B69F";

    nock(process.env.AXION_PAY_URL || 'http://localhost:3060')
        .post('/payments/pix')
        .reply(200, {
            ok: true,
            transaction: {
                id: 'c2a4fc45-d125-4f88-a475-ee04704c2fb4',
                amount: 63.5,
                amount_cents: 6350,
                currency: 'BRL',
                method: 'pix',
                status: 'pending',
                customer: { id: 'CLI-INT-001', name: 'Cliente Interno', email: 'interno@teste.com' },
                provider: 'pix-local',
                providerReference: 'c2a4fc45-d125-4f88-a475-ee04704c2fb4',
                capture: true,
                createdAt: '2025-12-28T21:30:44.034Z',
                updatedAt: '2025-12-28T21:30:44.037Z',
                metadata: {
                    orderId: 'PED-INTERNO-001',
                    integration: 'cloudflare-proxy',
                    source: 'api_interna',
                    transactionId: 'c2a4fc45-d125-4f88-a475-ee04704c2fb4',
                    pix: {
                        amount_cents: 6350,
                        currency: 'BRL',
                        qrcode: realPayload,
                        copia_colar: realPayload,
                        txid: 'C2A4FC45D1254F88A475EE047',
                        expiresAt: '2025-12-28T21:45:44.036Z'
                    }
                }
            },
            pix_payload: realPayload
        });

    const sent3 = [];
    const origSend3 = bot.telegram.sendMessage;
    bot.telegram.sendMessage = async (...args) => { sent3.push(args); };

    const origReply3 = bot.context.replyWithHTML;
    bot.context.replyWithHTML = async function(...args) { sent3.push(args); if (origReply3) return origReply3.apply(this, args); };

    const update3 = {
        update_id: Date.now() + 20000,
        callback_query: {
            id: 'cbpix-real-2',
            from: { id: 7588553526, first_name: 'Buyer' },
            message: { message_id: 120, chat: { id: 7588553526, type: 'private' } },
            data: `buy_${product3.id}`
        }
    };

    bot.telegram.callApi = async () => ({ ok: true });
    await bot.handleUpdate(update3);

    const orders3 = Database.getOrdersByUser(7588553526);
    const o3 = orders3.find(x => x.productId == product3.id);
    expect(o3).toBeTruthy();
    expect(o3.pix_code).toBe(realPayload);

    const preMsg3 = sent3.find(s => (s || []).some && (s || []).some(arg => String(arg || '').includes('<pre>')));
    expect(preMsg3).toBeTruthy();
    const preText3 = (preMsg3 || []).find(arg => String(arg || '').includes('<pre>'));
    expect(String(preText3).includes(realPayload)).toBeTruthy();

    // restore
    bot.telegram.sendMessage = origSend3;
    bot.context.replyWithHTML = origReply3;
});