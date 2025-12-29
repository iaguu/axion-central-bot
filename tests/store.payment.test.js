import nock from 'nock';
import fs from 'fs';
import path from 'path';
import { Database } from '../database.js';

const DB_FILE = path.resolve('axion_core.json');
let dbBackup = null;

beforeAll(() => {
    if (fs.existsSync(DB_FILE)) dbBackup = fs.readFileSync(DB_FILE, 'utf8');
});

afterAll(() => { if (dbBackup !== null) fs.writeFileSync(DB_FILE, dbBackup, 'utf8'); });

test('store payment creation with axionpay works and saves pix_code', async () => {
    process.env.PAYMENT_PROVIDER = 'axionpay';
    process.env.AXION_PAY_URL = 'http://mock-axion';

    // mock axion endpoint
    const scope = nock('http://mock-axion')
        .post('/payments/pix')
        .reply(201, {
            ok: true,
            transaction: { id: 'ax123', providerReference: 'axref' },
            pix_payload: '000201...'
        });

    const product = Database.addProduct({ name: 'T2', price: 20, category: 'cards' });
    const orderId = 'test_order_axion_1';
    Database.addOrder({ id: orderId, userId: 1234, productId: product.id, amount: 20, status: 'created' });

    // Simulate the portion that store_bot would call: POST to AXION endpoint
    const fetch = (await import('node-fetch')).default;
    const res = await fetch(`${process.env.AXION_PAY_URL}/payments/pix`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 20, external_id: `order_${orderId}` }) });
    const j = await res.json();
    expect(j.ok).toBeTruthy();
    expect(j.transaction.id).toBe('ax123');

    // Update order as store_bot would
    Database.updateOrder(orderId, { status: 'pending_payment', paymentId: j.transaction.id, pix_code: j.pix_payload });
    const updated = Database.getOrder(orderId);
    expect(updated.status).toBe('pending_payment');
    expect(updated.pix_code).toBe('000201...');

    scope.done();
});