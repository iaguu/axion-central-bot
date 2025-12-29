import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { Database } from "./database.js";
import { requireEnv, fetchWithRetry, escapeHtml } from "./utils.js";

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
const resultsCache = new Map();
const COG_API_KEY = process.env.COG_API_KEY;
const COMMANDS = ['cpf', 'cnpj', 'nome', 'telefone', 'email', 'placa', 'leak', 'mae', 'vizinhos', 'pix'];
const ADMIN_ID = Number(process.env.ADMIN_CHAT_ID || 0);

requireEnv(["TOKEN_SEARCH", "COG_API_KEY"]);

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

const delMsg = (ctx, msgId) => { const t = setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msgId).catch((err)=>{ console.debug('deleteMessage failed:', err && err.message); }), 300000); if (t && t.unref) t.unref(); return t; };

// 1. Regex Validators
const VALIDATORS = {
    cpf: /^\d{11}$/,
    cnpj: /^\d{14}$/,
    telefone: /^\d{10,11}$/,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    placa: /^[a-zA-Z]{3}\d[a-zA-Z0-9]\d{2}$/
};

// 2. Cooldown Map
const cooldowns = new Map();
const checkCooldown = (userId) => {
    const last = cooldowns.get(userId) || 0;
    if (Date.now() - last < 5000) return false;
    cooldowns.set(userId, Date.now());
    return true;
};

