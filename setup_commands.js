import 'dotenv/config';
import fetch from 'node-fetch';

const commands = {
    control: [
        { command: 'start', description: 'Menu Principal' },
        { command: 'daily', description: 'Resgatar bônus diário' },
        { command: 'perfil', description: 'Ver meu perfil' },
        { command: 'top', description: 'Ranking de usuários' },
        { command: 'vip_info', description: 'Ver VIPs online' },
        { command: 'limite', description: 'Ver limites de uso' },
        { command: 'ping', description: 'Verificar status' },
        { command: 'id', description: 'Obter meu ID' },
        { command: 'help', description: 'Ajuda e comandos' }
    ],
    store: [
        { command: 'start', description: 'Abrir Loja' },
        { command: 'carteira', description: 'Ver saldo e VIP' },
        { command: 'meus_pedidos', description: 'Meus pedidos' },
        { command: 'cassino', description: 'Jogar e apostar' },
        { command: 'transferir', description: 'Transferir saldo' },
        { command: 'promocoes', description: 'Ver cupons' },
        { command: 'afiliado', description: 'Link de convite' },
        { command: 'top_compradores', description: 'Ranking de compras' },
        { command: 'suporte', description: 'Falar com suporte' },
        { command: 'faq', description: 'Dúvidas frequentes' },
        { command: 'help', description: 'Ajuda' }
    ],
    search: [
        { command: 'start', description: 'Menu de Buscas' },
        { command: 'cpf', description: 'Consultar CPF' },
        { command: 'cnpj', description: 'Consultar CNPJ' },
        { command: 'nome', description: 'Consultar Nome' },
        { command: 'telefone', description: 'Consultar Telefone' },
        { command: 'placa', description: 'Consultar Placa' },
        { command: 'pix', description: 'Consultar PIX' },
        { command: 'email', description: 'Consultar Email' },
        { command: 'ip', description: 'GeoIP' },
        { command: 'bin', description: 'Consultar BIN' },
        { command: 'ddd', description: 'Consultar DDD' },
        { command: 'cotacao', description: 'Cotação Moedas' },
        { command: 'score', description: 'Score Simulado' },
        { command: 'gerar', description: 'Gerar Pessoa' },
        { command: 'gerar_cc', description: 'Gerar CC' },
        { command: 'historico', description: 'Minhas buscas' },
        { command: 'limite', description: 'Meus limites' },
        { command: 'help', description: 'Ajuda' }
    ]
};

const register = async (name, token, cmds) => {
    if (!token) {
        console.log(`[${name}] Token não encontrado no .env. Pulando...`);
        return;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commands: cmds })
        });
        const data = await res.json();
        if (data.ok) console.log(`[${name}] ✅ Comandos registrados com sucesso!`);
        else console.error(`[${name}] ❌ Erro:`, data.description);
    } catch (e) {
        console.error(`[${name}] ❌ Erro de conexão:`, e.message);
    }
};

(async () => {
    console.log("🔄 Registrando comandos no Telegram...");
    await register('CONTROL', process.env.TOKEN_CONTROL, commands.control);
    await register('STORE', process.env.TOKEN_STORE, commands.store);
    await register('SEARCH', process.env.TOKEN_SEARCH, commands.search);
})();