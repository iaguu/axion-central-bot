import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import fetch from "node-fetch";
import { Database } from "./database.js";

const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const DEFAULT_FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 3);

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
            // On final attempt, throw a normalized error to avoid leaking raw messages
            if (attempt === retries) {
                if (e.name === 'AbortError' || e.type === 'aborted' || e.message === 'The operation was aborted.') {
                    // Observability
                    await checkAndAlertEt(url);
                    throw new Error('ETIMEOUT');
                }
                throw e;
            }
            await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
        finally {
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

const bot = new Telegraf(process.env.TOKEN_SEARCH);
const COG_API_KEY = process.env.COG_API_KEY;
const COMMANDS = ['cpf', 'cnpj', 'nome', 'telefone', 'email', 'placa'];
const resultsCache = new Map();
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID || 0);

requireEnv(["TOKEN_SEARCH", "COG_API_KEY"]);
console.log(`fetch defaults: timeout=${DEFAULT_FETCH_TIMEOUT_MS}ms retries=${DEFAULT_FETCH_RETRIES}`);

// ETIMEOUT observability
const ETIMEOUT = { count: 0, windowStart: Date.now(), alerted: false };
const ETIMEOUT_WINDOW_MS = 60 * 60 * 1000; // 1h
const ETIMEOUT_THRESHOLD = 5;
const checkAndAlertEt = async (url) => {
    const now = Date.now();
    if (now - ETIMEOUT.windowStart > ETIMEOUT_WINDOW_MS) {
        ETIMEOUT.count = 0; ETIMEOUT.windowStart = now; ETIMEOUT.alerted = false;
    }
    ETIMEOUT.count += 1;
    try { Database.addLog(`fetch timeout: ${url}`); } catch (_) {}
    if (!ETIMEOUT.alerted && ETIMEOUT.count >= ETIMEOUT_THRESHOLD && ADMIN_ID) {
        ETIMEOUT.alerted = true;
        try { await bot.telegram.sendMessage(ADMIN_ID, `⚠️ Muitos timeouts nas requisições externas (${ETIMEOUT.count} em 1h).`); } catch (_) {}
    }
};

const getMention = (user) => user.username ? `@${user.username}` : `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;

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

const delMsg = (ctx, msgId) => setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch((err)=>{ console.debug('deleteMessage failed:', err && err.message); }), 300000);

// Gerador de Relatório HTML
const genHtml = (title, query, raw) => {
    const rows = raw.split('\n').map(l => {
        const p = l.split(':');
        return p.length >= 2 ? `<tr><td class="k">${p[0].replace('','').trim()}</td><td class="v">${p.slice(1).join(':').trim()}</td></tr>` : `<tr><td colspan="2" class="r">${l}</td></tr>`;
    }).join('');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{background:#0a0a0a;color:#eee;font-family:sans-serif;padding:20px}.c{max-width:600px;margin:auto;background:#141414;border:1px solid #333;border-radius:8px;overflow:hidden}.h{background:#000;padding:15px;border-bottom:2px solid #00ff41;color:#00ff41}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #222}.k{color:#888;font-weight:bold;width:40%}.v{color:#fff}</style></head><body><div class="c"><div class="h"><h2>AXION REPORT: ${title.toUpperCase()}</h2></div><div style="padding:20px"><table>${rows}</table></div></div></body></html>`;
};

