import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { Database } from "./database.js";
import { requireEnv, fetchWithRetry } from "./utils.js";
import os from 'os';
import fs from 'fs';

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

// ETIMEOUT observability
const ETIMEOUT = { count: 0, windowStart: Date.now(), alerted: false };
const ETIMEOUT_WINDOW_MS = 60 * 60 * 1000; // 1h
const ETIMEOUT_THRESHOLD = 5;

const onFetchTimeout = async (url) => {
    const now = Date.now();
    if (now - ETIMEOUT.windowStart > ETIMEOUT_WINDOW_MS) {
        ETIMEOUT.count = 0; ETIMEOUT.windowStart = now; ETIMEOUT.alerted = false;
    }
    ETIMEOUT.count += 1;
    if (!ETIMEOUT.alerted && ETIMEOUT.count >= ETIMEOUT_THRESHOLD && ADMIN_ID) {
        ETIMEOUT.alerted = true;
        try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ Muitos timeouts nas requisições externas (${ETIMEOUT.count} em 1h).`); } catch (_) {}
    }
};

const getMention = (u) => `<a href="tg://user?id=${u.id}">${u.first_name}</a>`;

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    try { Database.addLog(`UncaughtPromise: ${reason && reason.message ? reason.message : JSON.stringify(reason)}`); } catch (_) {}
    setTimeout(() => process.exit(1), 1000);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    try { Database.addLog(`UncaughtException: ${err && err.message ? err.message : String(err)}`); } catch (_) {}
    setTimeout(() => process.exit(1), 1000);
});
process.on('SIGINT', async () => {
    console.log('SIGINT received, shutting down gracefully');
    try { await bot.stop(); } catch (_) {}
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully');
    try { await bot.stop(); } catch (_) {}
    process.exit(0);
});

// --- MENU PRINCIPAL (INLINE) ---
const sendMainMenu = async (ctx) => {
    const isAdminUser = ctx.from.id === ADMIN_ID;
    
    const buttons = [
        [Markup.button.callback("👤 Meu Perfil", "menu_perfil"), Markup.button.callback("💎 Daily", "menu_daily")],
        [Markup.button.callback("🏆 Ranking", "menu_top"), Markup.button.callback("ℹ️ VIPs Online", "menu_vips")],
        [Markup.button.callback("🆔 Meu ID", "menu_id"), Markup.button.callback("🏓 Ping", "menu_ping")]
    ];

    if (isAdminUser) {
        buttons.push([Markup.button.callback("🛡️ Painel Admin", "admin_panel")]);
    }

    const text = `\u{1F4CB} <b>PAINEL DE CONTROLE</b>\n\nBem-vindo ao sistema central Axion.\nSelecione uma opção:`;
    
    if (ctx.updateType === 'callback_query') {
        await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }).catch(() => ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons)));
    } else {
        await ctx.replyWithHTML(text, Markup.inlineKeyboard(buttons));
    }
};

bot.start(sendMainMenu);
bot.action('main_menu', sendMainMenu);

bot.action('admin_panel', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Acesso negado.", { show_alert: true });
    const buttons = [
        [Markup.button.callback("📜 Logs", "adm_logs"), Markup.button.callback("👥 VIP Lista", "adm_viplist")],
        [Markup.button.callback("🧹 Limpar Cache", "adm_clearcache"), Markup.button.callback("📡 Ping API", "adm_pingapi")],
        [Markup.button.callback("🔒 Lockdown", "adm_lockdown"), Markup.button.callback("📊 Top Search", "adm_topsearch")],
        [Markup.button.callback("🔙 Voltar", "main_menu")]
    ];
    ctx.editMessageText(`🛡️ <b>PAINEL ADMINISTRATIVO</b>\n\nSelecione uma ferramenta:`, {
        parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons)
    });
});


// Middleware para verificar se é Admin do Telegram ou o Dono
const isAdmin = async (ctx) => {
    if (ctx.from.id === ADMIN_ID) return true;
    if (ctx.chat.type === 'private') return true;
    const chatAdmins = await ctx.getChatAdministrators();
    return chatAdmins.some(admin => admin.user.id === ctx.from.id);
};

bot.catch((err) => console.error("[Overlord Error]", err));

// --- MIDDLEWARES GLOBAIS ---

// 1. Maintenance Mode
bot.use(async (ctx, next) => {
    if (Database.getLockdown() && ctx.from?.id !== ADMIN_ID) {
        if (ctx.callbackQuery) return ctx.answerCbQuery("⚠️ Sistema em manutenção.", { show_alert: true });
        return ctx.reply("⚠️ <b>SISTEMA EM MANUTENÇÃO</b>\nVoltaremos em breve.", { parse_mode: 'HTML' });
    }
    await next();
});

// 2. Rate Limiting (Simples)
const rateLimit = new Map();
bot.use(async (ctx, next) => {
    if (ctx.from && ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
        const last = rateLimit.get(ctx.from.id) || 0;
        if (Date.now() - last < 1000) return; // 1s cooldown para comandos
        rateLimit.set(ctx.from.id, Date.now());
    }
    await next();
});

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

        await ctx.deleteMessage().catch((err)=>{ console.debug('deleteMessage failed:', err && err.message); });
        
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

// 3. Welcome Message
bot.on('new_chat_members', (ctx) => {
    ctx.reply(`Bem-vindo(a) ao grupo, ${ctx.message.new_chat_members.map(u => u.first_name).join(', ')}! 👋`);
});

bot.command('ping', (ctx) => ctx.replyWithHTML(`🏓 <b>Pong!</b> Online e operacional.`));

bot.command('id', (ctx) => {
    const target = ctx.message.reply_to_message ? ctx.message.reply_to_message.from : ctx.from;
    ctx.replyWithHTML(`🆔 <b>ID de ${target.first_name}:</b> <code>${target.id}</code>`);
});

bot.action('menu_id', (ctx) => {
    ctx.answerCbQuery();
    ctx.replyWithHTML(`🆔 <b>Seu ID:</b> <code>${ctx.from.id}</code>`);
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
    if (!await isAdmin(ctx)) return ctx.reply("❌ Sem permissão.");
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
    if (isNaN(Number(targetId))) return ctx.reply("❌ ID inválido.");
    await ctx.restrictChatMember(targetId, { until_date: Math.floor(Date.now() / 1000) + (minutes * 60) });
    Database.addLog(`Mute: ${targetId} (${minutes}m) by ${ctx.from.id}`);
    ctx.replyWithHTML(`🔇 <b>Silenciado por ${minutes} min.</b>`);
});


bot.command('unban', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply('❌ Sem permissão.');
    const id = ctx.message.text.split(' ')[1];
    if (!id || isNaN(Number(id))) return ctx.reply('❌ ID inválido.');
    await ctx.unbanChatMember(id);
    Database.addLog(`Unban: ${id} by ${ctx.from.id}`);
    ctx.replyWithHTML('✅ Usuário liberado.');
});

bot.command('warn', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply("\u274C Sem permiss\u00e3o.");
    const id = ctx.message.text.split(' ')[1] || ctx.message.reply_to_message?.from?.id;
    if (!id || isNaN(Number(id))) return ctx.reply("❌ ID inválido.");
    const count = Database.addWarn(id, 1);
    Database.addLog(`Warn: ${id} (${count}) by ${ctx.from.id}`);
    ctx.replyWithHTML(`\u26A0\uFE0F <b>Warn aplicado</b>\nTotal: <b>${count}</b>`);
});

bot.command('warns', async (ctx) => {
    if (!await isAdmin(ctx)) return ctx.reply("\u274C Sem permiss\u00e3o.");
    const id = ctx.message.text.split(' ')[1] || ctx.message.reply_to_message?.from?.id;
    if (!id || isNaN(Number(id))) return ctx.reply("❌ ID inválido.");
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
    const lines = rows.map(([k, ok]) => `${ok ? '✅' : '❌'} ${k}`);
    ctx.replyWithHTML(`\u{1F9F0} <b>CONFIG</b>\n\n${lines.join('\n')}`);
});

bot.command('broadcast', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('\u274C Acesso negado.');
    
    const msg = ctx.message.text.split(' ').slice(1).join(' ') || ctx.message.caption;
    const photo = ctx.message.photo ? ctx.message.photo[ctx.message.photo.length - 1].file_id : null;
    
    if (!msg && !photo) return ctx.reply('Use: /broadcast mensagem (pode enviar foto junto)');
    
    const ids = Database.getVipUsers();
    if (!ids.length) return ctx.reply('Nenhum VIP ativo.');
    
    const send = async (id) => {
        try {
            if (photo) {
                await bot.telegram.sendPhoto(id, photo, { caption: `\u{1F4E3} ${msg || ''}` });
            } else {
                await bot.telegram.sendMessage(id, `\u{1F4E3} ${msg}`);
            }
            return 1;
        } catch (e) { return 0; }
    };
    ctx.reply("⏳ Enviando broadcast...");
    const results = await Promise.all(ids.map(send));
    const ok = results.reduce((a, b) => a + b, 0);
    
    ctx.replyWithHTML(`\u{1F4E3} Enviado para <b>${ok}</b> VIP(s).`);
});

bot.command('version', (ctx) => {
    ctx.replyWithHTML(`\u{1F4E6} <b>VERS\u00C3O</b>\n\n${APP_VERSION}`);
});

bot.command('banlist', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const logs = Database.getLogs(50).filter(l => l.a.startsWith('Ban:')).slice(-10);
    if (!logs.length) return ctx.reply('Sem registros de ban.');
    const lines = logs.map(l => `- ${l.t} - ${l.a}`);
    ctx.replyWithHTML(`\u{1F4C4} <b>\u00daLTIMOS BANS</b>\n\n${lines.join('\n')}`);
});

bot.command('limpar_logs', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    Database.clearLogs();
    ctx.replyWithHTML('\u{1F9F9} Logs limpos.');
});

const sendLockdownStatus = (ctx) => {
    const status = Database.getLockdown();
    ctx.replyWithHTML(`\u{1F512} <b>LOCKDOWN</b>\n\nStatus: <b>${status ? 'ATIVO' : 'INATIVO'}</b>`);
};
bot.command('lockdown_status', sendLockdownStatus);
bot.action('adm_lockdown', (ctx) => { ctx.answerCbQuery(); sendLockdownStatus(ctx); });

bot.command('vip_lista', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const vipIds = Database.getVipUsers();
    if (!vipIds.length) return ctx.reply('Nenhum VIP ativo.');
    const lines = vipIds.slice(0, 20).map(id => `- ${id}`);
    ctx.replyWithHTML(`\u{1F48E} <b>VIPs ATIVOS</b>\n\n${lines.join('\n')}`);
});
bot.action('adm_viplist', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Negado.");
    const vipIds = Database.getVipUsers();
    const count = vipIds.length;
    const lines = vipIds.slice(0, 10).map(id => `- ${id}`).join('\n');
    ctx.editMessageText(`💎 <b>VIPs (${count})</b>\n\n${lines}${count > 10 ? '\n...' : ''}`, 
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "admin_panel")]]) });
});

bot.command('top_search', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const users = Database.getUsers();
    const ranking = Object.entries(users)
        .map(([id, u]) => ({ id, total: u.totalSearches || 0 }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);
    if (!ranking.length) return ctx.reply('Sem dados.');
    const lines = ranking.map((u, i) => `${i + 1}. ${u.id} - ${u.total}`);
    ctx.replyWithHTML(`\u{1F3C6} <b>TOP BUSCAS</b>\n\n${lines.join('\n')}`);
});
bot.action('adm_topsearch', (ctx) => {
    const users = Database.getUsers();
    const ranking = Object.entries(users)
        .map(([id, u]) => ({ id, total: u.totalSearches || 0 }))
        .sort((a, b) => b.total - a.total).slice(0, 5);
    const lines = ranking.map((u, i) => `${i + 1}. ${u.id} - ${u.total}`).join('\n');
    ctx.editMessageText(`🏆 <b>TOP BUSCAS</b>\n\n${lines || 'Sem dados.'}`, 
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "admin_panel")]]) });
});

bot.command('pool_add', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const val = Number((ctx.message.text.split(' ')[1] || '').replace(',', '.'));
    if (!val || isNaN(val)) return ctx.reply('Use: /pool_add 100');
    const updated = Database.getPool() + val;
    Database.updatePool(updated);
    ctx.replyWithHTML(`\u{1F4B0} Pool atualizado: <b>R$ ${updated.toFixed(2)}</b>`);
});

bot.command('pool_set', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const val = Number((ctx.message.text.split(' ')[1] || '').replace(',', '.'));
    if (!val || isNaN(val)) return ctx.reply('Use: /pool_set 100');
    Database.updatePool(val);
    ctx.replyWithHTML(`\u{1F4B0} Pool definido: <b>R$ ${val.toFixed(2)}</b>`);
});

bot.command('logs', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const logs = Database.getLogs(20);
    if (!logs.length) return ctx.reply('Sem logs.');
    const lines = logs.map(l => `${l.t} - ${l.a}`);
    ctx.replyWithHTML(`📋 <b>LOGS DO SISTEMA</b>\n\n<pre>${lines.join('\n')}</pre>`);
});
bot.action('adm_logs', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Negado.");
    const logs = Database.getLogs(10);
    const lines = logs.map(l => `${l.t.split(' ')[1]} - ${l.a.substring(0, 30)}`).join('\n');
    ctx.editMessageText(`📋 <b>LOGS RECENTES</b>\n<pre>${lines}</pre>`, 
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "admin_panel")]]) });
});

bot.command('limpar_cache', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    cache.clear();
    ctx.reply('🧹 Cache local limpo.');
});
bot.action('adm_clearcache', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Negado."); cache.clear(); ctx.answerCbQuery("Cache limpo!");
});

bot.command('ping_api', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const start = Date.now();
    try {
        await fetchWithRetry('https://google.com');
        ctx.reply(`📡 Conectividade OK (${Date.now() - start}ms)`);
    } catch (e) {
        ctx.reply(`❌ Falha na conectividade externa: ${e.message}`);
    }
});
bot.action('adm_pingapi', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Negado."); ctx.answerCbQuery("Pingando..."); try { await fetchWithRetry('https://google.com'); ctx.reply("📡 API OK"); } catch(e) { ctx.reply("❌ API Error"); }
});

bot.command(['addestoque', 'repor_estoque'], (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const parts = ctx.message.text.split(' ');
    const id = parts[1];
    const content = parts.slice(2).join(' ');
    
    if (!id || !content) return ctx.reply('Use: /addestoque ID CONTEUDO');
    
    const prod = Database.addStock(id, [content]);
    if (!prod) return ctx.reply('❌ Produto não encontrado.');
    ctx.reply(`✅ Estoque de ${prod.name} atualizado. Novo total: ${prod.stock.length}`);
});

bot.command('reembolso', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('Use: /reembolso ID_PEDIDO');
    const order = Database.getOrder(id);
    if (!order) return ctx.reply('❌ Pedido não encontrado.');
    Database.updateOrder(id, { status: 'refunded' });
    ctx.replyWithHTML(`💸 Pedido <b>${id}</b> marcado como reembolsado.`);
});

bot.command('dar_vip', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const id = ctx.message.text.split(' ')[1] || ctx.message.reply_to_message?.from?.id;
    if (!id || isNaN(Number(id))) return ctx.reply('❌ ID inválido. Use um ID numérico ou responda a uma mensagem.');
    
    Database.setVip(id, true);
    Database.addLog(`VIP Add: ${id} by ${ctx.from.id}`);
    
    try { await bot.telegram.sendMessage(id, `💎 <b>Parabéns!</b>\nVocê recebeu <b>VIP</b> da administração.`); } catch (_) {}
    ctx.replyWithHTML(`💎 VIP concedido para <b>${id}</b>.`);
});

bot.command('tirar_vip', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.reply('❌ Acesso negado.');
    const id = ctx.message.text.split(' ')[1] || ctx.message.reply_to_message?.from?.id;
    if (!id || isNaN(Number(id))) return ctx.reply('❌ ID inválido. Use um ID numérico ou responda a uma mensagem.');
    
    Database.setVip(id, false);
    Database.addLog(`VIP Remove: ${id} by ${ctx.from.id}`);
    
    ctx.replyWithHTML(`🗑️ VIP removido de <b>${id}</b>.`);
});

// --- NOVOS COMANDOS ÚTEIS (10) ---

// 1. Server Stats
bot.command('server', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const uptime = (os.uptime() / 3600).toFixed(2);
    const freeMem = (os.freemem() / 1024 / 1024).toFixed(0);
    const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
    const users = Object.keys(Database.getUsers()).length;
    const pidMem = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
    ctx.replyWithHTML(`🖥️ <b>SERVER STATUS</b>\n\nUptime: ${uptime}h\nRAM (Sys): ${freeMem}MB / ${totalMem}MB\nRAM (Bot): ${pidMem}MB\nCPUs: ${os.cpus().length}\nUsuários DB: ${users}`);
});

// 2. Backup DB
bot.command('backup', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    try {
        const src = 'axion_core.json';
        const dest = `backup_axion_${Date.now()}.json`;
        fs.copyFileSync(src, dest);
        ctx.reply(`💾 Backup criado: ${dest}`);
    } catch (e) { ctx.reply(`❌ Erro no backup: ${e.message}`); }
});

// 3. User Full Info (DB Dump)
bot.command('user_full', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const id = ctx.message.text.split(' ')[1];
    if (!id || isNaN(Number(id))) return ctx.reply('❌ ID inválido.');
    ctx.replyWithHTML(`📂 <b>DADOS DO USUÁRIO</b>\n<pre>${JSON.stringify(user, null, 2)}</pre>`);
});

// 4. Add Reputação
bot.command('add_rep', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const parts = ctx.message.text.split(' ');
    const id = parts[1];
    const amount = Number(parts[2]);
    if (!id || isNaN(Number(id)) || !amount) return ctx.reply('Use: /add_rep ID QUANTIDADE');
    Database.addRep(id, amount);
    ctx.reply(`✅ Adicionado ${amount} REP para ${id}.`);
});

// 5. Remove Reputação
bot.command('rem_rep', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const parts = ctx.message.text.split(' ');
    const id = parts[1];
    const amount = Number(parts[2]);
    if (!id || isNaN(Number(id)) || !amount) return ctx.reply('Use: /rem_rep ID QUANTIDADE');
    Database.addRep(id, -amount);
    ctx.reply(`✅ Removido ${amount} REP de ${id}.`);
});

// 6. Reset Daily Limit
bot.command('reset_daily', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const id = ctx.message.text.split(' ')[1];
    if (!id || isNaN(Number(id))) return ctx.reply('❌ ID inválido.');
    const user = Database.getUser(id);
    user.dailyCount = 0;
    // Força salvamento indireto ou precisaria de método específico no DB, 
    // mas addRep(0) salva o estado atual do objeto user se for referência
    Database.addRep(id, 0); 
    ctx.reply(`🔄 Limite diário resetado para ${id}.`);
});

// 7. Unmute
bot.command('unmute', async (ctx) => {
    if (!await isAdmin(ctx)) return;
    const id = ctx.message.text.split(' ')[1];
    if (!id || isNaN(Number(id))) return ctx.reply('❌ ID inválido.');
    await ctx.restrictChatMember(id, { permissions: { can_send_messages: true, can_send_media_messages: true, can_send_other_messages: true } });
    ctx.reply(`🔊 Usuário ${id} desmutado.`);
});

// 8. Slowmode
bot.command('slowmode', async (ctx) => {
    if (!await isAdmin(ctx)) return;
    const seconds = Number(ctx.message.text.split(' ')[1] || 0);
    await ctx.setChatPermissions(ctx.chat.id, undefined); // Reset permissions logic if needed, usually setChatSlowModeDelay is separate method in API but Telegraf handles via setChatSlowModeDelay if available or generic API call
    // Telegraf shortcut:
    try { await ctx.telegram.callApi('setChatSlowModeDelay', { chat_id: ctx.chat.id, slow_mode_delay: seconds }); ctx.reply(`⏱️ Slowmode: ${seconds}s`); } catch(e) { ctx.reply('Erro ao definir slowmode.'); }
});

// 9. Clear Chat (Delete last X messages)
bot.command('clearchat', async (ctx) => {
    if (!await isAdmin(ctx)) return;
    ctx.reply('🧹 Limpeza de chat não suportada totalmente pela API de Bots (bots não podem apagar msg de outros em massa facilmente sem registrar IDs).');
});

// 10. Anúncio (Pin)
bot.command('anuncio', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const msg = ctx.message.text.split(' ').slice(1).join(' ');
    const m = await ctx.reply(`📢 <b>ANÚNCIO OFICIAL</b>\n\n${msg}`, { parse_mode: 'HTML' });
    await ctx.pinChatMessage(m.message_id);
});

// 11. Reply User
bot.command('reply', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const parts = ctx.message.text.split(' ');
    const id = parts[1];
    const msg = parts.slice(2).join(' ');
    if (!id || !msg) return ctx.reply('Use: /reply ID MENSAGEM');
    try {
        await bot.telegram.sendMessage(id, `📩 <b>RESPOSTA DO SUPORTE:</b>\n\n${msg}`, { parse_mode: 'HTML' });
        ctx.reply('✅ Enviado.');
    } catch (e) { ctx.reply('❌ Erro ao enviar.'); }
});

// 12. Admin Help
bot.command('admin_help', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.replyWithHTML(`🛡️ <b>COMANDOS ADMIN</b>\n\n/ban, /unban, /mute, /unmute\n/warn, /warns\n/broadcast, /anuncio\n/reply ID MSG\n/add_rep, /rem_rep\n/dar_vip, /tirar_vip\n/addestoque, /repor_estoque\n/lockdown_status\n/backup, /server, /logs`);
});

// 13. Uptime
bot.command('uptime', (ctx) => {
    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    ctx.reply(`⏱️ Bot online há: ${h}h ${m}m`);
});

// 14. Clean DB (Mock)
bot.command('cleandb', (ctx) => { if (ctx.from.id === ADMIN_ID) ctx.reply("🧹 Rotina de limpeza de usuários inativos executada (simulação)."); });

// --- ALIASES / COMANDOS PARA USUÁRIO (PARA O TECLADO DO /start) ---

const handleDaily = (ctx) => {
    const r = Database.claimDaily(ctx.from.id);
    if (!r.ok) {
        const msg = '❌ Você já reivindicou o daily hoje.';
        return ctx.updateType === 'callback_query' ? ctx.answerCbQuery(msg, {show_alert:true}) : ctx.reply(msg);
    }
    const msg = `💎 <b>Bônus diário</b>\n\nParabéns! Você recebeu <b>+1 REP</b>.\nRep atual: <b>${r.rep}</b>`;
    ctx.updateType === 'callback_query' ? ctx.editMessageText(msg, {parse_mode:'HTML', ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Voltar", "main_menu")]])}) : ctx.replyWithHTML(msg);
};
bot.command('daily', handleDaily);
bot.action('menu_daily', handleDaily);

const handlePerfil = (ctx) => {
    const stats = Database.getUsageStats(ctx.from.id);
    ctx.replyWithHTML(
        `\u{1F464} <b>SEU PERFIL</b>

VIP: <b>${stats.isVip ? 'SIM' : 'NÃO'}</b>
Usos hoje: <b>${stats.dailyCount}</b>
Total de buscas: <b>${stats.totalSearches}</b>`
    ); 
};
bot.command('perfil', handlePerfil);
bot.action('menu_perfil', (ctx) => { ctx.answerCbQuery(); handlePerfil(ctx); });

bot.command('top', (ctx) => {
    const users = Database.getUsers();
    const ranking = Object.entries(users)
        .map(([id, u]) => ({ id, total: u.totalSearches || 0 }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);
    if (!ranking.length) return ctx.reply('Sem dados.');
    const lines = ranking.map((u, i) => `${i + 1}. ${u.id} - ${u.total}`);
    ctx.replyWithHTML(`\u{1F3C6} <b>TOP BUSCAS</b>

${lines.join('\n')}`);
});
bot.action('menu_top', (ctx) => { ctx.answerCbQuery(); bot.handleUpdate({ ...ctx.update, message: { ...ctx.update.callback_query.message, text: '/top', from: ctx.from } }); }); // Reuso preguiçoso ou refatorar

bot.command('vip_info', (ctx) => {
    const vipIds = Database.getVipUsers();
    if (!vipIds.length) return ctx.reply('Nenhum VIP ativo.');
    const lines = vipIds.slice(0, 20).map(id => `- ${id}`);
    ctx.replyWithHTML(`💎 <b>VIPs ATIVOS</b>

${lines.join('\n')}`);
});
bot.action('menu_vips', (ctx) => { ctx.answerCbQuery(); bot.handleUpdate({ ...ctx.update, message: { ...ctx.update.callback_query.message, text: '/vip_info', from: ctx.from } }); });

bot.command('limite', (ctx) => {
    const stats = Database.getUsageStats(ctx.from.id);
    const limit = stats.isVip ? 50 : 10;
    ctx.replyWithHTML(`\u{1F4CA} <b>SEU LIMITE</b>

Usado hoje: <b>${stats.dailyCount}</b>
Limite diário: <b>${limit}</b>`);
});
bot.action('menu_ping', (ctx) => {
    const start = Date.now();
    ctx.answerCbQuery(`🏓 Pong! ${Date.now() - start}ms`);
});

if (process.env.NODE_ENV !== 'test') {
    bot.launch().then(() => { console.log("🛡️ OVERLORD v3.0 ONLINE"); if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, "🛡️ <b>Sistema Iniciado</b>", {parse_mode:'HTML'}).catch(()=>{}); });
}

export { bot };
