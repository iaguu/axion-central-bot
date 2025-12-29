import fs from 'fs';
import path from 'path';

const DB_FILE = path.resolve('axion_core.json');
const LOCK_FILE = path.resolve('axion_core.lock');

const sleepSync = (ms) => {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
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
    fs.renameSync(tmp, DB_FILE);
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

    toggleVip: (userId) => withLock(() => {
        const db = load();
        if (!db.users[userId]) db.users[userId] = { rep: 0, dailyCount: 0, isVip: false };
        db.users[userId].isVip = !db.users[userId].isVip;
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
        const limit = user.isVip ? 50 : 10;
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
