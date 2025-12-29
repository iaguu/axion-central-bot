import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { app, bot } from '../webhook.js';
import { Database } from '../database.js';

const DB_FILE = path.resolve('axion_core.json');
let dbBackup = null;

beforeAll(() => {
    process.env.PIX_WEBHOOK_SECRET = 'testsecret123';
    // backup DB
    if (fs.existsSync(DB_FILE)) {
        dbBackup = fs.readFileSync(DB_FILE, 'utf8');
    }
});

afterAll(() => {
    // restore DB
    if (dbBackup !== null) fs.writeFileSync(DB_FILE, dbBackup, 'utf8');
});

test('POST /webhooks/pix processes paid pix and updates order', async () => {
    // Prepare: create product and order
    const product = Database.addProduct({ name: 'TEST PROD', price: 10, category: 'vip' });
    const order = Database.addOrder({ id: 'test_order_1', userId: 999999, productId: product.id, amount: 10, status: 'pending_payment' });

    // Stub bot.telegram.sendMessage to avoid network calls
    const origSend = bot.telegram.sendMessage;
    bot.telegram.sendMessage = async () => {};

    const res = await request(app)
        .post('/webhooks/pix')
        .set('x-webhook-token', 'testsecret123')
        .send({ status: 'paid', external_id: `order_${order.id}`, amount: 10 });

    expect(res.status).toBe(200);

    const updated = Database.getOrder(order.id);
    expect(['delivered','paid_pending_stock','paid'].includes(updated.status)).toBeTruthy();

    // Restore stub
    bot.telegram.sendMessage = origSend;
});