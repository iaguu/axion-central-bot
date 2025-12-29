import nock from 'nock';
import { bot } from '../search_bot.js';
import fs from 'fs';
import path from 'path';
import { Database } from '../database.js';

const DB_FILE = path.resolve('axion_core.json');
let dbBackup = null;

beforeAll(() => {
    if (fs.existsSync(DB_FILE)) dbBackup = fs.readFileSync(DB_FILE, 'utf8');
    // avoid real Telegram API calls
    bot.telegram.getMe = async () => ({ id: 0, is_bot: true });
    bot.telegram.callApi = async () => ({ ok: true });
});

afterAll(async () => {
    if (dbBackup !== null) fs.writeFileSync(DB_FILE, dbBackup, 'utf8');
    try { await bot.stop(); } catch (_) {}
});

test('comando /cpf realiza consulta e envia resultado', async () => {
    // arrange: stub cog api and publicUrl
    const cpf = '00000000000';
    nock('https://cog.api.br')
        .get('/api/v1/consulta')
        .query(true)
        .reply(200, { success: true, data: { publicUrl: 'https://cog.api.br/results/123' } });

    nock('https://cog.api.br')
        .get('/results/123')
        .reply(200, `<textarea id="resultText">Nome: Teste\nCPF: ${cpf}</textarea>`);

    // stub bot.telegram.sendMessage to capture calls
    const origSend = bot.telegram.sendMessage;
    const calls = [];
    bot.telegram.sendMessage = async (...args) => { calls.push(args); };

    const update = {
        update_id: Date.now(),
        message: {
            message_id: 1,
            from: { id: 7588553526, first_name: 'Test', username: 'testuser' },
            chat: { id: 7588553526, type: 'private' },
            date: Math.floor(Date.now() / 1000),
            text: `/cpf ${cpf}`,
            entities: [{ offset: 0, length: 4, type: 'bot_command' }]
        }
    };

    // sanity check: user has access
    const acc = Database.checkAccess(7588553526);
    expect(acc.ok).toBeTruthy();

    // act
    let called = false;
    const origAdd = Database.addSearchHistory;
    Database.addSearchHistory = (uid, entry) => { called = true; return origAdd(uid, entry); };

    await bot.handleUpdate(update);

    // assert: cog endpoint was called and history updated
    expect(nock.isDone()).toBeTruthy();
    expect(called).toBeTruthy();
    const hist = Database.getSearchHistory(7588553526);
    expect(hist.some(h => h.query === cpf && h.cmd === 'cpf')).toBeTruthy();

    // restore
    Database.addSearchHistory = origAdd;
    bot.telegram.sendMessage = origSend;
});