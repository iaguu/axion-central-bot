import "dotenv/config";
import { spawn } from 'child_process';
import path from 'path';
import http from 'http';

const requiredEnv = [
    "TOKEN_CONTROL",
    "ADMIN_CHAT_ID",
    "TOKEN_SEARCH",
    "COG_API_KEY",
    "TOKEN_STORE",
    "FLUXO_TOKEN",
    "CALLBACK_URL"
];
const missing = requiredEnv.filter(k => !process.env[k]);
if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(1);
}

const HEALTH_PORT = Number(process.env.HEALTH_PORT || 3001);
http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    res.writeHead(404);
    res.end();
}).listen(HEALTH_PORT, () => {
    console.log(`Healthcheck on port ${HEALTH_PORT}`);
});

// Lista de arquivos que devem ser iniciados
const scripts = [
    'control_bot.js',
    'search_bot.js',
    'store_bot.js',
    'webhook.js'
];

function startScript(scriptName) {
    // Resolve o caminho para garantir que seja uma String absoluta
    const scriptPath = path.resolve(scriptName);

    console.log(`🚀 Iniciando módulo: ${scriptName}`);

    const process = spawn('node', [scriptPath], {
        stdio: 'inherit',
        shell: true // Adicionado para compatibilidade com Windows/Linux
    });

    process.on('close', (code) => {
        if (code !== 0) {
            console.error(`⚠️ O script ${scriptName} parou (Erro: ${code}). Reiniciando...`);
            setTimeout(() => startScript(scriptName), 5000);
        }
    });
}

// Inicia cada script da lista
scripts.forEach(script => startScript(script));
