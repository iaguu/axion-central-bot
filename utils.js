import fetch from "node-fetch";
import { Database } from "./database.js";

export const requireEnv = (keys) => {
    const missing = keys.filter(k => !process.env[k]);
    if (missing.length) {
        console.error(`Missing env: ${missing.join(", ")}`);
        process.exit(1);
    }
};

export const fetchWithRetry = async (url, options = {}, { retries = 3, timeoutMs = 20000, onTimeout } = {}) => {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { ...options, signal: controller.signal });
            if (!res.ok) {
                const txt = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}${txt ? ` - ${txt}` : ''}`);
            }
            return res;
        } catch (e) {
            if (attempt === retries) {
                if (e.name === 'AbortError' || e.type === 'aborted' || e.message === 'The operation was aborted.') {
                    if (onTimeout) onTimeout(url);
                    try { Database.addLog(`fetch timeout: ${url}`); } catch (_) {}
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

export const escapeHtml = (unsafe) => {
    return String(unsafe || '')
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};