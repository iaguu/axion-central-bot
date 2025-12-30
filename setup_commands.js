const BOT_TOKEN_SEARCH = process.env.TOKEN_SEARCH;
if (!BOT_TOKEN_SEARCH) throw new Error('TOKEN_SEARCH não definido no .env');

// Lista de comandos do SEARCH_BOT
const searchCommands = [
  { command: 'start', description: 'Menu principal' },
  { command: 'buscar', description: 'Busca inteligente de dados (CPF, CNPJ, etc)' },
  { command: 'cpf', description: 'Buscar por CPF' },
  { command: 'cnpj', description: 'Buscar por CNPJ' },
  { command: 'telefone', description: 'Buscar por telefone' },
  { command: 'email', description: 'Buscar por e-mail' },
  { command: 'placa', description: 'Buscar por placa' },
  { command: 'nome', description: 'Buscar por nome' },
  { command: 'historico', description: 'Ver histórico de buscas' },
  { command: 'limite', description: 'Ver seu limite de uso diário' },
  { command: 'ajuda_busca', description: 'Ajuda sobre buscas' }
];
import 'dotenv/config';
import fetch from 'node-fetch';

const BOT_TOKEN = process.env.TOKEN_STORE;
if (!BOT_TOKEN) throw new Error('TOKEN_STORE não definido no .env');

// Lista de comandos do bot store
const commands = [
  { command: 'start', description: 'Menu principal' },
  { command: 'buscar', description: 'Busca inteligente de dados (CPF, CNPJ, etc)' },
  { command: 'meus_pedidos', description: 'Ver seus pedidos' },
  { command: 'status_loja', description: 'Status da loja (admin)' },
  { command: 'promocoes', description: 'Ver promoções' },
  { command: 'produto', description: 'Ver detalhes de um produto' },
  { command: 'comprar', description: 'Comprar um produto' },
  { command: 'catalogo', description: 'Ver catálogo de produtos' },
  { command: 'pedido', description: 'Ver detalhes de um pedido' },
  { command: 'suporte', description: 'Falar com o suporte' },
  { command: 'cupom', description: 'Aplicar cupom de desconto' },
  { command: 'cassino', description: 'Jogar cassino Axion' },
  { command: 'version', description: 'Ver versão do bot' },
  // Admin
  { command: 'confirmar_pagamento', description: 'Confirmar pagamento manualmente (admin)' },
  { command: 'addproduto', description: 'Adicionar novo produto (admin)' },
  { command: 'addestoque', description: 'Adicionar estoque a produto (admin)' },
  { command: 'pedidos', description: 'Listar pedidos recentes (admin)' },
  { command: 'entregar', description: 'Entregar produto manualmente (admin)' },
  { command: 'cancelar_pedido', description: 'Cancelar pedido (admin)' },
  // Úteis
  { command: 'limite', description: 'Ver seu limite de uso diário' },
  { command: 'historico', description: 'Ver histórico de buscas' },
  { command: 'ajuda_busca', description: 'Ajuda sobre buscas' }
];

async function setupCommands() {
  // STORE_BOT
  const urlStore = `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`;
  const resStore = await fetch(urlStore, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands })
  });
  const dataStore = await resStore.json();
  if (dataStore.ok) {
    console.log('Comandos STORE_BOT registrados com sucesso no BotFather!');
  } else {
    console.error('Erro ao registrar comandos STORE_BOT:', dataStore);
  }

  // SEARCH_BOT
  const urlSearch = `https://api.telegram.org/bot${BOT_TOKEN_SEARCH}/setMyCommands`;
  const resSearch = await fetch(urlSearch, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: searchCommands })
  });
  const dataSearch = await resSearch.json();
  if (dataSearch.ok) {
    console.log('Comandos SEARCH_BOT registrados com sucesso no BotFather!');
  } else {
    console.error('Erro ao registrar comandos SEARCH_BOT:', dataSearch);
  }
}

setupCommands();
