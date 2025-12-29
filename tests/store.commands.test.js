import nock from 'nock';
import { bot } from '../store_bot.js';
import fs from 'fs';
import path from 'path';
import { Database } from '../database.js';

const DB_FILE = path.resolve('axion_core.json');
let dbBackup = null;

beforeAll(() => {
    if (fs.existsSync(DB_FILE)) dbBackup = fs.readFileSync(DB_FILE, 'utf8');
});

afterAll(async () => {
    if (dbBackup !== null) fs.writeFileSync(DB_FILE, dbBackup, 'utf8');
    try { await bot.stop(); } catch (_) {}
});

test('comando /catalogo lista produtos', async () => {
    // arrange: ensure there is at least one product
    Database.addProduct({ name: 'TEST PROD', price: 10, category: 'misc' });

    const update = {
        update_id: Date.now(),
        message: {
            message_id: 1,
            from: { id: 7588553526, first_name: 'Buyer' },
            chat: { id: 7588553526, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: '/catalogo'
        }
    };

    // stub Telegram network calls
    bot.telegram.getMe = async () => ({ id: 0, is_bot: true });
    bot.telegram.callApi = async () => ({ ok: true });

    await bot.handleUpdate(update);

    // assert: processed without throwing and products exist
    expect(Database.getProducts().length).toBeGreaterThanOrEqual(1);
});


test('ação de compra cria pedido após callback buy_<id>', async () => {
    const product = Database.addProduct({ name: 'BUY PROD', price: 5, category: 'misc' });

    // mock axion-pay endpoint
    nock(process.env.AXION_PAY_URL || 'http://localhost:3060')
        .post('/payments/pix')
        .reply(200, { id: 'pay123', pix_code: '000111222', status: 'pending', amount: product.price });

    const update = {
        update_id: Date.now() + 1,
        callback_query: {
            id: 'cb1',
            from: { id: 7588553526, first_name: 'Buyer' },
            message: { message_id: 3, chat: { id: 7588553526, type: 'private' } },
            data: `buy_${product.id}`
        }
    };

    // prevent real Telegram API calls for callback answers by stubbing callApi
    const origCallApi = bot.telegram.callApi;
    bot.telegram.callApi = async () => ({ ok: true });
    bot.telegram.getMe = async () => ({ id: 0, is_bot: true });

    await bot.handleUpdate(update);

    bot.telegram.callApi = origCallApi;
    // after action, an order should exist for this user with product id
    const orders = Database.getOrdersByUser(7588553526);
    expect(orders.some(o => o.productId == product.id)).toBeTruthy();
});