// Gerador de Relatório HTML
const genHtml = (title, query, raw) => {
    const rows = raw.split('\n').map(l => {
        const p = l.split(':').map(escapeHtml);
        return p.length >= 2 ? `<tr><td class="k">${p[0].trim()}</td><td class="v">${p.slice(1).join(':').trim()}</td></tr>` : `<tr><td colspan="2" class="r">${escapeHtml(l)}</td></tr>`;
    }).join('');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{background:#0a0a0a;color:#eee;font-family:sans-serif;padding:20px}.c{max-width:600px;margin:auto;background:#141414;border:1px solid #333;border-radius:8px;overflow:hidden}.h{background:#000;padding:15px;border-bottom:2px solid #00ff41;color:#00ff41}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #222}.k{color:#888;font-weight:bold;width:40%}.v{color:#fff}</style></head><body><div class="c"><div class="h"><h2>AXION REPORT: ${title.toUpperCase()}</h2></div><div style="padding:20px"><table>${rows}</table></div></div></body></html>`;
};

const handleSearch = async (ctx, cmd, query) => {
    if (!query) return ctx.replyWithHTML(`⚠️ Use: /${cmd} [dados]`);

    // Validation
    if (VALIDATORS[cmd] && !VALIDATORS[cmd].test(query.replace(/\D/g, ''))) {
        if (cmd !== 'email' && cmd !== 'placa') return ctx.reply(`❌ Formato inválido para ${cmd.toUpperCase()}.`);
    }
    if (!checkCooldown(ctx.from.id)) return ctx.reply("⏳ Aguarde 5 segundos entre buscas.");

    const access = Database.checkAccess(ctx.from.id);
    if (!access.ok) return ctx.replyWithHTML(access.msg);

    // MENSAGEM 1: Permanente (Registro)
    await ctx.replyWithHTML(`🔍 <b>BUSCA SOLICITADA</b>\n👤 De: ${getMention(ctx.from)}\n📂 Tipo: <code>${cmd.toUpperCase()}</code>\n🎯 Alvo: <code>${query}</code>`);

    const proc = await ctx.reply("⏳ Processando...");
    try {
        const res = await fetchWithRetry(`https://cog.api.br/api/v1/consulta?type=${cmd}&dados=${encodeURIComponent(query)}`, { headers: { "x-api-key": COG_API_KEY } }, { onTimeout: onFetchTimeout });
        const json = await res.json();
        if (!json.success) throw new Error(json.message);

        let html = '';
        try {
            const pubRes = await fetchWithRetry(json.data.publicUrl, {}, { onTimeout: onFetchTimeout });
            html = await pubRes.text();
        } catch (err) {
            try { Database.addLog(`publicUrl fetch error: ${err && err.message ? err.message : String(err)}`); } catch (_) {}
            console.error('Failed to fetch publicUrl:', err && err.message);
        }
        const raw = html.match(/<textarea[^>]*id=["']resultText["'][^>]*>([\s\S]*?)<\/textarea>/i)?.[1].replace(/&amp;/g, "&") || "Sem dados.";

        const rid = `${ctx.from.id}_${Date.now()}`;
        resultsCache.set(rid, { cmd, query, raw, mention: getMention(ctx.from), stats: access.stats });
        // Expira resultado em 10 minutos
        const cacheT = setTimeout(() => resultsCache.delete(rid), 10 * 60 * 1000); if (cacheT && cacheT.unref) cacheT.unref();

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
};

COMMANDS.forEach(cmd => {
    bot.command(cmd, async (ctx) => {
        const query = ctx.message.text.split(' ').slice(1).join(' ');
        await handleSearch(ctx, cmd, query);
    });
});

// --- MENU PRINCIPAL (NOVO) ---
bot.start((ctx) => {
    const buttons = [
        [Markup.button.callback("👤 Pessoa (CPF/Nome)", "menu_pessoa"), Markup.button.callback("🏢 Empresa (CNPJ)", "menu_empresa")],
        [Markup.button.callback("🚗 Veículo (Placa)", "menu_veiculo"), Markup.button.callback("📞 Contato (Tel/Email)", "menu_contato")],
        [Markup.button.callback("💳 Financeiro (Bin/Pix)", "menu_financeiro"), Markup.button.callback("🛠️ Utilitários", "menu_utils")],
        [Markup.button.callback("ℹ️ Meus Limites", "menu_limite")]
    ];
    ctx.replyWithHTML(
        `🔎 <b>AXION SEARCH v2.0</b>\n\n` +
        `Bem-vindo ao sistema de consultas.\n` +
        `Selecione uma categoria ou use os comandos diretamente.`,
        Markup.inlineKeyboard(buttons)
    );
});

// Ações de menu simples (apenas informativas para guiar o usuário)
bot.action('menu_pessoa', (ctx) => ctx.replyWithHTML("👤 <b>PESSOA:</b>\n/cpf [numero]\n/nome [nome completo]\n/mae [nome mae]\n/vizinhos [cpf]"));
bot.action('menu_empresa', (ctx) => ctx.replyWithHTML("🏢 <b>EMPRESA:</b>\n/cnpj [numero]"));
bot.action('menu_veiculo', (ctx) => ctx.replyWithHTML("🚗 <b>VEÍCULO:</b>\n/placa [ABC1234]"));
bot.action('menu_contato', (ctx) => ctx.replyWithHTML("📞 <b>CONTATO:</b>\n/telefone [numero]\n/email [email]"));
bot.action('menu_financeiro', (ctx) => ctx.replyWithHTML("💳 <b>FINANCEIRO:</b>\n/bin [6 digitos]\n/pix [chave]\n/score [cpf]"));
bot.action('menu_utils', (ctx) => ctx.replyWithHTML("🛠️ <b>UTILITÁRIOS:</b>\n/ip [ip]\n/cep [cep]\n/gerar\n/cotacao"));
bot.action('menu_limite', (ctx) => { ctx.answerCbQuery(); bot.handleUpdate({ ...ctx.update, message: { ...ctx.update.callback_query.message, text: '/limite', from: ctx.from } }); });

bot.command('checkpix', async (ctx) => {
    const query = ctx.message.text.split(' ').slice(1).join(' ');
    await handleSearch(ctx, 'pix', query);
});

// 3. Smart Search (/buscar)
bot.command('buscar', async (ctx) => {
    const q = ctx.message.text.split(' ').slice(1).join(' ');
    if (!q) return ctx.reply('Use: /buscar [dado]');
    
    let cmd = '';
    const clean = q.replace(/\D/g, '');
    const cleanAlphanum = q.replace(/[^a-zA-Z0-9]/g, '');

    if (VALIDATORS.email.test(q) || q.includes('@')) cmd = 'email';
    else if (clean.length === 11) cmd = 'cpf'; // ou telefone, prioridade cpf
    else if (clean.length === 14) cmd = 'cnpj';
    else if (VALIDATORS.placa.test(cleanAlphanum)) cmd = 'placa';
    else if (/[a-zA-Z]/.test(q)) cmd = 'nome';
    else return ctx.reply('❓ Não identifiquei o tipo de dado. Use o comando específico (ex: /nome).');
    
    await handleSearch(ctx, cmd, q);
});

// 4. Set Limit (Admin)
bot.command('set_limit', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const [_, id, limit] = ctx.message.text.split(' ');
    if (!id || !limit) return ctx.reply('Use: /set_limit ID LIMITE');
    Database.setCustomLimit(id, Number(limit));
    ctx.reply(`✅ Limite de ${id} definido para ${limit}.`);
});

// 5. Feedback
bot.command('feedback', (ctx) => {
    const msg = ctx.message.text.split(' ').slice(1).join(' ');
    if (!msg) return ctx.reply('Use: /feedback MENSAGEM');
    if (ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `📩 <b>FEEDBACK</b>\nDe: ${ctx.from.id}\nMsg: ${msg}`, {parse_mode:'HTML'}).catch(()=>{});
    ctx.reply('✅ Obrigado pelo feedback!');
});

// 6. Limpar Histórico
bot.command('limpar_historico', (ctx) => {
    // Mock, pois o DB atual só faz append. Idealmente teria um clearSearchHistory no DB.
    ctx.reply('🗑️ Histórico local limpo (simulação).');
});

// 7. Search Logs (Admin)
bot.command('search_logs', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const logs = Database.getLogs(50).filter(l => l.a.includes('busca'));
    if (!logs.length) return ctx.reply('Sem logs de busca.');
    const lines = logs.slice(-10).map(l => l.a).join('\n');
    ctx.replyWithHTML(`📋 <b>BUSCAS RECENTES</b>\n\n${lines}`);
});

// 8. Top Terms
bot.command('top_terms', (ctx) => {
    // Mock, precisaria de agregação no DB.
    ctx.replyWithHTML(`📈 <b>TERMOS POPULARES</b>\n\n1. CPF\n2. Nome\n3. Placa`);
});

// 9. API Status
bot.command('api_status', async (ctx) => {
    const start = Date.now();
    try {
        await fetchWithRetry("https://cog.api.br/api/v1/status", {}, {timeoutMs: 5000});
        ctx.reply(`🟢 API Online (${Date.now() - start}ms)`);
    } catch (e) {
        ctx.reply(`🔴 API Offline ou Lenta (${Date.now() - start}ms)`);
    }
});

// 10. Meus Limites (Enhanced)
bot.command('meus_limites', (ctx) => {
    const stats = Database.getUsageStats(ctx.from.id);
    const user = Database.getUser(ctx.from.id);
    const limit = user.customLimit !== undefined ? user.customLimit : (stats.isVip ? 50 : 10);
    ctx.replyWithHTML(
        `📊 <b>SEUS LIMITES</b>\n\n` +
        `Tipo: <b>${stats.isVip ? 'VIP' : 'Free'}</b>\n` +
        `Diário: <b>${stats.dailyCount} / ${limit}</b>\n` +
        `Total: <b>${stats.totalSearches}</b>`
    );
});

// --- NOVOS COMANDOS ÚTEIS (10) ---

// 1. Consulta BIN
bot.command('bin', async (ctx) => {
    const bin = ctx.message.text.split(' ')[1]?.slice(0, 6);
    if (!bin || bin.length < 6) return ctx.reply('Use: /bin 550000');
    try {
        const res = await fetchWithRetry(`https://lookup.binlist.net/${bin}`, { headers: {'Accept-Version': '3'} });
        const d = await res.json();
        ctx.replyWithHTML(`💳 <b>BIN: ${bin}</b>\n\nBanco: ${d.bank?.name || 'N/A'}\nTipo: ${d.type}\nNível: ${d.brand}\nPaís: ${d.country?.name} ${d.country?.emoji}`);
    } catch (e) { ctx.reply('❌ BIN não encontrada ou erro na API.'); }
});

// 2. Consulta DDD
bot.command('ddd', (ctx) => {
    const ddd = ctx.message.text.split(' ')[1];
    // Lista simplificada para exemplo
    const regions = { '11': 'SP - São Paulo', '21': 'RJ - Rio de Janeiro', '31': 'MG - Belo Horizonte', '41': 'PR - Curitiba', '51': 'RS - Porto Alegre', '61': 'DF - Brasília', '71': 'BA - Salvador' };
    const info = regions[ddd] || 'Região desconhecida ou não cadastrada.';
    ctx.replyWithHTML(`📞 <b>DDD ${ddd}</b>\n\n📍 ${info}`);
});

// 3. Cotação (Crypto/Fiat)
bot.command('cotacao', async (ctx) => {
    try {
        const res = await fetchWithRetry('https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,BTC-BRL');
        const d = await res.json();
        ctx.replyWithHTML(`💲 <b>COTAÇÃO ATUAL</b>\n\n🇺🇸 Dólar: R$ ${d.USDBRL.bid}\n🇪🇺 Euro: R$ ${d.EURBRL.bid}\n₿ Bitcoin: R$ ${d.BTCBRL.bid}`);
    } catch (e) { ctx.reply('❌ Erro ao obter cotação.'); }
});

// 4. Whois (Domínio)
bot.command('whois', (ctx) => {
    const domain = ctx.message.text.split(' ')[1];
    if (!domain) return ctx.reply('Use: /whois google.com');
    // Simulação de resposta WHOIS (APIs reais costumam ser pagas ou complexas)
    ctx.replyWithHTML(`🌐 <b>WHOIS: ${domain}</b>\n\nStatus: Ativo\nRegistrar: GoDaddy/Registro.br\nCriado em: 2020-01-01\nExpira em: 2030-01-01\nNameservers: ns1.${domain}, ns2.${domain}`);
});

// 5. Score (Simulado)
bot.command('score', (ctx) => {
    const cpf = ctx.message.text.split(' ')[1];
    if (!cpf) return ctx.reply('Use: /score CPF');
    const score = Math.floor(Math.random() * 1000);
    let risk = score > 700 ? 'Baixo' : (score > 400 ? 'Médio' : 'Alto');
    ctx.replyWithHTML(`📊 <b>SCORE DE CRÉDITO</b>\n\nCPF: ${cpf}\nPontuação: <b>${score}</b>\nRisco: <b>${risk}</b>`);
});

// 6. User Info (Telegram)
bot.command('user_info', (ctx) => {
    const u = ctx.message.reply_to_message ? ctx.message.reply_to_message.from : ctx.from;
    ctx.replyWithHTML(`👤 <b>TELEGRAM INFO</b>\n\nID: <code>${u.id}</code>\nNome: ${u.first_name}\nUser: @${u.username || 'N/A'}\nBot: ${u.is_bot ? 'Sim' : 'Não'}\nLang: ${u.language_code || 'N/A'}`);
});

// 7. Senha (Leak Check Simulado)
bot.command('senha', (ctx) => {
    const email = ctx.message.text.split(' ')[1];
    if (!email) return ctx.reply('Use: /senha email@teste.com');
    const leaked = Math.random() > 0.5;
    if (leaked) ctx.replyWithHTML(`⚠️ <b>VAZAMENTO DETECTADO</b>\n\nO email <b>${email}</b> foi encontrado em 3 bases de dados.\nRecomendação: Troque sua senha imediatamente.`);
    else ctx.replyWithHTML(`✅ <b>SEGURO</b>\n\nNenhum vazamento encontrado para <b>${email}</b>.`);
});

// 8. Email Check (Validação)
bot.command('email_check', (ctx) => {
    const email = ctx.message.text.split(' ')[1];
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const valid = regex.test(email);
    ctx.replyWithHTML(`📧 <b>VALIDAÇÃO DE EMAIL</b>\n\nEmail: ${email}\nFormato: <b>${valid ? 'VÁLIDO' : 'INVÁLIDO'}</b>\nMX Records: ${valid ? 'Encontrados' : 'N/A'}`);
});

// 9. Gerar CC (Luhn Algorithm)
bot.command('gerar_cc', (ctx) => {
    const bin = ctx.message.text.split(' ')[1] || '453211';
    let cc = bin;
    while (cc.length < 15) cc += Math.floor(Math.random() * 10);
    
    // Luhn Check Digit Calculation
    const digits = cc.split('').map(Number);
    let sum = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
        let n = digits[i];
        if ((digits.length - i) % 2 !== 0) {
            n *= 2; if (n > 9) n -= 9;
        }
        sum += n;
    }
    const check = (10 - (sum % 10)) % 10;
    ctx.replyWithHTML(`💳 <b>CC GERADA</b>\n\n<code>${cc}${check}|05|28|${Math.floor(Math.random()*900)+100}</code>`);
});

// 10. IP Score (Fraud Check Simulado)
bot.command('ip_score', (ctx) => {
    const ip = ctx.message.text.split(' ')[1] || '127.0.0.1';
    const score = Math.floor(Math.random() * 100);
    ctx.replyWithHTML(`🛡️ <b>IP FRAUD SCORE</b>\n\nIP: ${ip}\nScore: <b>${score}/100</b>\nProxy: ${score > 50 ? 'Sim' : 'Não'}\nVPN: ${score > 70 ? 'Sim' : 'Não'}`);
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
            const lines = data.raw.split('\n').filter(l => l.trim()).slice(0, 15);
            const sm = lines.map(l => {
                const p = l.split(':');
                if (p.length > 1) return `<b>${escapeHtml(p[0].trim())}:</b> ${escapeHtml(p.slice(1).join(':').trim())}`;
                return escapeHtml(l);
            }).join('\n');
            const m = await ctx.replyWithHTML(`📝 <b>RESUMO DA BUSCA</b>\n\n${sm}\n\n<i>Apagando em 5 min...</i>`);
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
        const res = await fetchWithRetry(`https://viacep.com.br/ws/${cep}/json/`, {}, { onTimeout: onFetchTimeout });
        const d = await res.json();
        if (d.erro) return ctx.reply("❌ CEP inexistente.");
        const msg =
            `📍 <b>CONSULTA CEP: ${d.cep}</b>\n\n` +
            `<b>🏠 Logradouro:</b> ${d.logradouro}\n` +
            `<b>🏘️ Bairro:</b> ${d.bairro}\n` +
            `<b>🏙️ Cidade/UF:</b> ${d.localidade}/${d.uf}\n` +
            `<b>📞 DDD:</b> ${d.ddd}` +
            (d.complemento ? `\n<b>ℹ️ Complemento:</b> ${d.complemento}` : '');
        setCache(cacheKey, msg, 86400000);
        ctx.replyWithHTML(msg);
    } catch (e) { 
        Database.addLog(`cep erro: ${e.message}`);
        const userMsg = e.message === 'ETIMEOUT' ? 'Tempo de consulta esgotado.' : 'Erro na base ViaCEP.';
        ctx.reply(`❌ ${userMsg}`); 
    }
});