COMMANDS.forEach(cmd => {
    bot.command(cmd, async (ctx) => {
        const query = ctx.message.text.split(' ').slice(1).join(' ');
        if (!query) return ctx.replyWithHTML(`⚠️ Use: /${cmd} [dados]`);

        const access = Database.checkAccess(ctx.from.id);
        if (!access.ok) return ctx.replyWithHTML(access.msg);

        // MENSAGEM 1: Permanente (Registro)
        await ctx.replyWithHTML(`🔍 <b>BUSCA SOLICITADA</b>\n👤 De: ${getMention(ctx.from)}\n📂 Tipo: <code>${cmd.toUpperCase()}</code>\n🎯 Alvo: <code>${query}</code>`);

        const proc = await ctx.reply("⏳ Processando...");
        try {
            const res = await fetchWithRetry(`https://cog.api.br/api/v1/consulta?type=${cmd}&dados=${encodeURIComponent(query)}`, { headers: { "x-api-key": COG_API_KEY } });
            const json = await res.json();
            if (!json.success) throw new Error(json.message);

            let html = '';
            try {
                const pubRes = await fetchWithRetry(json.data.publicUrl);
                html = await pubRes.text();
            } catch (err) {
                try { Database.addLog(`publicUrl fetch error: ${err && err.message ? err.message : String(err)}`); } catch (_) {}
                console.error('Failed to fetch publicUrl:', err && err.message);
            }
            const raw = html.match(/<textarea[^>]*id=["']resultText["'][^>]*>([\s\S]*?)<\/textarea>/i)?.[1].replace(/&amp;/g, "&") || "Sem dados.";

            const rid = `${ctx.from.id}_${Date.now()}`;
            resultsCache.set(rid, { cmd, query, raw, mention: getMention(ctx.from), stats: access.stats });
            // Expira resultado em 10 minutos
            setTimeout(() => resultsCache.delete(rid), 10 * 60 * 1000);

            const kb = Markup.inlineKeyboard([
                [Markup.button.callback("Privado", `pv_${rid}`), Markup.button.callback("Resumo", `sm_${rid}`)],
                [Markup.button.callback("Download Grupo", `gp_${rid}`)]
            ]);

            const menu = await ctx.replyWithHTML(`✅ <b>Sucesso!</b>\n${getMention(ctx.from)}, escolha o destino:`, kb);
            Database.addSearchHistory(ctx.from.id, { cmd, query });
            Database.registerUsage(ctx.from.id);
            delMsg(ctx, menu.message_id);
        } catch (e) {
            try { Database.addLog(`busca ${cmd} erro: ${e.message}`); } catch (_) {}
            let userMsg;
            if (e.message === 'ETIMEOUT') userMsg = 'Tempo de busca esgotado. Tente novamente mais tarde.';
            else if (e.message && e.message.startsWith('HTTP')) userMsg = 'Serviço remoto indisponível.';
            else userMsg = 'Erro durante a busca.';
            ctx.reply(`❌ Erro: ${userMsg}`);
        }
        finally { ctx.telegram.deleteMessage(ctx.chat.id, proc.message_id).catch(()=>{}); }
    });
});

bot.action(/^(pv|sm|gp)_(.+)/, async (ctx) => {
    const [_, mode, rid] = ctx.match;
    const data = resultsCache.get(rid);
    if (!data) return ctx.answerCbQuery("❌ Expirado.");
    if (ctx.from.id !== parseInt(rid.split('_')[0])) return ctx.answerCbQuery("🚫 Não é sua busca.", {show_alert:true});

    const buff = Buffer.from(genHtml(data.cmd, data.query, data.raw));
    const fname = `AXION_${data.cmd.toUpperCase()}.html`;

    try {
        if (mode === 'pv') {
            await ctx.telegram.sendDocument(ctx.from.id, { source: buff, filename: fname }, { caption: `✅ Resultado: ${data.cmd.toUpperCase()}`, parse_mode: 'HTML' });
            ctx.answerCbQuery("Enviado no privado!");
        } else if (mode === 'sm') {
            const sm = data.raw.split('\n').slice(0, 10).join('\n');
            const m = await ctx.replyWithHTML(`📝 <b>RESUMO:</b>\n<pre>${sm}</pre>\n\n<i>Apagando em 5 min...</i>`);
            delMsg(ctx, m.message_id);
        } else {
            const m = await ctx.replyWithDocument({ source: buff, filename: fname }, { caption: `📁 Download por ${data.mention}\n<i>Apagando em 5 min...</i>`, parse_mode: 'HTML' });
            delMsg(ctx, m.message_id);
        }
        ctx.deleteMessage().catch(()=>{});
    } catch (e) { ctx.answerCbQuery("⚠️ Erro! Verifique seu privado."); }
});

// --- CONSULTA CEP ---
bot.command('cep', async (ctx) => {
    const cep = ctx.message.text.split(' ')[1]?.replace(/\D/g, '');
    if (!cep) return ctx.reply("Use: /cep 01001000");
    const cacheKey = `cep:${cep}`;
    const cached = getCache(cacheKey);
    if (cached) return ctx.replyWithHTML(cached);
    try {
        const res = await fetchWithRetry(`https://viacep.com.br/ws/${cep}/json/`);
        const d = await res.json();
        if (d.erro) return ctx.reply("❌ CEP inexistente.");
        const msg =
            `📍 <b>ENDEREÇO ENCONTRADO:</b>\n\n` +
            `<b>Rua:</b> ${d.logradouro}\n<b>Bairro:</b> ${d.bairro}\n` +
            `<b>Cidade:</b> ${d.localidade}/${d.uf}\n<b>DDD:</b> ${d.ddd}`;
        setCache(cacheKey, msg, 86400000);
        ctx.replyWithHTML(msg);
    } catch (e) { 
        Database.addLog(`cep erro: ${e.message}`);
        const userMsg = e.message === 'ETIMEOUT' ? 'Tempo de consulta esgotado.' : 'Erro na base ViaCEP.';
        ctx.reply(`❌ ${userMsg}`); 
    }
});


// --- WIKIPEDIA ---
bot.command('wiki', async (ctx) => {
    const query = ctx.message.text.split(' ').slice(1).join(' ');
    if (!query) return ctx.reply("Use: /wiki Bitcoin");
    const cacheKey = `wiki:${query.toLowerCase()}`;
    const cached = getCache(cacheKey);
    if (cached) return ctx.replyWithHTML(cached);
    try {
        const res = await fetchWithRetry(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
        const d = await res.json();
        const msg = `📘 <b>WIKI: ${d.title}</b>\n\n${d.extract}\n\n<a href="${d.content_urls.desktop.page}">Ler mais...</a>`;
        setCache(cacheKey, msg, 3600000);
        ctx.replyWithHTML(msg);
    } catch (e) { 
        Database.addLog(`wiki erro: ${e.message}`);
        const userMsg = e.message === 'ETIMEOUT' ? 'Tempo de consulta esgotado.' : 'Assunto não encontrado.';
        ctx.reply(`❌ ${userMsg}`); 
    }
});



bot.command('historico', (ctx) => {
    const items = Database.getSearchHistory(ctx.from.id);
    if (!items.length) return ctx.replyWithHTML("\u{1F4DD} Sem hist\u00f3rico.");
    const lines = items.slice(-5).map(i => `- ${i.cmd.toUpperCase()}: ${i.query}`);
    ctx.replyWithHTML(`\u{1F4DD} <b>\u00daLTIMAS BUSCAS</b>\n\n${lines.join("\n")}`);
});

bot.command('limite', (ctx) => {
    const stats = Database.getUsageStats(ctx.from.id);
    const limit = stats.isVip ? 50 : 10;
    ctx.replyWithHTML(
        `\u{1F4CA} <b>SEU LIMITE</b>\n\n` +
        `Usado hoje: <b>${stats.dailyCount}</b>\n` +
        `Limite di\u00e1rio: <b>${limit}</b>`
    );
});

bot.command('meu_acesso', (ctx) => {
    const stats = Database.getUsageStats(ctx.from.id);
    ctx.replyWithHTML(
        `\u{1F512} <b>SEU ACESSO</b>\n\n` +
        `VIP: <b>${stats.isVip ? 'ATIVADO ?' : 'N\u00c3O ?'}</b>\n` +
        `Total de buscas: <b>${stats.totalSearches}</b>`
    );
});

bot.command('ajuda_busca', (ctx) => {
    ctx.replyWithHTML(
        `\u{1F50D} <b>AJUDA DE BUSCA</b>\n\n` +
        `Exemplos:\n` +
        `/cpf 00000000000\n` +
        `/nome Maria Silva\n` +
        `/telefone 11999999999\n` +
        `/placa ABC1D23`
    );
});



bot.command('report', async (ctx) => {
    const rid = ctx.message.text.split(' ')[1];
    if (!rid) return ctx.reply('Use: /report ID');
    const data = resultsCache.get(rid);
    if (!data) return ctx.reply('? Relat?rio n?o encontrado.');
    if (ctx.from.id !== parseInt(rid.split('_')[0])) return ctx.reply('? Acesso negado.');
    const buff = Buffer.from(genHtml(data.cmd, data.query, data.raw));
    const fname = `AXION_${data.cmd.toUpperCase()}.html`;
    await ctx.replyWithDocument({ source: buff, filename: fname }, { caption: `? Relat?rio: ${data.cmd.toUpperCase()}`, parse_mode: 'HTML' });
});

bot.command('stats_busca', (ctx) => {
    const stats = Database.getUsageStats(ctx.from.id);
    const limit = stats.isVip ? 50 : 10;
    ctx.replyWithHTML(
        `?? <b>STATUS DE BUSCAS</b>\n\n` +
        `Usado hoje: <b>${stats.dailyCount}</b>\n` +
        `Limite di?rio: <b>${limit}</b>\n` +
        `Total de buscas: <b>${stats.totalSearches}</b>`
    );
});

bot.command('expirar_cache', (ctx) => {
    if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return ctx.reply("? Acesso negado.");
    cache.clear();
    resultsCache.clear();
    ctx.replyWithHTML("?? Cache expirado com sucesso.");
});
bot.command('limpar_cache', (ctx) => {
    if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return ctx.reply("? Acesso negado.");
    cache.clear();
    resultsCache.clear();
    ctx.replyWithHTML("?? Cache limpo com sucesso.");
});

bot.command('ping_api', async (ctx) => {
    if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return ctx.reply("? Acesso negado.");
    const tests = [
        { name: "cog", url: "https://cog.api.br/api/v1/status" },
        { name: "viacep", url: "https://viacep.com.br/ws/01001000/json/" },
        { name: "wikipedia", url: "https://pt.wikipedia.org/api/rest_v1/page/summary/Brasil" }
    ];
    const results = [];
    for (const t of tests) {
        const start = Date.now();
        try {
            await fetchWithRetry(t.url);
            results.push(`? ${t.name}: ${Date.now() - start}ms`);
        } catch (e) {
            results.push(`? ${t.name}: falha`);
        }
    }
    ctx.replyWithHTML(`?? <b>PING APIs</b>\n\n${results.join("\n")}`);
});

bot.launch().then(() => console.log("🕵️ SEARCH ONLINE"));









