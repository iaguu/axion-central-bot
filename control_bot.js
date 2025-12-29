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

const fetchWithRetry = async (url, options = {}, { retries = DEFAULT_FETCH_RETRIES, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res;
        } catch (e) {
            console.error(`fetchWithRetry attempt ${attempt} failed for ${url}: ${e.message}`);
            if (attempt === retries) {
                if (e.name === 'AbortError' || e.type === 'aborted' || e.message === 'The operation was aborted.') {
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

const cache = new Map();
const getCache = (key) => {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > entry.ttl) {
        cache.delete(key);
        return null;
    }
    return entry.value;
};
const setCache = (key, value, ttl) => cache.set(key, { value, ts: Date.now(), ttl });

const userWarns = new Map();
const ALLOWED_URLS = (process.env.ALLOW_URLS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

// Configuração da instância segura

const bot = new Telegraf(process.env.TOKEN_CONTROL);
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID);
const APP_VERSION = process.env.npm_package_version || "dev";

requireEnv(["TOKEN_CONTROL", "ADMIN_CHAT_ID"]);
console.log(`fetch defaults: timeout=${DEFAULT_FETCH_TIMEOUT_MS}ms retries=${DEFAULT_FETCH_RETRIES}`);

const getMention = (u) => `<a href="tg://user?id=${u.id}">${u.first_name}</a>`;

bot.start((ctx) => {
    const isAdminUser = ctx.from.id === ADMIN_ID;
    const rows = [
        ['/ping', '/id'],
        ['/vip_info', '/daily'],
        ['/top', '/perfil']
    ];
    if (isAdminUser) {
        rows.push(['/banlist', '/unban']);
        rows.push(['/limpar_cache', '/ping_api']);
        rows.push(['/logs', '/limpar_logs']);
        rows.push(['/repor_estoque', '/addestoque']);
        rows.push(['/reembolso', '/pool_set']);
        rows.push(['/pool_add', '/lockdown_status']);
        rows.push(['/vip_lista', '/top_search']);
    }

    ctx.replyWithHTML(
        `\u{1F4CB} <b>MENU INICIAL</b>\n\n` +
        `Use os bot\u00f5es abaixo para acessar os comandos.`,
        Markup.keyboard(rows).resize().persistent()
    );
});


// Middleware para verificar se é Admin do Telegram ou o Dono
const isAdmin = async (ctx) => {
    if (ctx.from.id === ADMIN_ID) return true;
    if (ctx.chat.type === 'private') return true;
    const chatAdmins = await ctx.getChatAdministrators();
    return chatAdmins.some(admin => admin.user.id === ctx.from.id);
};

bot.catch((err) => console.error("[Overlord Error]", err));

// ==========================================
// 🛡️ MODERAÇÃO E UTILITÁRIOS BASE
// ==========================================


// --- ANTI-SPAM COM SISTEMA DE WARNS ---

bot.on('text', async (ctx, next) => {
    const spamPattern = /(t\.me\/\S+|@\w+bot|https?:\/\/\S+|bit\.ly\/\S+|whatsapp\.com\/\S+)/i;
    const text = ctx.message.text || "";
    if (spamPattern.test(text) && ctx.from.id !== ADMIN_ID) {
        if (ALLOWED_URLS.some(u => text.includes(u))) return next();
        
        const chatMember = await ctx.getChatMember(ctx.from.id);
        if (chatMember.status === 'administrator' || chatMember.status === 'creator') return next();

        await ctx.deleteMessage().catch(() => {});
        
        // Sistema de contagem de avisos
        let warns = (userWarns.get(ctx.from.id) || 0) + 1;
        userWarns.set(ctx.from.id, warns);

        if (warns >= 3) {
            await ctx.restrictChatMember(ctx.from.id, { until_date: Math.floor(Date.now() / 1000) + 3600 }); // Mute 1h
            userWarns.delete(ctx.from.id);
            return ctx.replyWithHTML(`🚫 <b>USUÁRIO SILENCIADO:</b> ${ctx.from.first_name} excedeu o limite de avisos de spam.`);
        }

        return ctx.replyWithHTML(`⚠️ <b>SEM LINKS, ${ctx.from.first_name.toUpperCase()}!</b>\nAvisos: <code>${warns}/3</code>`);
    }
    return next();
});
bot.command('ping', (ctx) => ctx.replyWithHTML(`🏓 <b>Pong!</b> Online e operacional.`));

bot.command('id', (ctx) => {
    const target = ctx.message.reply_to_message ? ctx.message.reply_to_message.from : ctx.from;
    ctx.replyWithHTML(`🆔 <b>ID de ${target.first_name}:</b> <code>${target.id}</code>`);
});

bot.command('ban', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply("❌ Sem permissão.");
    if (!ctx.message.reply_to_message) return ctx.reply("Responda a alguém.");
    await ctx.banChatMember(ctx.message.reply_to_message.from.id);
    Database.addLog(`Ban: ${ctx.message.reply_to_message.from.id} by ${ctx.from.id}`);
    ctx.replyWithHTML(`☠️ <b>Banido com sucesso!</b>`);
});

bot.command('kick', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply("❌ Sem permissão.");
    if (!ctx.message.reply_to_message) return ctx.reply("Responda a alguém.");
    await ctx.unbanChatMember(ctx.message.reply_to_message.from.id);
    ctx.replyWithHTML(`👞 <b>Expulso com sucesso!</b>`);
});

bot.command('mute', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply("? Sem permiss?o.");
    const args = ctx.message.text.split(' ').slice(1);
    let targetId;
    let minutes = 60;
    if (args.length >= 1) {
        targetId = args[0];
        if (args[1]) minutes = Number(args[1]);
    } else if (ctx.message.reply_to_message) {
        targetId = ctx.message.reply_to_message.from.id;
    }
    if (!targetId) return ctx.reply("Use: /mute ID [min]");
    if (!minutes || isNaN(minutes)) minutes = 60;
    await ctx.restrictChatMember(targetId, { until_date: Math.floor(Date.now() / 1000) + (minutes * 60) });
    Database.addLog(`Mute: ${targetId} (${minutes}m) by ${ctx.from.id}`);
    ctx.replyWithHTML(`?? <b>Silenciado por ${minutes} min.</b>`);
});


