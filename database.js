import fs from 'fs';
import path from 'path';

const DB_FILE = path.resolve('axion_core.json');
const LOCK_FILE = path.resolve('axion_core.lock');
const CC_FILE = path.resolve('cc_stock.json');

const sleepSync = (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait para compatibilidade com main thread */ }
};

const acquireLock = (retries = 50, delayMs = 20) => {
    for (let i = 0; i < retries; i += 1) {
        try {
            const fd = fs.openSync(LOCK_FILE, 'wx');
            fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }));
            return fd;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            try {
                const { mtimeMs } = fs.statSync(LOCK_FILE);
                if (Date.now() - mtimeMs > 10000) {
                    fs.unlinkSync(LOCK_FILE);
                    continue;
                }
            } catch (_) {}
            sleepSync(delayMs);
        }
    }
    try {
        const msg = `${new Date().toISOString()} - DB lock timeout after ${retries} retries`;
        fs.appendFileSync(path.resolve('db_errors.log'), msg + '\n', 'utf8');
    } catch (_) {}
    throw new Error('DB lock timeout');
};

const releaseLock = (fd) => {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
};

const withLock = (fn) => {
    const fd = acquireLock();
    try { return fn(); }
    finally { releaseLock(fd); }
};

const load = () => {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const initial = { system: { lockdown: false, totalPool: 0 }, users: {}, investments: [], store: [], orders: [], audit: [] };
            const tmp = `${DB_FILE}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(initial, null, 2), 'utf8');
            fs.renameSync(tmp, DB_FILE);
            return initial;
        }
        for (let i = 0; i < 3; i += 1) {
            try {
                return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            } catch (e) {
                if (i === 2) throw e;
                sleepSync(10);
            }
        }
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        try {
            const raw = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE, 'utf8') : null;
            if (raw) fs.writeFileSync(`${DB_FILE}.corrupted.${Date.now()}.bak`, raw, 'utf8');
            fs.appendFileSync(path.resolve('db_errors.log'), `${new Date().toISOString()} - DB load error: ${e.message}\n`, 'utf8');
        } catch (_) {}
        return { system: { lockdown: false, totalPool: 0 }, users: {}, investments: [], store: [], orders: [], audit: [] };
    }
};

const save = (data) => {
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, DB_FILE);
};

// --- GESTÃO DE ESTOQUE CC (ARQUIVO SEPARADO) ---
const manageCCs = (action, level) => {
    let data = {};
    try {
        if (fs.existsSync(CC_FILE)) {
            data = JSON.parse(fs.readFileSync(CC_FILE, 'utf8'));
        } else {
            // Cria arquivo com dados fictícios se não existir
            data = {
                gold: ["5500000000000001|01|28|001"],
                platinum: ["4400000000000001|01|29|002"],
                infinity: ["3300000000000001|01|30|003"]
            };
            fs.writeFileSync(CC_FILE, JSON.stringify(data, null, 2));
        }
    } catch (e) { console.error("Erro ao ler CC_FILE:", e); data = {}; }

    if (action === 'get') return data;
    if (action === 'pop') {
        if (data[level] && data[level].length > 0) {
            const val = data[level].shift();
            fs.writeFileSync(CC_FILE, JSON.stringify(data, null, 2));
            return val;
        }
        return null;
    }
};

export const Database = {
    // --- GESTÃO DE SISTEMA E POOL ---
    setLockdown: (status) => withLock(() => {
        const db = load();
        db.system.lockdown = status;
        save(db);
    }),
    getLockdown: () => load().system?.lockdown || false,
    updatePool: (val) => withLock(() => {
        const db = load();
        db.system.totalPool = val;
        save(db);
    }),
    getPool: () => load().system.totalPool || 0,

    // --- USUÁRIOS E ACESSO ---
    getUser: (userId) => withLock(() => {
        const db = load();
        if (!db.users[userId]) {
            db.users[userId] = { rep: 0, dailyCount: 0, lastReq: 0, lastReset: Date.now(), isVip: false, lastDaily: 0 };
            save(db);
        }
        return db.users[userId];
    }),
    getUsers: () => load().users || {},

    setVip: (userId, status) => withLock(() => {
        const db = load();
        if (!db.users[userId]) db.users[userId] = { rep: 0, dailyCount: 0, isVip: false };
        db.users[userId].isVip = status;
        save(db);
        return db.users[userId].isVip;
    }),

    checkAccess: (userId) => withLock(() => {
        const db = load();
        if (!db.users[userId]) {
            db.users[userId] = { rep: 0, dailyCount: 0, lastReq: 0, lastReset: Date.now(), isVip: false, lastDaily: 0 };
            save(db);
        }
        const user = db.users[userId];
        if (db.system?.lockdown) {
            return { ok: false, msg: "Sistema em lockdown.", stats: { isVip: user.isVip, dailyCount: user.dailyCount || 0 } };
        }
        const now = Date.now();
        const umDia = 86400000;
        if (!user.lastReset || now - user.lastReset > umDia) {
            user.dailyCount = 0;
            user.lastReset = now;
            save(db);
        }
        const limit = user.customLimit !== undefined ? user.customLimit : (user.isVip ? 50 : 10);
        if ((user.dailyCount || 0) >= limit) {
            return { ok: false, msg: "Limite diario atingido.", stats: { isVip: user.isVip, dailyCount: user.dailyCount || 0 } };
        }
        return { ok: true, msg: "OK", stats: { isVip: user.isVip, dailyCount: user.dailyCount || 0 } };
    }),

    registerUsage: (userId) => withLock(() => {
        const db = load();
        if (!db.users[userId]) db.users[userId] = { rep: 0, dailyCount: 0, isVip: false };
        db.users[userId].dailyCount = (db.users[userId].dailyCount || 0) + 1;
        db.users[userId].totalSearches = (db.users[userId].totalSearches || 0) + 1;
        db.users[userId].lastReq = Date.now();
        save(db);
        return db.users[userId];
    }),
    setCustomLimit: (userId, limit) => withLock(() => {
        const db = load();
        if (!db.users[userId]) db.users[userId] = { rep: 0, dailyCount: 0, isVip: false };
        db.users[userId].customLimit = limit;
        save(db);
    }),
    getUsageStats: (userId) => {
        const user = load().users?.[userId];
        if (!user) return { isVip: false, dailyCount: 0, totalSearches: 0 };
        return { isVip: !!user.isVip, dailyCount: user.dailyCount || 0, totalSearches: user.totalSearches || 0 };
    },
    addWarn: (userId, delta = 1) => withLock(() => {
        const db = load();
        if (!db.users[userId]) db.users[userId] = { rep: 0, dailyCount: 0, isVip: false };
        db.users[userId].warns = (db.users[userId].warns || 0) + delta;
        save(db);
        return db.users[userId].warns;
    }),
    getWarns: (userId) => load().users?.[userId]?.warns || 0,
    clearWarns: (userId) => withLock(() => {
        const db = load();
        if (!db.users[userId]) return 0;
        db.users[userId].warns = 0;
        save(db);
        return 0;
    }),
    addSearchHistory: (userId, entry) => withLock(() => {
        const db = load();
        if (!db.users[userId]) db.users[userId] = { rep: 0, dailyCount: 0, isVip: false };
        if (!db.users[userId].searchHistory) db.users[userId].searchHistory = [];
        db.users[userId].searchHistory.push({ ...entry, t: new Date().toISOString() });
        if (db.users[userId].searchHistory.length > 10) db.users[userId].searchHistory.shift();
        save(db);
        return db.users[userId].searchHistory;
    }),
    getSearchHistory: (userId) => {
        const user = load().users?.[userId];
        return user?.searchHistory || [];
    },
    setUserCoupon: (userId, coupon) => withLock(() => {
        const db = load();
        if (!db.users[userId]) db.users[userId] = { rep: 0, dailyCount: 0, isVip: false };
        db.users[userId].pendingCoupon = coupon;
        save(db);
    }),
    getUserCoupon: (userId) => load().users?.[userId]?.pendingCoupon || null,
    clearUserCoupon: (userId) => withLock(() => {
        const db = load();
        if (!db.users[userId]) return;
        db.users[userId].pendingCoupon = null;
        save(db);
    }),
    getVipUsers: () => {
        const db = load();
        return Object.entries(db.users || {})
            .filter(([, u]) => u.isVip)
            .map(([id]) => id);
    },

    // --- GAMIFICAÇÃO (DAILY E RANKING) ---
    claimDaily: (userId) => withLock(() => {
        const db = load();
        const user = db.users[userId];
        const now = Date.now();
        const umDia = 86400000;

        if (user.lastDaily && (now - user.lastDaily < umDia)) return { ok: false };

        user.rep = (user.rep || 0) + 1;
        user.lastDaily = now;
        save(db);
        return { ok: true, rep: user.rep };
    }),

    getTopRep: () => {
        const db = load();
        return Object.entries(db.users)
            .map(([id, data]) => ({ id, rep: data.rep || 0 }))
            .sort((a, b) => b.rep - a.rep);
    },

    addRep: (userId, amount) => withLock(() => {
        const db = load();
        if (!db.users[userId]) db.users[userId] = { rep: 0, isVip: false };
        db.users[userId].rep = (db.users[userId].rep || 0) + amount;
        save(db);
        return db.users[userId].rep;
    }),

    // --- INVESTIMENTOS ---
    registerInvestment: (data) => withLock(() => {
        const db = load();
        const invest = { id: Date.now(), ...data, timestamp: new Date().toLocaleString('pt-BR') };
        db.investments.push(invest);
        save(db);
        return invest;
    }),
    getInvestments: () => load().investments || [],

    // --- STORE E ESTOQUE ---
    addProduct: (productData) => withLock(() => {
        const db = load();
        if (!db.store) db.store = [];
        const product = { id: Date.now(), ...productData, stock: [] };
        db.store.push(product);
        save(db);
        return product;
    }),
    updateProduct: (id, data) => withLock(() => {
        const db = load();
        const p = (db.store || []).find(x => x.id == id);
        if (!p) return false;
        Object.assign(p, data);
        save(db);
        return true;
    }),
    deleteProduct: (id) => withLock(() => {
        const db = load();
        if (!db.store) return false;
        const idx = db.store.findIndex(x => x.id == id);
        if (idx === -1) return false;
        db.store.splice(idx, 1);
        save(db);
        return true;
    }),
    getProducts: () => load().store || [],
    getProductById: (productId) => (load().store || []).find(p => p.id == productId),
    addStock: (productId, items) => withLock(() => {
        const db = load();
        const product = (db.store || []).find(p => p.id == productId);
        if (!product) return null;
        if (!product.stock) product.stock = [];
        product.stock.push(...items);
        save(db);
        return product;
    }),
    
    popStock: (productId) => withLock(() => {
        // Intercepta produtos CC para usar o arquivo JSON específico
        if (productId.startsWith('cc_')) {
            const map = { 'cc_gold': 'gold', 'cc_platinum': 'platinum', 'cc_infinity': 'infinity' };
            const key = map[productId];
            if (key) {
                const item = manageCCs('pop', key);
                if (item) {
                    // Sincroniza contagem no DB principal para exibição
                    const db = load();
                    const prod = (db.store || []).find(p => p.id === productId);
                    if (prod && prod.stock && prod.stock.length > 0) { prod.stock.pop(); save(db); }
                    return item;
                }
                return null;
            }
        }

        const db = load();
        const product = (db.store || []).find(p => p.id == productId);
        if (product && product.stock && product.stock.length > 0) {
            const item = product.stock.shift();
            save(db);
            return item;
        }
        return null;
    }),

    // --- PEDIDOS ---
    addOrder: (orderData) => withLock(() => {
        const db = load();
        if (!db.orders) db.orders = [];
        const order = {
            id: orderData.id || Date.now(),
            status: orderData.status || 'created',
            createdAt: new Date().toISOString(),
            ...orderData
        };
        db.orders.push(order);
        save(db);
        return order;
    }),
    getOrder: (orderId) => (load().orders || []).find(o => o.id == orderId),
    getOrders: () => load().orders || [],
    getOrdersByUser: (userId) => (load().orders || []).filter(o => o.userId == userId),
    updateOrder: (orderId, patch) => withLock(() => {
        const db = load();
        if (!db.orders) db.orders = [];
        const order = db.orders.find(o => o.id == orderId);
        if (!order) return null;
        Object.assign(order, patch, { updatedAt: new Date().toISOString() });
        save(db);
        return order;
    }),

    // --- AUDITORIA ---
    addLog: (action) => withLock(() => {
        const db = load();
        if (!db.audit) db.audit = [];
        db.audit.push({ t: new Date().toLocaleString('pt-BR'), a: action });
        if (db.audit.length > 500) db.audit.shift();
        save(db);
    }),
    getLogs: (limit = 20) => {
        const logs = load().audit || [];
        return logs.slice(-limit);
    },
    clearLogs: () => withLock(() => {
        const db = load();
        db.audit = [];
        save(db);
    })
};

// --- INICIALIZAÇÃO DO SISTEMA DE CCs ---
// Garante que os produtos existam no banco e o estoque esteja sincronizado com o arquivo JSON
(() => {
    withLock(() => {
        const db = load();
        const ccs = manageCCs('get');
        const levels = [
            { id: 'cc_gold', name: 'CC Gold', price: 25.00, key: 'gold' },
            { id: 'cc_platinum', name: 'CC Platinum', price: 45.00, key: 'platinum' },
            { id: 'cc_infinity', name: 'CC Infinity', price: 75.00, key: 'infinity' }
        ];
        if (!db.store) db.store = [];
        levels.forEach(lvl => {
            let prod = db.store.find(p => p.id === lvl.id);
            if (!prod) {
                prod = { id: lvl.id, name: lvl.name, price: lvl.price, category: 'cards', stock: [] };
                db.store.push(prod);
            }
            // Atualiza visualmente o estoque baseado no arquivo real
            const realStock = ccs[lvl.key] || [];
            prod.stock = new Array(realStock.length).fill('ITEM_IN_FILE');
        });
        save(db);
    });
})();