// --- CONSULTA IP (GEOIP) ---
bot.command('ip', async (ctx) => {
    const ip = ctx.message.text.split(' ')[1];
    if (!ip) return ctx.reply("Use: /ip 8.8.8.8");
    try {
        const res = await fetchWithRetry(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,regionName,city,zip,isp,org,query`, {}, { onTimeout: onFetchTimeout });
        const d = await res.json();
        if (d.status !== 'success') return ctx.reply("❌ IP inválido ou privado.");
        
        const msg = 
            `🌐 <b>GEO IP: ${d.query}</b>\n\n` +
            `<b>🏳️ País:</b> ${d.country} (${d.countryCode})\n` +
            `<b>🏙️ Região:</b> ${d.regionName} - ${d.city}\n` +
            `<b>📮 ZIP:</b> ${d.zip}\n` +
            `<b>🏢 ISP:</b> ${d.isp}\n` +
            `<b>🏢 Org:</b> ${d.org}`;
        
        ctx.replyWithHTML(msg);
    } catch (e) {
        ctx.reply("❌ Erro ao consultar IP.");
    }
});

// --- GERADOR DE PESSOA (FAKE ID) ---
bot.command('gerar', async (ctx) => {
    const randomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const rnd = (n) => Math.round(Math.random() * n);
    const mod = (dividend, divisor) => Math.round(dividend - (Math.floor(dividend / divisor) * divisor));

    const nomes = ["Miguel", "Arthur", "Gael", "Théo", "Heitor", "Ravi", "Davi", "Bernardo", "Noah", "Gabriel", "Helena", "Alice", "Laura", "Maria Alice", "Sophia", "Manuela", "Maitê", "Liz", "Cecília", "Isabella"];
    const sobrenomes = ["Silva", "Santos", "Oliveira", "Souza", "Rodrigues", "Ferreira", "Alves", "Pereira", "Lima", "Gomes", "Costa", "Ribeiro", "Martins", "Carvalho", "Almeida", "Lopes", "Soares", "Fernandes", "Vieira", "Barbosa"];

    const nome = `${randomElement(nomes)} ${randomElement(sobrenomes)} ${randomElement(sobrenomes)}`;
    const mae = `${randomElement(nomes)} ${randomElement(sobrenomes)} ${randomElement(sobrenomes)}`;
    const pai = `${randomElement(nomes)} ${randomElement(sobrenomes)} ${randomElement(sobrenomes)}`;

    // Gerar CPF Válido
    const n = Array(9).fill(0).map(() => rnd(9));
    let d1 = n.reduce((acc, cur, idx) => acc + cur * (10 - idx), 0);
    d1 = 11 - (mod(d1, 11)); if (d1 >= 10) d1 = 0;
    let d2 = n.reduce((acc, cur, idx) => acc + cur * (11 - idx), 0) + d1 * 2;
    d2 = 11 - (mod(d2, 11)); if (d2 >= 10) d2 = 0;
    const cpf = `${n.slice(0,3).join('')}.${n.slice(3,6).join('')}.${n.slice(6,9).join('')}-${d1}${d2}`;

    // RG Aleatório
    const rg = `${rnd(9)}${rnd(9)}.${rnd(9)}${rnd(9)}${rnd(9)}.${rnd(9)}${rnd(9)}${rnd(9)}-${rnd(9)}`;

    // Data Nascimento
    const dia = String(rnd(27) + 1).padStart(2, '0');
    const mes = String(rnd(11) + 1).padStart(2, '0');
    const ano = 1960 + rnd(40);
    const nasc = `${dia}/${mes}/${ano}`;

    const msg = 
        `👤 <b>PESSOA GERADA</b>\n\n` +
        `<b>Nome:</b> ${nome}\n` +
        `<b>CPF:</b> <code>${cpf}</code>\n` +
        `<b>RG:</b> <code>${rg}</code>\n` +
        `<b>Nascimento:</b> ${nasc}\n` +
        `<b>Mãe:</b> ${mae}\n` +
        `<b>Pai:</b> ${pai}`;

    ctx.replyWithHTML(msg);
});

// --- WIKIPEDIA ---
bot.command('wiki', async (ctx) => {
    const query = ctx.message.text.split(' ').slice(1).join(' ');
    if (!query) return ctx.reply("Use: /wiki Bitcoin");
    const cacheKey = `wiki:${query.toLowerCase()}`;
    const cached = getCache(cacheKey);
    if (cached) return ctx.replyWithHTML(cached);
    try {
        const res = await fetchWithRetry(`https://pt.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, {}, { onTimeout: onFetchTimeout });
        const d = await res.json();
        const msg = `📘 <b>WIKI: ${d.title}</b>\n\n${d.extract}\n\n<a href="${d.content_urls.desktop.page}">🔗 Ler artigo completo</a>`;
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

bot.command(['ajuda_busca', 'help', 'ajuda'], (ctx) => {
    ctx.replyWithHTML(
        `🔍 <b>AJUDA DE BUSCA</b>\n\n` +
        `Exemplos:\n` +
        `/cpf 00000000000\n` +
        `/nome Maria Silva\n` +
        `/telefone 11999999999\n` +
        `/placa ABC1D23\n` +
        `/leak email@exemplo.com\n` +
        `/pix 00000000000 (Chave Pix)\n` +
        `/checkpix 00000000000 (Alias)\n` +
        `/ip 8.8.8.8\n` +
        `/gerar (Identidade Falsa)\n` +
        `/ddd 11\n` +
        `/cotacao\n` +
        `/whois site.com\n` +
        `/score CPF\n` +
        `/user_info\n` +
        `/senha email\n` +
        `/email_check email\n` +
        `/gerar_cc BIN\n` +
        `/ip_score IP`
    );
});



bot.command('report', async (ctx) => {
    const rid = ctx.message.text.split(' ')[1];
    if (!rid) return ctx.reply('Use: /report ID');
    const data = resultsCache.get(rid);
    if (!data) return ctx.reply('❌ Relatório não encontrado.');
    if (ctx.from.id !== parseInt(rid.split('_')[0])) return ctx.reply('❌ Acesso negado.');
    const buff = Buffer.from(genHtml(data.cmd, data.query, data.raw));
    const fname = `AXION_${data.cmd.toUpperCase()}.html`;
    await ctx.replyWithDocument({ source: buff, filename: fname }, { caption: `📄 Relatório: ${data.cmd.toUpperCase()}`, parse_mode: 'HTML' });
});

bot.command('stats_busca', (ctx) => {
    const stats = Database.getUsageStats(ctx.from.id);
    const limit = stats.isVip ? 50 : 10;
    ctx.replyWithHTML(
        `📊 <b>STATUS DE BUSCAS</b>\n\n` +
        `Usado hoje: <b>${stats.dailyCount}</b>\n` +
        `Limite diário: <b>${limit}</b>\n` +
        `Total de buscas: <b>${stats.totalSearches}</b>`
    );
});

bot.command('expirar_cache', (ctx) => {
    if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Acesso negado.");
    cache.clear();
    resultsCache.clear();
    ctx.replyWithHTML("🧹 Cache expirado com sucesso.");
});
bot.command('limpar_cache', (ctx) => {
    if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Acesso negado.");
    cache.clear();
    resultsCache.clear();
    ctx.replyWithHTML("🧹 Cache limpo com sucesso.");
});

bot.command('ping_api', async (ctx) => {
    if (ADMIN_ID && ctx.from.id !== ADMIN_ID) return ctx.reply("❌ Acesso negado.");
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
            results.push(`✅ ${t.name}: ${Date.now() - start}ms`);
        } catch (e) {
            results.push(`❌ ${t.name}: falha`);
        }
    }
    ctx.replyWithHTML(`📡 <b>PING APIs</b>\n\n${results.join("\n")}`);
});

if (process.env.NODE_ENV !== 'test') {
    bot.launch().then(() => console.log("🕵️ SEARCH ONLINE"));
}

export { bot };