bot.command('unban', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply('? Sem permiss?o.');
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Use: /unban ID');
    await ctx.unbanChatMember(id);
    Database.addLog(`Unban: ${id} by ${ctx.from.id}`);
    ctx.replyWithHTML('? Usu?rio liberado.');
});

bot.command('warn', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply("\u274C Sem permiss\u00e3o.");
    const id = ctx.message.text.split(' ')[1] || ctx.message.reply_to_message?.from?.id;
    if (!id) return ctx.reply("Use: /warn ID");
    const count = Database.addWarn(id, 1);
    Database.addLog(`Warn: ${id} (${count}) by ${ctx.from.id}`);
    ctx.replyWithHTML(`\u26A0\uFE0F <b>Warn aplicado</b>\nTotal: <b>${count}</b>`);
});

bot.command('warns', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply("\u274C Sem permiss\u00e3o.");
    const id = ctx.message.text.split(' ')[1] || ctx.message.reply_to_message?.from?.id;
    if (!id) return ctx.reply("Use: /warns ID");
    const count = Database.getWarns(id);
    ctx.replyWithHTML(`\u26A0\uFE0F <b>Warns de ${id}:</b> <b>${count}</b>`);
});

bot.command('config', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('\u274C Acesso negado.');
    const rows = [
        ['TOKEN_CONTROL', !!process.env.TOKEN_CONTROL],
        ['ADMIN_CHAT_ID', !!process.env.ADMIN_CHAT_ID],
        ['TOKEN_SEARCH', !!process.env.TOKEN_SEARCH],
        ['TOKEN_STORE', !!process.env.TOKEN_STORE],
        ['FLUXO_TOKEN', !!process.env.FLUXO_TOKEN],
        ['CALLBACK_URL', !!process.env.CALLBACK_URL],
        ['FLUXO_WEBHOOK_TOKEN', !!process.env.FLUXO_WEBHOOK_TOKEN]
    ];
    const lines = rows.map(([k, ok]) => `${ok ? '?' : '?'} ${k}`);
    ctx.replyWithHTML(`\u{1F9F0} <b>CONFIG</b>\n\n${lines.join('\n')}`);
});

