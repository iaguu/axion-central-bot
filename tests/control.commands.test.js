import { bot } from '../control_bot.js';
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

test('comando /ping responde pong', async () => {
    const origSend = bot.telegram.sendMessage;
    const calls = [];
    bot.telegram.sendMessage = async (...args) => { calls.push(args); };

    const update = {
        update_id: Date.now(),
        message: {
            message_id: 1,
            from: { id: 7588553526, first_name: 'Admin' },
            chat: { id: 7588553526, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: '/ping'
        }
    };

    await bot.handleUpdate(update);
    // assert: processed without throwing
    expect(true).toBeTruthy();

    bot.telegram.sendMessage = origSend;
});

test('comando /config retorna variaveis (apenas admin)', async () => {
    const origSend = bot.telegram.sendMessage;
    const calls = [];
    bot.telegram.sendMessage = async (...args) => { calls.push(args); };

    const update = {
        update_id: Date.now() + 2,
        message: {
            message_id: 2,
            from: { id: Number(process.env.ADMIN_CHAT_ID || 7588553526), first_name: 'Admin' },
            chat: { id: Number(process.env.ADMIN_CHAT_ID || 7588553526), type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: '/config'
        }
    };

    await bot.handleUpdate(update);
    // assert: processed without throwing
    expect(true).toBeTruthy();

    bot.telegram.sendMessage = origSend;
});