bot.command('broadcast', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('\u274C Acesso negado.');
    const msg = ctx.message.text.split(' ').slice(1).join(' ');
    if (!msg) return ctx.reply('Use: /broadcast mensagem');
    const ids = Database.getVipUsers();
    if (!ids.length) return ctx.reply('Nenhum VIP ativo.');
    let ok = 0;
    for (const id of ids) {
        try {
            await bot.telegram.sendMessage(id, `\u{1F4E3} ${msg}`);
            ok += 1;
        } catch (e) {}
    }
    ctx.replyWithHTML(`\u{1F4E3} Enviado para <b>${ok}</b> VIP(s).`);
});

bot.command('version', (ctx) => {
    ctx.replyWithHTML(`\u{1F4E6} <b>VERS\u00C3O</b>\n\n${APP_VERSION}`);
});

bot.command('banlist', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('? Acesso negado.');
    const logs = Database.getLogs(50).filter(l => l.a.startsWith('Ban:')).slice(-10);
    if (!logs.length) return ctx.reply('Sem registros de ban.');
    const lines = logs.map(l => `- ${l.t} - ${l.a}`);
    ctx.replyWithHTML(`\u{1F4C4} <b>\u00daLTIMOS BANS</b>\n\n${lines.join('\n')}`);
});

bot.command('limpar_logs', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('? Acesso negado.');
    Database.clearLogs();
    ctx.replyWithHTML('\u{1F9F9} Logs limpos.');
});

bot.command('lockdown_status', (ctx) => {
    const status = Database.getLockdown();
    ctx.replyWithHTML(`\u{1F512} <b>LOCKDOWN</b>\n\nStatus: <b>${status ? 'ATIVO' : 'INATIVO'}</b>`);
});

bot.command('vip_lista', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('? Acesso negado.');
    const vipIds = Database.getVipUsers();
    if (!vipIds.length) return ctx.reply('Nenhum VIP ativo.');
    const lines = vipIds.slice(0, 20).map(id => `- ${id}`);
    ctx.replyWithHTML(`\u{1F48E} <b>VIPs ATIVOS</b>\n\n${lines.join('\n')}`);
});

bot.command('top_search', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('? Acesso negado.');
    const users = Database.getUsers();
    const ranking = Object.entries(users)
        .map(([id, u]) => ({ id, total: u.totalSearches || 0 }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);
    if (!ranking.length) return ctx.reply('Sem dados.');
    const lines = ranking.map((u, i) => `${i + 1}. ${u.id} - ${u.total}`);
    ctx.replyWithHTML(`\u{1F3C6} <b>TOP BUSCAS</b>\n\n${lines.join('\n')}`);
});

bot.command('pool_add', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('? Acesso negado.');
    const val = Number((ctx.message.text.split(' ')[1] || '').replace(',', '.'));
    if (!val || isNaN(val)) return ctx.reply('Use: /pool_add 100');
    const updated = Database.getPool() + val;
    Database.updatePool(updated);
    ctx.replyWithHTML(`\u{1F4B0} Pool atualizado: <b>R$ ${updated.toFixed(2)}</b>`);
});

bot.command('pool_set', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('? Acesso negado.');
    const val = Number((ctx.message.text.split(' ')[1] || '').replace(',', '.'));
    if (!val || isNaN(val)) return ctx.reply('Use: /pool_set 100');
    Database.updatePool(val);
    ctx.replyWithHTML(`\u{1F4B0} Pool definido: <b>R$ ${val.toFixed(2)}</b>`);
});

bot.launch().then(() => console.log("🛡️ OVERLORD v3.0 ONLINE"));







